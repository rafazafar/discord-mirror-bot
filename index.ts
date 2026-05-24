import { Hono } from "hono";

/**
 * ====================================================================
 * Simplybook × Pay.jp 決済ゲートウェイ（セキュア版）
 * ====================================================================
 *
 * 【システム概要】
 * Simplybook（予約管理システム）と Pay.jp（決済代行）を安全に仲介するゲートウェイ。
 * 署名付き決済トークン（HMAC-SHA256）および有効期限検証を導入し、
 * 金額改ざんや不正アクセス（IDOR）を完全に防止したセキュアな設計となっています。
 *
 * 【処理フロー】
 * 1. 管理画面等から /create-pay-link をコール ──> 署名付きトークンを含む決済URLを生成
 * 2. ユーザーが決済URLにアクセス (GET /pay?token=...) ──> トークンの署名・期限を検証し、確認画面を表示
 * 3. 顧客がカード情報を入力し決済実行 (POST /charge) ──> D1での二重決済防止ロック、再度Simplybookでの金額検証、Pay.jp決済実行、Simplybook反映、ロック解除
 *
 * ※後方互換性のため、SimplybookからのダイレクトPOST (/pay) にも対応し、内部で自動的に署名付きトークンを生成します。
 */

// ====== 環境変数・バインディングの型定義 ======
type Bindings = {
  PAYJP_PUBLIC_KEY: string; // Pay.jp 公開鍵（クライアントCheckoutウィジェット用）
  PAYJP_SECRET_KEY: string; // Pay.jp 秘密鍵（バックエンド決済処理用）
  SIMPLYBOOK_API_KEY: string; // Simplybook APIキー（予約状況同期等に利用可能な将来用）
  SB_ADMIN_USER: string; // Simplybook 管理者API ユーザー名
  SB_ADMIN_PASS: string; // Simplybook 管理者API パスワード/APIキー
  PAYMENT_SIGNING_SECRET: string; // 決済トークンの改ざん防止署名用（HMAC-SHA256の共通鍵）
  DB: D1Database; // 二重決済防止および決済履歴管理用のCloudflare D1データベース
};

const app = new Hono<{ Bindings: Bindings }>();

// Simplybook 管理者認証トークンのキャッシュ用グローバル変数（エッジメモリ内）
let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

/**
 * ====================================================================
 * 署名付き決済トークン（Payment Token）のデータ構造
 * ====================================================================
 */
interface PaymentTokenPayload {
  invoice_id: string; // Simplybookの請求書ID
  client_id: number; // 顧客ID（Simplybookのclient_id）
  amount: number; // 決済金額（日本円、整数）
  exp: number; // トークン有効期限（Unixタイムスタンプ・秒単位）
  nonce: string; // リプレイ攻撃防止用のランダムな一意ID（UUID）
  kid?: string; // キー識別子（将来的な署名鍵ローテーション用）
}

/**
 * ====================================================================
 * ヘルパー関数: HMAC-SHA256 署名付きトークンの生成
 * ====================================================================
 * 指定されたペイロードをBase64Urlエンコードし、秘密鍵によるHMAC-SHA256署名を付与してトークン化します。
 * トークンのフォーマット: [Base64Url(Payload)].[Base64Url(Signature)]
 */
async function generatePaymentToken(
  payload: PaymentTokenPayload,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();

  // Web Crypto APIを使用してHMAC署名鍵をインポート
  const keyData = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // ペイロードをBase64Urlエンコード
  const payloadStr = JSON.stringify(payload);
  const payloadBase64Url = btoa(payloadStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  // 署名を生成
  const signature = await crypto.subtle.sign(
    "HMAC",
    keyData,
    encoder.encode(payloadBase64Url),
  );

  // 署名をBase64Urlエンコード
  const signatureBase64Url = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${payloadBase64Url}.${signatureBase64Url}`;
}

/**
 * ====================================================================
 * ヘルパー関数: HMAC-SHA256 署名付きトークンの検証
 * ====================================================================
 * トークンの署名が改ざんされていないか検証し、有効期限(exp)を確認します。
 * 検証に合格した場合はデコードされたペイロードを返し、不合格の場合は例外をスローします。
 */
async function verifyPaymentToken(
  token: string,
  secret: string,
): Promise<PaymentTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("トークン形式が無効です（フォーマット異常）");
  }

  const [payloadBase64Url, signatureBase64Url] = parts;

  const encoder = new TextEncoder();

  // Web Crypto APIを使用して検証用鍵をインポート
  const keyData = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // Base64Url形式の署名をバイト配列に戻す
  const expectedSignatureArray = new Uint8Array(
    atob(signatureBase64Url.replace(/-/g, "+").replace(/_/g, "/"))
      .split("")
      .map((c) => c.charCodeAt(0)),
  );

  // 署名の改ざん検証
  const isValid = await crypto.subtle.verify(
    "HMAC",
    keyData,
    expectedSignatureArray,
    encoder.encode(payloadBase64Url),
  );

  if (!isValid) {
    throw new Error("トークン署名が無効です（改ざんされた可能性があります）");
  }

  // ペイロードをデコード
  const payloadStr = atob(
    payloadBase64Url.replace(/-/g, "+").replace(/_/g, "/"),
  );
  const payload = JSON.parse(payloadStr) as PaymentTokenPayload;

  // 有効期限(exp)の検証
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > payload.exp) {
    throw new Error("トークンの有効期限が切れています");
  }

  return payload;
}

/**
 * ====================================================================
 * ヘルパー関数: SimplyBook 管理者認証トークンの取得（メモリキャッシュ対応）
 * ====================================================================
 * SimplyBook APIへのログイン処理。API制限(Too many attempts)を防ぐため、
 * 取得した認証トークンをWorkersのグローバルエッジメモリ上に30分間キャッシュします。
 */
async function getAdminToken(env: Bindings): Promise<string> {
  const now = Date.now();

  // キャッシュが有効な場合はキャッシュから返却
  if (cachedToken && now < tokenExpiresAt) {
    console.log("⚡️ キャッシュから管理者トークンを取得しました");
    return cachedToken;
  }

  console.log("🔐 SimplyBookの管理者APIに新規認証を試みます...");
  const authRes = await fetch("https://user-api-v2.simplybook.me/admin/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company: "uranaiyakata", // SimplyBookの会社ID
      login: env.SB_ADMIN_USER,
      password: env.SB_ADMIN_PASS,
    }),
  });

  const authData = (await authRes.json()) as any;

  // 認証エラーハンドリング
  if (authData.error || authData.code === 403 || !authData.token) {
    const errorMsg =
      authData.error?.message || authData.message || "管理者トークン取得失敗";

    // レートリミット（403等）への対応
    if (errorMsg.includes("Too many attempts") || authRes.status === 403) {
      throw new Error(
        "ただいまシステムへのアクセスが集中しております。恐れ入りますが、少し時間をおいてから再度アクセスしてください。",
      );
    }

    throw new Error(`認証エラー: ${errorMsg}`);
  }

  // 認証成功トークンを30分間キャッシュ
  cachedToken = authData.token;
  tokenExpiresAt = now + 30 * 60 * 1000;

  console.log("✅ SimplyBook 管理者認証成功: 新規トークン取得＆キャッシュ完了");
  return cachedToken;
}

/**
 * ====================================================================
 * ヘルパー関数: HTMLエスケープ処理
 * ====================================================================
 * XSS（クロスサイトスクリプティング）を防止するために、特殊文字を安全に変換します。
 */
function escapeHtml(str: string): string {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * ====================================================================
 * ヘルパー関数: 共通HTMLレイアウトの描画
 * ====================================================================
 * 各エンドポイントでクライアント（購入者）向けに表示するHTMLの共通枠組みを構築します。
 * モニタサイズを問わず美しく、見やすいモダンなレスポンシブデザイン（ピンク基調）を採用しています。
 */
function renderPage(title: string, content: string): string {
  const primaryColor = "#d68e89"; // テーマカラー（占い館のピンク系トーン）
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <!-- 美しい日本語と英語のフォントファミリーのインポート -->
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Noto+Sans+JP:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: ${primaryColor};
      --bg-color: #f8f9fa;
      --card-bg: #ffffff;
      --text-main: #333333;
      --text-muted: #6c757d;
      --border-color: #e9ecef;
      --danger: #dc3545;
      --success: #28a745;
    }
    body {
      font-family: 'Inter', 'Noto Sans JP', sans-serif;
      background-color: var(--bg-color);
      color: var(--text-main);
      margin: 0;
      padding: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      /* 背景に上品な斜めグラデーションを適用 */
      background-image: linear-gradient(135deg, #fdfbfb 0%, #ebedee 100%);
    }
    .container {
      background: var(--card-bg);
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.05);
      padding: 40px 30px;
      width: 100%;
      max-width: 480px;
      margin: 20px;
      text-align: center;
      border-top: 5px solid var(--primary); /* カード上部にメインカラーのアクセント線 */
      box-sizing: border-box;
    }
    h1, h2, h3 {
      margin-top: 0;
      color: var(--text-main);
    }
    .title {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .price {
      font-size: 2rem;
      font-weight: 600;
      color: var(--primary);
      margin: 20px 0;
    }
    .text-muted {
      color: var(--text-muted);
      font-size: 0.9rem;
      line-height: 1.5;
    }
    .error-text {
      color: var(--danger);
      font-weight: 600;
      margin-bottom: 10px;
    }
    .success-text {
      color: var(--success);
      font-weight: 600;
      font-size: 1.5rem;
      margin-bottom: 15px;
    }
    .invoice-card {
      background: #fafafa;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 15px;
      margin-bottom: 15px;
      text-align: left;
    }
    .invoice-label {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 5px;
    }
    .btn-return {
      display: inline-block;
      margin-top: 25px;
      padding: 12px 24px;
      background: var(--text-muted);
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      transition: background 0.2s;
    }
    .btn-return:hover {
      background: #5a6268;
    }
    .pay-btn-container {
      margin-top: 30px;
    }
  </style>
</head>
<body>
  <div class="container">
    ${content}
  </div>
</body>
</html>`;
}

/**
 * ====================================================================
 * エンドポイント1: POST /create-pay-link (管理者・システム連携用)
 * ====================================================================
 * 機能: 署名付き決済トークン（HMAC-SHA256）を新規に生成して返却します。
 * 主に管理画面や別システムから、セキュアな決済リンクを事前に作成する目的で使用されます。
 *
 * 認可:
 * - Authorization ヘッダに "Bearer <PAYJP_SECRET_KEY>" を要求します。
 *
 * リクエストボディ (JSON):
 * {
 *   "invoice_id": "123",           // Simplybookの請求書ID
 *   "client_id": 456,              // Simplybookの顧客ID
 *   "amount": 5000,                // 決済額 (日本円)
 *   "expires_in_minutes": 10       // 有効期限（分単位、デフォルト10分）
 * }
 *
 * レスポンス (JSON):
 * {
 *   "success": true,
 *   "token": "eyJ....",            // 生成された署名付きトークン
 *   "pay_url": "https://<Host>/pay?token=...", // ユーザー送信用URL
 *   "expires_at": "2026-05-20T..." // トークンのISO有効期限時刻
 * }
 */
app.post("/create-pay-link", async (c) => {
  try {
    // 簡易的な認証チェック (Bearerトークンとして PAYJP_SECRET_KEY を要求)
    const authHeader = c.req.header("Authorization");
    if (!authHeader || authHeader !== `Bearer ${c.env.PAYJP_SECRET_KEY}`) {
      return c.json(
        { error: "認可エラー: 無効または不足しているトークンです" },
        { status: 401 },
      );
    }

    const body = await c.req.json<{
      invoice_id: string;
      client_id: number;
      amount: number;
      expires_in_minutes?: number;
    }>();

    const { invoice_id, client_id, amount, expires_in_minutes = 10 } = body;

    // 必須入力項目の検証
    if (!invoice_id || !client_id || !amount) {
      return c.json(
        {
          error:
            "必須フィールドが不足しています: invoice_id, client_id, amount",
        },
        { status: 400 },
      );
    }

    // トークンの有効期限 (Unixタイムスタンプ) を計算
    const now = Math.floor(Date.now() / 1000);
    const expiresInSec = expires_in_minutes * 60;
    const exp = now + expiresInSec;

    // トークンのペイロードを組み立て
    const payload: PaymentTokenPayload = {
      invoice_id,
      client_id,
      amount: Math.round(Number(amount)),
      exp,
      nonce: crypto.randomUUID(), // リプレイ攻撃（同一決済リンクの再送信）防止用UUID
      kid: "v1", // キー識別子（将来の鍵ローテーション対応）
    };

    // ペイロードと署名用秘密鍵から署名付きトークンを生成
    const token = await generatePaymentToken(
      payload,
      c.env.PAYMENT_SIGNING_SECRET,
    );
    const payUrl = `https://${c.req.header("Host")}/pay?token=${encodeURIComponent(token)}`;

    console.log(
      `🔐 Pay link generated: invoice_id=${invoice_id}, exp=${exp}, nonce=${payload.nonce}`,
    );

    return c.json({
      success: true,
      token,
      pay_url: payUrl,
      expires_at: new Date(exp * 1000).toISOString(),
    });
  } catch (e: any) {
    console.error("Error in /create-pay-link:", e.message);
    return c.json(
      { error: `トークン生成エラー: ${e.message}` },
      { status: 500 },
    );
  }
});

/**
 * ====================================================================
 * エンドポイント2: GET/POST /pay (決済手続き・カード入力画面)
 * ====================================================================
 * 機能: 決済用パラメータまたはトークンを受け取り、署名と有効期限を検証した上で、
 *       PAY.JPのCheckoutウィジェット（クレジットカード入力用UI）を表示します。
 *
 * 呼び出し形式:
 * 1. 【セキュア版推奨】GET /pay?token=...
 *    ──> 事前生成された署名付きトークンをクエリパラメータから検証して画面を表示。
 *
 * 2. 【後方互換用】POST /pay
 *    リクエストボディ: { invoice_id (または order_id), client_id (または customer_id), amount }
 *    ──> バックエンド側でSimplyBookの「未決済（new/pending）」の請求書を自動検索・整合性確認し、
 *        サーバー内部で安全に署名付きトークンを自動生成して画面を表示。
 */
app.all("/pay", async (c) => {
  let tokenPayload: PaymentTokenPayload | null = null;
  let sbToken: string;

  try {
    let token: string | null = null;

    // --- 1. GET リクエスト処理 (クエリパラメータから token 抽出) ---
    if (c.req.method === "GET") {
      token = c.req.query("token");
    }
    // --- 2. POST リクエスト処理 (Simplybook等からのダイレクトPOSTを安全にハンドリング) ---
    else if (c.req.method === "POST") {
      let invoice_id: string | undefined;
      let client_id: string | undefined;
      let amount: string | undefined;

      const contentType = c.req.header("content-type") || "";
      console.log(`📥 POST /pay received - Content-Type: ${contentType}`);

      // Request Body のパース (JSON または Formデータの自動切り替え)
      if (contentType.includes("application/json")) {
        try {
          const jsonBody = await c.req.json();
          invoice_id =
            jsonBody.invoice_id?.toString() ||
            jsonBody.order_id?.toString() ||
            undefined;
          client_id =
            jsonBody.client_id?.toString() ||
            jsonBody.customer_id?.toString() ||
            undefined;
          amount = jsonBody.amount?.toString();
          console.log(
            `✅ JSON parsed: invoice_id=${invoice_id}, client_id=${client_id}, amount=${amount}`,
          );
        } catch (e) {
          console.log(`❌ JSON parse failed: ${e}`);
        }
      } else {
        // urlencoded または multipart/form-data は parseBody() にて統合解析
        try {
          const formBody = await c.req.parseBody();
          invoice_id =
            formBody.invoice_id?.toString() ||
            formBody.order_id?.toString() ||
            undefined;
          client_id =
            formBody.client_id?.toString() ||
            formBody.customer_id?.toString() ||
            undefined;
          amount = formBody.amount?.toString();
          console.log(
            `✅ Form data parsed: invoice_id=${invoice_id}, client_id=${client_id}, amount=${amount}`,
          );
        } catch (e) {
          console.log(`❌ Form data parse failed: ${e}`);
        }
      }

      // クエリパラメータからのフォールバック抽出
      if (!invoice_id || !client_id || !amount) {
        invoice_id =
          invoice_id ||
          c.req.query("invoice_id") ||
          c.req.query("order_id") ||
          undefined;
        client_id =
          client_id ||
          c.req.query("client_id") ||
          c.req.query("customer_id") ||
          undefined;
        amount = amount || c.req.query("amount") || undefined;
        if (invoice_id || client_id || amount) {
          console.log(
            `✅ Query params parsed: invoice_id=${invoice_id}, client_id=${client_id}, amount=${amount}`,
          );
        }
      }

      // 必須パラメータが全く存在しない場合はエラーHTMLを表示
      if (!invoice_id || !client_id || !amount) {
        console.log(
          `⚠️ Missing parameters: invoice_id=${invoice_id}, client_id=${client_id}, amount=${amount}`,
        );
        const debugInfo = `
<div style="background: #f5f5f5; padding: 15px; margin-top: 15px; border-left: 4px solid #d68e89; font-family: monospace; font-size: 0.85em; word-break: break-all;">
  <strong>デバッグ情報:</strong><br>
  Content-Type: ${contentType || "(なし)"}<br>
  対応形式: JSON / form-data / x-www-form-urlencoded / クエリパラメータ
</div>
        `;
        return c.html(
          renderPage(
            "エラー",
            '<h2 class="error-text">必須パラメータが不足しています</h2>' +
              '<p class="text-muted">invoice_id, client_id, amount が必要です。</p>' +
              '<p class="text-muted" style="font-size: 0.85em; margin-top: 15px;">対応形式: JSON / form-data / クエリパラメータ</p>' +
              debugInfo,
          ),
        );
      }

      // **セキュリティ強化**: トークン自動生成前に Simplybook にて実際の請求書状態を検証する
      sbToken = await getAdminToken(c.env);

      let foundInvoice: any = null;
      const searchAmount = Math.round(Number(amount));
      const statuses = ["new", "pending"];

      console.log(
        `🔍 Searching invoice before token generation: customer_id=${client_id}, amount=${searchAmount}`,
      );

      // Simplybookから "new", "pending" 状態の請求書を取得し、金額が一致するものを探索
      for (const status of statuses) {
        const searchUrl =
          `https://user-api-v2.simplybook.me/admin/invoices?filter[client_id]=` +
          client_id +
          `&filter[status]=` +
          status;

        const searchRes = await fetch(searchUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "X-Company-Login": "uranaiyakata",
            "X-Token": sbToken,
          },
        });

        const searchData = (await searchRes.json()) as any;
        const items = Array.isArray(searchData)
          ? searchData
          : searchData.data || searchData.invoices || [];

        if (Array.isArray(items)) {
          for (const item of items) {
            const itemAmount = Math.round(
              Number(item.amount ?? item.total ?? item.price ?? 0),
            );
            if (itemAmount === searchAmount) {
              foundInvoice = item;
              console.log(`✅ Found matching invoice for token: ${item.id}`);
              break;
            }
          }
        }

        if (foundInvoice) break;
      }

      // 金額やステータスが合致する請求書が存在しない場合は拒否
      if (!foundInvoice) {
        return c.html(
          renderPage(
            "請求書エラー",
            '<h2 class="error-text">請求書が見つかりません</h2>' +
              '<p class="text-muted">指定の顧客ID・金額に一致する未決済の予約が見つかりません。</p>',
          ),
        );
      }

      // サーバーサイドにて、信頼された署名付きトークンを10分間の有効期限で自動生成（改ざんをブロック）
      const payload: PaymentTokenPayload = {
        invoice_id: foundInvoice.id.toString(),
        client_id: Number(client_id),
        amount: searchAmount,
        exp: Math.floor(Date.now() / 1000) + 10 * 60, // 10分有効
        nonce: crypto.randomUUID(),
        kid: "v1",
      };

      token = await generatePaymentToken(payload, c.env.PAYMENT_SIGNING_SECRET);
      console.log(
        `🔐 Auto-generated token from POST: invoice_id=${foundInvoice.id}, nonce=${payload.nonce}`,
      );
    }

    // トークンが抽出できなかった場合のエラー処理
    if (!token) {
      return c.html(
        renderPage(
          "エラー",
          '<h2 class="error-text">トークンが指定されていません</h2>' +
            '<p class="text-muted">有効なトークンを含む URL にアクセスしてください。</p>',
        ),
      );
    }

    // --- 3. 署名付き決済トークンの本格的な検証 ---
    tokenPayload = await verifyPaymentToken(
      token,
      c.env.PAYMENT_SIGNING_SECRET,
    );

    console.log(
      `✅ Token verified: invoice_id=${tokenPayload.invoice_id}, client_id=${tokenPayload.client_id}, exp=${tokenPayload.exp}`,
    );

    // Simplybook管理者認証トークンの取得
    sbToken = await getAdminToken(c.env);

    // **二重チェック**: client_id と amount を条件に Simplybook から未決済の請求書を再度リアルタイム検索
    console.log(
      `🔍 Searching invoices for customer_id=${tokenPayload.client_id}, amount=${tokenPayload.amount}`,
    );

    let invoiceData: any = null;
    const statuses = ["new", "pending"];

    for (const status of statuses) {
      const searchUrl =
        `https://user-api-v2.simplybook.me/admin/invoices?filter[client_id]=` +
        tokenPayload.client_id +
        `&filter[status]=` +
        status;

      console.log(`🔗 Searching: ${searchUrl}`);

      const searchRes = await fetch(searchUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Company-Login": "uranaiyakata",
          "X-Token": sbToken,
        },
      });

      const searchData = (await searchRes.json()) as any;
      console.log(
        `📋 Search result for status=${status}: ${JSON.stringify(searchData).substring(0, 300)}`,
      );

      // APIからのレスポンス形式が配列か、それともオブジェクトの特定フィールドか判定
      const items = Array.isArray(searchData)
        ? searchData
        : searchData.data || searchData.invoices || [];

      // 金額がトークンの指定額と完全に一致する請求書を特定
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemAmount = Math.round(
            Number(item.amount ?? item.total ?? item.price ?? 0),
          );
          if (itemAmount === tokenPayload.amount) {
            invoiceData = item;
            console.log(`✅ Found matching invoice: ${item.id}`);
            break;
          }
        }
      }

      if (invoiceData) break;
    }

    // 金額に合致する請求書が見つからない場合は、エラー画面を表示（トラブルシューティング用のデバッグ付き）
    if (!invoiceData) {
      const debugInvoiceInfo = `
<div style="background: #f5f5f5; padding: 15px; margin-top: 15px; border-left: 4px solid #d68e89; font-family: monospace; font-size: 0.85em; word-break: break-all;">
  <strong>デバッグ情報（請求書検索）:</strong><br>
  <strong>検索パラメータ:</strong><br>
  <strong>使用された customer_id:</strong> <code>${tokenPayload.client_id}</code><br>
  <strong>使用された amount:</strong> ¥${tokenPayload.amount.toLocaleString()}<br><br>
  
  <strong>検索方法:</strong><br>
  /admin/invoices?filter[client_id]={customer_id}&filter[status]=new|pending<br><br>
  
  <strong>結果:</strong> 該当する請求書が見つかりませんでした。<br>
  Simplybook の管理画面で、この顧客のステータス = 「new」または「pending」の請求書が存在するか確認してください。
</div>
      `;
      return c.html(
        renderPage(
          "請求書エラー",
          '<h2 class="error-text">請求書が見つかりません</h2>' +
            '<p class="text-muted">指定の金額に一致する未決済の予約が見つかりません。</p>' +
            debugInvoiceInfo,
        ),
      );
    }

    // --- 4. 決済確認画面の描画処理 ---
    const publicKey = c.env.PAYJP_PUBLIC_KEY;

    // 請求書品目の説明（Description）を安全に抽出してHTMLエスケープ
    const desc =
      invoiceData.lines && invoiceData.lines[0]
        ? invoiceData.lines[0].description_string || invoiceData.lines[0].name
        : "決済";
    const safeDesc = escapeHtml(desc);

    return c.html(
      renderPage(
        "お支払い",
        '<h2 class="title">決済を完了してください</h2>' +
          '<div class="price">&yen;' +
          tokenPayload.amount.toLocaleString() +
          "</div>" +
          '<div class="invoice-card">' +
          '<div class="invoice-label">対象の予約</div>' +
          '<p style="margin: 0; font-size: 0.9em; font-weight: 600;">' +
          safeDesc +
          "</p>" +
          "</div>" +
          // クレジットカード情報入力用フォーム
          '<form action="/charge" method="post" id="payment-form">' +
          '<input type="hidden" name="payment_token" value="' +
          escapeHtml(token) +
          '">' +
          '<div class="pay-btn-container" id="pay-btn-wrapper">' +
          // PAY.JP Checkoutスクリプト（3Dセキュアv2完全対応）
          '<script src="https://checkout.pay.jp/" class="payjp-button" data-key="' +
          publicKey +
          '" data-text="カードで支払う" data-on-created="onPayjpTokenCreated" data-payjp-three-d-secure="true" data-payjp-three-d-secure-workflow="iframe"></script>' +
          "</div>" +
          "</form>" +
          // クライアント側スクリプト：多重送信防止・ボタンの二重クリック防止制御
          "<script>" +
          "var wrapper = document.getElementById('pay-btn-wrapper');" +
          "wrapper.addEventListener('click', function(e) {" +
          "  if (wrapper.getAttribute('data-locked') === 'true') {" +
          "    e.stopPropagation();" +
          "    e.preventDefault();" +
          "    return false;" +
          "  }" +
          "  wrapper.setAttribute('data-locked', 'true');" +
          "  wrapper.style.opacity = '0.7';" +
          "  setTimeout(function() {" +
          "    if (!window.isSubmitting) {" +
          "      wrapper.setAttribute('data-locked', 'false');" +
          "      wrapper.style.opacity = '1';" +
          "    }" +
          "  }, 2500);" +
          "}, true);" +
          // PAY.JPのカードトークン生成成功時に呼び出されるコールバック
          "function onPayjpTokenCreated(response) {" +
          "  if (window.isSubmitting) return;" +
          "  window.isSubmitting = true;" +
          "  wrapper.setAttribute('data-locked', 'true');" +
          "  wrapper.style.opacity = '0.5';" +
          "  wrapper.style.pointerEvents = 'none';" +
          "  var form = document.getElementById('payment-form');" +
          "  var hiddenInput = document.createElement('input');" +
          "  hiddenInput.type = 'hidden';" +
          "  hiddenInput.name = 'payjp-token';" +
          "  hiddenInput.value = response.id;" +
          "  form.appendChild(hiddenInput);" +
          "  form.submit();" +
          "}" +
          "</script>",
      ),
    );
  } catch (e: any) {
    console.error("Error in /pay:", e.message);
    let errorMsg = "トークンが無効です";
    if (e.message.includes("有効期限")) {
      errorMsg =
        "このリンクの有効期限が切れています。再度決済リンクを生成してください。";
    } else if (e.message.includes("署名")) {
      errorMsg =
        "トークンが改ざんされています。セキュリティ上、処理を中止します。";
    }

    return c.html(
      renderPage(
        "エラー",
        '<h2 class="error-text">決済エラー</h2>' +
          '<p class="text-muted">' +
          errorMsg +
          '</p><p class="text-muted" style="font-size: 0.8em; margin-top: 15px;">エラー詳細: ' +
          e.message +
          "</p>",
      ),
    );
  }
});

/**
 * ====================================
 * エンドポイント3: /charge
 * 機能: トークン検証 → 請求書確認 → 決済 → 反映
 * ====================================
 */
/**
 * ====================================================================
 * エンドポイント3: POST /charge (決済実行処理)
 * ====================================================================
 * 機能: PAY.JPのカードトークンおよび署名付き決済トークンを受け取り、
 *       以下の一連のトランザクション処理をアトミックかつセキュアに実行します。
 *
 * 処理内容:
 * 1. 署名付きトークンの署名・有効期限検証（改ざんチェック）
 * 2. Simplybookでの最新の請求書情報再取得（セキュリティ検証用のID確定）
 * 3. D1 データベースを用いた二重決済防止の「排他ロック(charging)」取得
 * 4. 不正な操作（顧客の不一致、支払い済み請求書）のガード検証
 * 5. 改ざん防止：Simplybook上の正規請求額を決済金額として動的に採用
 * 6. PAY.JP 決済APIを実行（クレジットカード引き落とし）
 * 7. Simplybook 支払い反映APIを実行（ステータスを支払い済みに更新）
 * 8. D1 のロックステータスを「決済完了(paid)」に更新
 * 9. D1 の payment_logs テーブルに決済成功の証跡を書き込み
 * 10. 全工程の完了後、ユーザーを予約システムへリダイレクト
 *
 * トランザクション不整合対策（自動ロールバック機構）:
 * - もし「6. PAY.JPでの引き落とし」が成功した後に、「7. Simplybookでの支払い反映」で失敗した場合、
 *   ユーザーに二重請求またはお金だけ引かれるのを防ぐため、**自動的にPAY.JPの返金(refund)APIを実行し決済を取り消します。**
 */
app.post("/charge", async (c) => {
  // 決済完了・エラー発生時の遷移先URL (Simplybookの顧客予約一覧画面)
  const returnUrl =
    "https://uranaiyakata.simplybook.asia/v2/#client/bookings/type/upcoming";

  let payjpChargeId: string | null = null; // PAY.JP決済ID (ロールバック時の返金対象特定用)
  let resolvedInvoiceId: string | null = null; // Simplybookの確定請求書ID

  try {
    const body = await c.req.parseBody();
    const paymentToken = body["payment_token"] as string; // 署名付き決済トークン
    const payjpToken = body["payjp-token"] as string; // PAY.JPのカードトークン

    if (!paymentToken || !payjpToken) {
      throw new Error("必要なパラメータが不足しています（カードトークン等）");
    }

    // --- 1. 署名付きトークンの厳密な検証 ---
    const tokenPayload = await verifyPaymentToken(
      paymentToken,
      c.env.PAYMENT_SIGNING_SECRET,
    );

    console.log(
      `🔍 /charge received: invoice_id=${tokenPayload.invoice_id}, client_id=${tokenPayload.client_id}, amount=${tokenPayload.amount}`,
    );

    // Simplybook管理者認証トークン取得
    const sbToken = await getAdminToken(c.env);

    // --- 2. 請求書のリアルタイム検索 ── ロック対象を特定するため決済実行前にIDを確定 ---
    console.log(
      `🔍 Searching invoice for customer_id=${tokenPayload.client_id}, amount=${tokenPayload.amount}`,
    );

    let resolvedInvoice: any = null;
    const statuses = ["new", "pending"];

    for (const status of statuses) {
      const searchUrl =
        `https://user-api-v2.simplybook.me/admin/invoices?filter[client_id]=` +
        tokenPayload.client_id +
        `&filter[status]=` +
        status;

      const searchRes = await fetch(searchUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Company-Login": "uranaiyakata",
          "X-Token": sbToken,
        },
      });

      const searchData = (await searchRes.json()) as any;
      const items = Array.isArray(searchData)
        ? searchData
        : searchData.data || searchData.invoices || [];

      // 金額の一致確認
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemAmount = Math.round(
            Number(item.amount ?? item.total ?? item.price ?? 0),
          );
          if (itemAmount === tokenPayload.amount) {
            resolvedInvoice = item;
            resolvedInvoiceId = item.id;
            console.log(`✅ Found matching invoice for charge: ${item.id}`);
            break;
          }
        }
      }

      if (resolvedInvoice) break;
    }

    // 請求書が見つからない場合はエラー
    if (!resolvedInvoice) {
      throw new Error(
        `請求書が見つかりません (customer_id=${tokenPayload.client_id}, amount=${tokenPayload.amount})`,
      );
    }

    // --- 3. 二重決済防止（D1 排他ロック機構） ---
    // 確定した請求書IDを用いて、テーブル `invoice_locks` にロックを書き込みます。
    try {
      await c.env.DB.prepare(
        "INSERT INTO invoice_locks (invoice_id, status) VALUES (?, 'charging')",
      )
        .bind(resolvedInvoiceId)
        .run();
    } catch (dbErr: any) {
      // INSERT時に一意制約エラー等が発生した場合 ── 既にロックレコードが存在することを示します
      const lockCheck = await c.env.DB.prepare(
        "SELECT status FROM invoice_locks WHERE invoice_id = ?",
      )
        .bind(resolvedInvoiceId)
        .first<{ status: string }>();

      if (lockCheck) {
        // すでに処理中 (charging) または決済済み (paid) の場合は競合として例外をスロー
        if (lockCheck.status === "charging" || lockCheck.status === "paid") {
          throw new Error("この予約は現在決済処理中、または既に決済済みです");
        }

        // 過去に失敗したロック (failed) の場合は、アトミックに status = 'charging' に更新して処理を続行
        const updateRes = await c.env.DB.prepare(
          "UPDATE invoice_locks SET status = 'charging' WHERE invoice_id = ? AND status = ?",
        )
          .bind(resolvedInvoiceId, lockCheck.status)
          .run();

        // 他の同一リクエストに先を越された場合は即座に遮断
        if (updateRes.meta.changes === 0) {
          throw new Error("他のプロセスが決済を処理中です");
        }
      }
    }

    // --- 4. セキュリティ追加検証 ---
    // 請求書に紐づく顧客IDとトークン内の顧客IDが一致することを確認（他人の予約の不正決済防止）
    if (Number(resolvedInvoice.client_id) !== tokenPayload.client_id) {
      throw new Error("不正なリクエスト: 顧客情報が一致しません");
    }

    // 請求書ステータスの確認
    if (
      resolvedInvoice.status !== "new" &&
      resolvedInvoice.status !== "pending"
    ) {
      throw new Error("この請求書は決済可能なステータスではありません");
    }

    // --- 5. 改ざん防止：決済金額の確定 ---
    // トークン内の金額に依らず、SimplyBookの元の請求金額を正としてPAY.JPへ送ります
    const actualInvoiceAmount = Math.round(
      Number(
        resolvedInvoice.amount ??
          resolvedInvoice.total ??
          resolvedInvoice.price ??
          0,
      ),
    );

    if (actualInvoiceAmount !== tokenPayload.amount) {
      console.warn(
        `⚠️  Amount mismatch detected: token=${tokenPayload.amount}, invoice=${actualInvoiceAmount}. Using invoice amount.`,
      );
    }

    // --- 6. PAY.JP 決済APIの実行 ---
    console.log(`💸 Executing Pay.JP charge: ${actualInvoiceAmount} JPY...`);
    const basicAuth = btoa(c.env.PAYJP_SECRET_KEY + ":");

    const payRes = await fetch("https://api.pay.jp/v1/charges", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        amount: actualInvoiceAmount.toString(),
        currency: "jpy",
        card: payjpToken,
        description: `Invoice ID: ${resolvedInvoiceId}, Client ID: ${tokenPayload.client_id}`,
      }),
    });

    const payResult = (await payRes.json()) as any;
    console.log(
      `📮 Pay.JP Response: ${JSON.stringify(payResult).substring(0, 300)}`,
    );

    if (payResult.error) {
      const errorMsg = payResult.error.message || payResult.error;
      console.error(`❌ Pay.JP Error: ${errorMsg}`);
      throw new Error(`Pay.JP決済エラー: ${errorMsg}`);
    }

    payjpChargeId = payResult.id;
    console.log(
      `✅ Pay.JP Charge succeeded: ${payjpChargeId}, Amount: ${payResult.amount}`,
    );

    // --- 7. Simplybook への支払い反映処理 ---
    console.log(`🔄 Updating Simplybook invoice ${resolvedInvoiceId}...`);
    const paymentRes = await fetch(
      `https://user-api-v2.simplybook.me/admin/invoices/${resolvedInvoiceId}/accept-payment`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Company-Login": "uranaiyakata",
          "X-Token": sbToken,
        },
        body: JSON.stringify({
          payment_processor: "PAY.JP",
        }),
      },
    );

    const paymentResult = (await paymentRes.json()) as any;
    if (paymentResult.error) {
      throw new Error(
        `SimplyBook支払い反映失敗: ${paymentResult.error?.message || "不明なエラー"}`,
      );
    }

    console.log(
      `✅ Payment completed: Invoice ${resolvedInvoiceId}, Charge ${payjpChargeId}`,
    );

    // --- 8. D1 ロックを 'paid' (完了) 状態に更新 ---
    await c.env.DB.prepare(
      "UPDATE invoice_locks SET status = 'paid' WHERE invoice_id = ?",
    )
      .bind(resolvedInvoiceId)
      .run();

    // --- 9. 決済成功ログの記録 (payment_logs) ---
    // ※スキーマ変更に対応し customer_id カラムに確実にバインドします
    await c.env.DB.prepare(
      "INSERT INTO payment_logs (invoice_id, customer_id, amount, payjp_charge_id, status) VALUES (?, ?, ?, ?, 'success')",
    )
      .bind(
        resolvedInvoiceId,
        tokenPayload.client_id.toString(),
        actualInvoiceAmount,
        payjpChargeId,
      )
      .run()
      .catch((err: any) =>
        console.error("Log error (payment_logs insertion failed):", err),
      );
  } catch (e: any) {
    console.error("Error in /charge:", e.message);
    const errorDetail = (e.message || String(e)).replace(/\n/g, "<br>");
    let refundMessage = "";

    // --- 10. 自動ロールバック処理 (返金) ---
    // PAY.JP決済は成功したのにSimplybookへの反映等で失敗した場合、全額即時自動返金を試みます
    if (payjpChargeId) {
      console.log(`⚠️  Rolling back Pay.JP charge ${payjpChargeId}...`);
      try {
        const refundRes = await fetch(
          `https://api.pay.jp/v1/charges/${payjpChargeId}/refund`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${btoa(c.env.PAYJP_SECRET_KEY + ":")}`,
              "Content-Type": "application/json",
            },
          },
        );
        const refundData = (await refundRes.json()) as any;
        if (refundData.error) {
          throw new Error(refundData.error.message);
        }
        console.log("✅ Pay.JP charge refunded successfully");
        refundMessage =
          '<p style="color: #28a745; font-weight: bold; margin-top: 15px;">※決済は自動的に取り消されました（返金済み）。</p>';

        // 返金成功ログを記録
        if (resolvedInvoiceId) {
          await c.env.DB.prepare(
            "INSERT INTO payment_logs (invoice_id, customer_id, amount, payjp_charge_id, status, error_message) VALUES (?, ?, ?, ?, 'refunded', ?)",
          )
            .bind(
              resolvedInvoiceId,
              tokenPayload ? tokenPayload.client_id.toString() : "",
              tokenPayload ? tokenPayload.amount : 0,
              payjpChargeId,
              `Rollback: ${e.message}`,
            )
            .run()
            .catch((err: any) => console.error("Refund Log error:", err));
        }
      } catch (refundErr: any) {
        console.error("🚨 Critical: Refund failed!", refundErr);
        refundMessage =
          '<p style="color: #dc3545; font-weight: bold; margin-top: 15px;">※【重要】決済の取り消しに失敗しました。管理者へお問い合わせください。</p>';

        // 返金失敗ログを記録
        if (resolvedInvoiceId) {
          await c.env.DB.prepare(
            "INSERT INTO payment_logs (invoice_id, customer_id, amount, payjp_charge_id, status, error_message) VALUES (?, ?, ?, ?, 'refund_failed', ?)",
          )
            .bind(
              resolvedInvoiceId,
              tokenPayload ? tokenPayload.client_id.toString() : "",
              tokenPayload ? tokenPayload.amount : 0,
              payjpChargeId,
              `Refund Failed: ${refundErr.message}. Original error: ${e.message}`,
            )
            .run()
            .catch((err: any) =>
              console.error("Refund Failed Log error:", err),
            );
        }
      }
    } else {
      // そもそも決済が実行される前にエラーが発生した場合の失敗ログ記録
      if (resolvedInvoiceId) {
        await c.env.DB.prepare(
          "INSERT INTO payment_logs (invoice_id, customer_id, amount, status, error_message) VALUES (?, ?, ?, 'failed', ?)",
        )
          .bind(
            resolvedInvoiceId,
            tokenPayload ? tokenPayload.client_id.toString() : "",
            tokenPayload ? tokenPayload.amount : 0,
            `Error: ${e.message}`,
          )
          .run()
          .catch((err: any) => console.error("Failure Log error:", err));
      }
    }

    // エラーHTML画面を表示して返却
    return c.html(
      renderPage(
        "決済エラー",
        '<h2 class="error-text">決済エラー</h2>' +
          '<p class="text-muted">エラーが発生しました。<br>エラー詳細: ' +
          errorDetail +
          "</p>" +
          refundMessage +
          '<a href="' +
          returnUrl +
          '" class="btn-return">予約ページに戻る</a>',
      ),
    );
  } finally {
    // --- 11. D1 ロック解除 (失敗状態 failed へ) ---
    // 決済が完了しなかった場合は、再度購入者が決済できるようにロックを解除（failedに戻す）
    // （※すでに 'paid' に更新されている場合は、WHERE句 status = 'charging' で条件一致しないため安全）
    if (resolvedInvoiceId) {
      await c.env.DB.prepare(
        "UPDATE invoice_locks SET status = 'failed' WHERE invoice_id = ? AND status = 'charging'",
      )
        .bind(resolvedInvoiceId)
        .run()
        .catch((err: any) => console.error("DB Unlock Error:", err));
    }
  }

  // --- 12. 決済成功HTML画面を表示して返却 ---
  return c.html(
    renderPage(
      "お支払いが完了しました",
      '<h2 style="color: #28a745; font-weight: 600; font-size: 1.5rem; margin-bottom: 15px;">お支払いが完了しました</h2>' +
        '<p class="text-muted">決済が正常に処理されました。</p>' +
        '<p class="text-muted" style="margin-top: 20px; font-size: 0.85em;">3秒後に元のサービスへ戻ります...</p>' +
        '<p style="font-size: 0.85em; margin-top: 10px;">自動的に切り替わらない場合は <a href="' +
        returnUrl +
        '" style="color: var(--primary);">こちら</a> をクリックしてください。</p>' +
        "<script>" +
        "setTimeout(function() {" +
        'window.location.href = "' +
        returnUrl +
        '";' +
        "}, 3000);" +
        "</script>",
    ),
  );
});

export default app;

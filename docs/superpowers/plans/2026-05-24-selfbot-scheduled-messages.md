# Selfbot Scheduled Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only API and SQLite scheduler that sends one-time Discord messages through the existing selfbot client.

**Architecture:** Keep Discord client, API, DB, and scheduler in one Node process, but put new code in focused CommonJS modules under `src/`. `mirror.js` starts DB/API/scheduler after Discord `ready`; scheduler resolves aliases and calls `channel.send(content)`.

**Tech Stack:** Node.js CommonJS, Express, `better-sqlite3`, built-in `node:test`, SQLite, `discord.js-selfbot-v13`.

---

## File Structure

- Modify: `package.json` for dependencies and `npm test`.
- Modify: `package-lock.json` from `npm install`.
- Modify: `config.example.js` for local API config defaults.
- Modify: `mirror.js` to start scheduler services after Discord login.
- Create: `src/scheduler-db.js` for SQLite schema and DB operations.
- Create: `src/local-api.js` for Express app/routes/validation.
- Create: `src/scheduler.js` for due-message send loop.
- Create: `tests/scheduler-db.test.js` for DB persistence behavior.
- Create: `tests/local-api.test.js` for local API behavior.
- Create: `tests/scheduler.test.js` for send success/failure behavior.

## Task 1: Dependencies And Test Script

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install runtime dependencies**

Run:

```bash
npm install express better-sqlite3
```

Expected: `package.json` dependencies include `express` and `better-sqlite3`; `package-lock.json` updates.

- [ ] **Step 2: Add test script**

In `package.json`, add this script while preserving existing PM2 scripts:

```json
"test": "node --test tests/*.test.js"
```

- [ ] **Step 3: Verify baseline**

Run:

```bash
npm test
```

Expected before tests exist: non-zero exit because `tests/*.test.js` does not exist. Continue.

- [ ] **Step 4: Commit dependency setup**

Run only if user asked for commits:

```bash
git add package.json package-lock.json
git commit -m "build: add scheduler API deps"
```

## Task 2: SQLite Store

**Files:**
- Create: `src/scheduler-db.js`
- Create: `tests/scheduler-db.test.js`

- [ ] **Step 1: Write failing DB tests**

Create `tests/scheduler-db.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulerDb } = require('../src/scheduler-db');

function createDb() {
    return createSchedulerDb(':memory:');
}

test('creates and resolves channel aliases', () => {
    const db = createDb();
    const alias = db.upsertChannelAlias({
        alias: 'work-alerts',
        channelId: '123',
        guildId: 'guild-1',
        guildName: 'Work',
        channelName: 'alerts'
    });

    assert.equal(alias.alias, 'work-alerts');
    assert.equal(alias.channel_id, '123');
    assert.equal(db.getChannelAlias('work-alerts').guild_name, 'Work');
    assert.equal(db.listChannelAliases().length, 1);
    db.close();
});

test('creates scheduled messages and lists due rows', () => {
    const db = createDb();
    db.upsertChannelAlias({ alias: 'work-alerts', channelId: '123' });
    db.createScheduledMessage({ channelAlias: 'work-alerts', content: 'future', sendAt: '2099-01-01T00:00:00.000Z' });
    const due = db.createScheduledMessage({ channelAlias: 'work-alerts', content: 'due', sendAt: '2020-01-01T00:00:00.000Z' });

    const rows = db.listDueScheduledMessages(new Date('2020-01-01T00:00:01.000Z'));

    assert.deepEqual(rows.map(row => row.id), [due.id]);
    db.close();
});

test('records sent and failed history', () => {
    const db = createDb();
    db.upsertChannelAlias({ alias: 'work-alerts', channelId: '123' });
    const sent = db.createScheduledMessage({ channelAlias: 'work-alerts', content: 'ok', sendAt: '2020-01-01T00:00:00.000Z' });
    const failed = db.createScheduledMessage({ channelAlias: 'work-alerts', content: 'bad', sendAt: '2020-01-01T00:00:00.000Z' });

    db.markScheduledMessageSent({ id: sent.id, channelAlias: 'work-alerts', channelId: '123', content: 'ok', discordMessageId: 'd1' });
    db.markScheduledMessageFailed({ id: failed.id, channelAlias: 'work-alerts', channelId: '123', content: 'bad', error: 'Missing Access' });

    assert.equal(db.getScheduledMessage(sent.id).status, 'sent');
    assert.equal(db.getScheduledMessage(failed.id).status, 'failed');
    assert.equal(db.listMessageHistory().length, 2);
    db.close();
});
```

- [ ] **Step 2: Run failing tests**

```bash
npm test
```

Expected: FAIL with `Cannot find module '../src/scheduler-db'`.

- [ ] **Step 3: Implement `src/scheduler-db.js`**

Create `src/scheduler-db.js` with these exports:

```javascript
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const VALID_STATUSES = new Set(['scheduled', 'paused', 'sent', 'failed', 'cancelled']);

function nowIso() {
    return new Date().toISOString();
}

function ensureParentDirectory(sqlitePath) {
    if (sqlitePath === ':memory:') return;
    fs.mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
}

function normalizeDate(value) {
    if (value instanceof Date) return value.toISOString();
    return value;
}

function createSchedulerDb(sqlitePath) {
    ensureParentDirectory(sqlitePath);
    const db = new Database(sqlitePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
        CREATE TABLE IF NOT EXISTS channel_aliases (
            alias TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            guild_id TEXT,
            guild_name TEXT,
            channel_name TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scheduled_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_alias TEXT NOT NULL,
            content TEXT NOT NULL,
            send_at TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_error TEXT,
            FOREIGN KEY (channel_alias) REFERENCES channel_aliases(alias)
        );
        CREATE TABLE IF NOT EXISTS message_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scheduled_message_id INTEGER,
            channel_alias TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            content TEXT NOT NULL,
            status TEXT NOT NULL,
            discord_message_id TEXT,
            error TEXT,
            sent_at TEXT NOT NULL,
            FOREIGN KEY (scheduled_message_id) REFERENCES scheduled_messages(id)
        );
    `);

    function getChannelAlias(alias) {
        return db.prepare('SELECT * FROM channel_aliases WHERE alias = ?').get(alias) || null;
    }

    function listChannelAliases() {
        return db.prepare('SELECT * FROM channel_aliases ORDER BY alias ASC').all();
    }

    function upsertChannelAlias({ alias, channelId, guildId = null, guildName = null, channelName = null }) {
        const existing = getChannelAlias(alias);
        const createdAt = existing?.created_at || nowIso();
        const updatedAt = nowIso();
        db.prepare(`
            INSERT INTO channel_aliases (alias, channel_id, guild_id, guild_name, channel_name, created_at, updated_at)
            VALUES (@alias, @channelId, @guildId, @guildName, @channelName, @createdAt, @updatedAt)
            ON CONFLICT(alias) DO UPDATE SET
                channel_id = excluded.channel_id,
                guild_id = excluded.guild_id,
                guild_name = excluded.guild_name,
                channel_name = excluded.channel_name,
                updated_at = excluded.updated_at
        `).run({ alias, channelId, guildId, guildName, channelName, createdAt, updatedAt });
        return getChannelAlias(alias);
    }

    function deleteChannelAlias(alias) {
        return db.prepare('DELETE FROM channel_aliases WHERE alias = ?').run(alias).changes > 0;
    }

    function getScheduledMessage(id) {
        return db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) || null;
    }

    function listScheduledMessages() {
        return db.prepare('SELECT * FROM scheduled_messages ORDER BY send_at ASC, id ASC').all();
    }

    function createScheduledMessage({ channelAlias, content, sendAt }) {
        const timestamp = nowIso();
        const result = db.prepare(`
            INSERT INTO scheduled_messages (channel_alias, content, send_at, status, created_at, updated_at, last_error)
            VALUES (?, ?, ?, 'scheduled', ?, ?, NULL)
        `).run(channelAlias, content, normalizeDate(sendAt), timestamp, timestamp);
        return getScheduledMessage(result.lastInsertRowid);
    }

    function updateScheduledMessage(id, updates) {
        const existing = getScheduledMessage(id);
        if (!existing) return null;
        const next = {
            channel_alias: updates.channelAlias ?? existing.channel_alias,
            content: updates.content ?? existing.content,
            send_at: normalizeDate(updates.sendAt ?? existing.send_at),
            status: updates.status ?? existing.status,
            last_error: updates.status === 'scheduled' ? null : existing.last_error,
            updated_at: nowIso(),
            id
        };
        if (!VALID_STATUSES.has(next.status)) throw new Error(`Invalid status: ${next.status}`);
        db.prepare(`
            UPDATE scheduled_messages
            SET channel_alias = @channel_alias, content = @content, send_at = @send_at,
                status = @status, last_error = @last_error, updated_at = @updated_at
            WHERE id = @id
        `).run(next);
        return getScheduledMessage(id);
    }

    function deleteScheduledMessage(id) {
        const existing = getScheduledMessage(id);
        if (!existing) return null;
        return db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id).changes > 0 ? existing : null;
    }

    function listDueScheduledMessages(now = new Date()) {
        return db.prepare(`
            SELECT * FROM scheduled_messages
            WHERE status = 'scheduled' AND send_at <= ?
            ORDER BY send_at ASC, id ASC
        `).all(normalizeDate(now));
    }

    function listMessageHistory() {
        return db.prepare('SELECT * FROM message_history ORDER BY sent_at DESC, id DESC').all();
    }

    function markScheduledMessageSent({ id, channelAlias, channelId, content, discordMessageId }) {
        const timestamp = nowIso();
        db.prepare("UPDATE scheduled_messages SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?").run(timestamp, id);
        db.prepare(`
            INSERT INTO message_history (scheduled_message_id, channel_alias, channel_id, content, status, discord_message_id, error, sent_at)
            VALUES (?, ?, ?, ?, 'sent', ?, NULL, ?)
        `).run(id, channelAlias, channelId, content, discordMessageId, timestamp);
        return getScheduledMessage(id);
    }

    function markScheduledMessageFailed({ id, channelAlias, channelId, content, error }) {
        const timestamp = nowIso();
        db.prepare("UPDATE scheduled_messages SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(error, timestamp, id);
        db.prepare(`
            INSERT INTO message_history (scheduled_message_id, channel_alias, channel_id, content, status, discord_message_id, error, sent_at)
            VALUES (?, ?, ?, ?, 'failed', NULL, ?, ?)
        `).run(id, channelAlias, channelId, content, error, timestamp);
        return getScheduledMessage(id);
    }

    return {
        close: () => db.close(),
        getChannelAlias,
        listChannelAliases,
        upsertChannelAlias,
        deleteChannelAlias,
        getScheduledMessage,
        listScheduledMessages,
        createScheduledMessage,
        updateScheduledMessage,
        deleteScheduledMessage,
        listDueScheduledMessages,
        listMessageHistory,
        markScheduledMessageSent,
        markScheduledMessageFailed
    };
}

module.exports = { createSchedulerDb };
```

- [ ] **Step 4: Run DB tests**

```bash
npm test
```

Expected: PASS for `scheduler-db.test.js`.

## Task 3: Local API

**Files:**
- Create: `src/local-api.js`
- Create: `tests/local-api.test.js`

- [ ] **Step 1: Write API tests**

Create `tests/local-api.test.js` with tests for these exact behaviors:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulerDb } = require('../src/scheduler-db');
const { createLocalApiApp } = require('../src/local-api');

function context() {
    const db = createSchedulerDb(':memory:');
    const textChannel = { id: 'channel-1', name: 'alerts', type: 'GUILD_TEXT', guild: { id: 'guild-1', name: 'Work' } };
    const client = {
        isReady: () => true,
        guilds: { cache: new Map([['guild-1', { id: 'guild-1', name: 'Work', channels: { cache: new Map([['channel-1', textChannel]]) } }]]) },
        channels: { fetch: async () => textChannel }
    };
    return { db, app: createLocalApiApp({ db, client }) };
}

async function request(app, path, options = {}) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}${path}`;
    try {
        const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
        return { status: res.status, body: await res.json() };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('health and channel discovery work', async () => {
    const { db, app } = context();
    assert.deepEqual((await request(app, '/api/health')).body, { ok: true, db: true, discordReady: true });
    assert.equal((await request(app, '/api/channels/discover')).body.channels[0].channelId, 'channel-1');
    db.close();
});

test('alias and schedule routes validate input', async () => {
    const { db, app } = context();
    assert.equal((await request(app, '/api/channel-aliases', { method: 'POST', body: JSON.stringify({ alias: 'bad alias', channelId: 'channel-1' }) })).status, 400);
    assert.equal((await request(app, '/api/channel-aliases', { method: 'POST', body: JSON.stringify({ alias: 'work-alerts', channelId: 'channel-1' }) })).status, 201);
    assert.equal((await request(app, '/api/scheduled-messages', { method: 'POST', body: JSON.stringify({ channelAlias: 'work-alerts', content: 'hello', sendAt: '2099-01-01T00:00:00' }) })).status, 400);
    assert.equal((await request(app, '/api/scheduled-messages', { method: 'POST', body: JSON.stringify({ channelAlias: 'work-alerts', content: 'hello', sendAt: '2099-01-01T00:00:00.000Z' }) })).status, 201);
    db.close();
});
```

- [ ] **Step 2: Run failing tests**

```bash
npm test
```

Expected: FAIL with `Cannot find module '../src/local-api'`.

- [ ] **Step 3: Implement API routes**

Create `src/local-api.js` with:

- `createLocalApiApp({ db, client })`
- `startLocalApi({ db, client, host, port })`
- Routes from spec: health, discover, aliases CRUD, scheduled messages CRUD, history.
- Validation: alias has no whitespace, content non-empty, `sendAt` matches `YYYY-MM-DDTHH:mm:ss(.sss)?(Z|+HH:MM|-HH:MM)`, `channelAlias` exists.
- Status transitions: `scheduled->paused`, `paused->scheduled`, `scheduled->cancelled`, `paused->cancelled`, `failed->scheduled` with future `sendAt`.

Use this exact response shape for failures:

```javascript
function errorResponse(res, status, message) {
    return res.status(status).json({ error: message });
}
```

Use this exact timestamp regex:

```javascript
const SEND_AT_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
```

- [ ] **Step 4: Run API tests**

```bash
npm test
```

Expected: PASS for DB and API tests.

## Task 4: Scheduler Send Loop

**Files:**
- Create: `src/scheduler.js`
- Create: `tests/scheduler.test.js`

- [ ] **Step 1: Write scheduler tests**

Create `tests/scheduler.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulerDb } = require('../src/scheduler-db');
const { runSchedulerTick } = require('../src/scheduler');

test('sends due message and records success', async () => {
    const db = createSchedulerDb(':memory:');
    db.upsertChannelAlias({ alias: 'work-alerts', channelId: 'channel-1' });
    const row = db.createScheduledMessage({ channelAlias: 'work-alerts', content: 'hello', sendAt: '2020-01-01T00:00:00.000Z' });
    const sent = [];
    const client = { channels: { fetch: async channelId => ({ send: async content => { sent.push({ channelId, content }); return { id: 'discord-1' }; } }) } };

    await runSchedulerTick({ db, client, now: new Date('2020-01-01T00:00:01.000Z') });

    assert.deepEqual(sent, [{ channelId: 'channel-1', content: 'hello' }]);
    assert.equal(db.getScheduledMessage(row.id).status, 'sent');
    assert.equal(db.listMessageHistory()[0].discord_message_id, 'discord-1');
    db.close();
});

test('records failure without throwing', async () => {
    const db = createSchedulerDb(':memory:');
    db.upsertChannelAlias({ alias: 'work-alerts', channelId: 'channel-1' });
    const row = db.createScheduledMessage({ channelAlias: 'work-alerts', content: 'hello', sendAt: '2020-01-01T00:00:00.000Z' });
    const client = { channels: { fetch: async () => ({ send: async () => { throw new Error('Missing Access'); } }) } };

    await runSchedulerTick({ db, client, now: new Date('2020-01-01T00:00:01.000Z') });

    assert.equal(db.getScheduledMessage(row.id).status, 'failed');
    assert.equal(db.getScheduledMessage(row.id).last_error, 'Missing Access');
    assert.equal(db.listMessageHistory()[0].status, 'failed');
    db.close();
});
```

- [ ] **Step 2: Run failing tests**

```bash
npm test
```

Expected: FAIL with `Cannot find module '../src/scheduler'`.

- [ ] **Step 3: Implement scheduler**

Create `src/scheduler.js` with:

```javascript
function toErrorMessage(error) {
    return error?.message || String(error);
}

async function sendScheduledMessage({ db, client, message }) {
    const alias = db.getChannelAlias(message.channel_alias);
    if (!alias) {
        db.markScheduledMessageFailed({ id: message.id, channelAlias: message.channel_alias, channelId: 'unknown', content: message.content, error: `Channel alias not found: ${message.channel_alias}` });
        return;
    }
    try {
        const channel = await client.channels.fetch(alias.channel_id);
        const sentMessage = await channel.send(message.content);
        db.markScheduledMessageSent({ id: message.id, channelAlias: message.channel_alias, channelId: alias.channel_id, content: message.content, discordMessageId: sentMessage.id });
    } catch (error) {
        db.markScheduledMessageFailed({ id: message.id, channelAlias: message.channel_alias, channelId: alias.channel_id, content: message.content, error: toErrorMessage(error) });
    }
}

async function runSchedulerTick({ db, client, now = new Date() }) {
    for (const message of db.listDueScheduledMessages(now)) {
        await sendScheduledMessage({ db, client, message });
    }
}

function startScheduler({ db, client, pollMs }) {
    let isRunning = false;
    async function tick() {
        if (isRunning) return;
        isRunning = true;
        try {
            await runSchedulerTick({ db, client });
        } finally {
            isRunning = false;
        }
    }
    const timer = setInterval(() => tick().catch(error => console.error('Scheduler tick failed:', error)), pollMs);
    tick().catch(error => console.error('Initial scheduler tick failed:', error));
    return { stop: () => clearInterval(timer), tick };
}

module.exports = { runSchedulerTick, startScheduler };
```

- [ ] **Step 4: Run scheduler tests**

```bash
npm test
```

Expected: PASS all tests.

## Task 5: Wire Into `mirror.js`

**Files:**
- Modify: `config.example.js`
- Modify: `mirror.js`

- [ ] **Step 1: Add config defaults**

Update `config.example.js` to include:

```javascript
    enableLocalApi: true,
    localApiHost: '127.0.0.1',
    localApiPort: 3000,
    schedulerPollMs: 5000,
    sqlitePath: './data/scheduler.sqlite'
```

- [ ] **Step 2: Import new modules in `mirror.js`**

Add:

```javascript
const { createSchedulerDb } = require('./src/scheduler-db');
const { startLocalApi } = require('./src/local-api');
const { startScheduler } = require('./src/scheduler');
```

Extend config destructuring with:

```javascript
    enableLocalApi = true,
    localApiHost = '127.0.0.1',
    localApiPort = 3000,
    schedulerPollMs = 5000,
    sqlitePath = './data/scheduler.sqlite'
```

- [ ] **Step 3: Start services after Discord ready**

Replace existing ready handler with:

```javascript
let schedulerDb = null;
let schedulerHandle = null;
let localApiServer = null;

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    if (schedulerDb) return;
    schedulerDb = createSchedulerDb(sqlitePath);
    schedulerHandle = startScheduler({ db: schedulerDb, client, pollMs: schedulerPollMs });
    if (enableLocalApi) {
        localApiServer = startLocalApi({ db: schedulerDb, client, host: localApiHost, port: localApiPort });
    }
});
```

Add shutdown cleanup:

```javascript
function shutdown() {
    schedulerHandle?.stop();
    localApiServer?.close();
    schedulerDb?.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 4: Verify tests**

```bash
npm test
```

Expected: PASS all tests.

## Task 6: Manual Smoke Test

**Files:**
- Runtime: `data/scheduler.sqlite`

- [ ] **Step 1: Start bot**

```bash
npm start
```

Expected logs after Discord login:

```text
Logged in as <your tag>!
Local scheduler API listening on http://127.0.0.1:3000
```

- [ ] **Step 2: Check health**

```bash
curl http://127.0.0.1:3000/api/health
```

Expected:

```json
{"ok":true,"db":true,"discordReady":true}
```

- [ ] **Step 3: Discover channels**

```bash
curl http://127.0.0.1:3000/api/channels/discover
```

Expected: `channels` array with visible guild text channels.

- [ ] **Step 4: Create alias**

Replace `CHANNEL_ID` with real discovered channel ID:

```bash
curl -X POST http://127.0.0.1:3000/api/channel-aliases \
  -H 'content-type: application/json' \
  -d '{"alias":"test-channel","channelId":"CHANNEL_ID"}'
```

Expected: response has `alias.alias = "test-channel"` and `alias.channel_id = "CHANNEL_ID"`.

- [ ] **Step 5: Schedule a message one minute ahead**

Generate timestamp:

```bash
node -e "console.log(new Date(Date.now() + 60000).toISOString())"
```

Use timestamp in request:

```bash
curl -X POST http://127.0.0.1:3000/api/scheduled-messages \
  -H 'content-type: application/json' \
  -d '{"channelAlias":"test-channel","content":"Scheduled selfbot smoke test","sendAt":"PASTE_TIMESTAMP_HERE"}'
```

Expected: response status `201`, message status `scheduled`.

- [ ] **Step 6: Verify history after send time**

```bash
curl http://127.0.0.1:3000/api/message-history
```

Expected: history row with `status` `sent` and non-empty `discord_message_id`, or `failed` with useful `error`.

## Self-Review Notes

- Spec coverage: local API, localhost binding, SQLite, aliases, discovery, one-time scheduling, management routes, history, config, and scheduler failure handling are covered.
- Placeholder scan: no `TBD`, no `TODO`, no unresolved file paths.
- Type consistency: API uses camelCase JSON inputs; DB stores snake_case columns; tests assert DB snake_case rows.

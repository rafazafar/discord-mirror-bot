const assert = require('node:assert/strict');
const test = require('node:test');

const { createLocalApiApp, startLocalApi } = require('../src/local-api');
const { createSchedulerDb } = require('../src/scheduler-db');

function futureIso(minutes = 10) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function createFakeClient() {
  const channels = new Map([
    [
      'text-1',
      {
        id: 'text-1',
        name: 'general',
        type: 'GUILD_TEXT',
        guild: { id: 'guild-1', name: 'Guild One' },
      },
    ],
    [
      'news-1',
      {
        id: 'news-1',
        name: 'announcements',
        type: 5,
        guild: { id: 'guild-1', name: 'Guild One' },
      },
    ],
    [
      'voice-1',
      {
        id: 'voice-1',
        name: 'Voice',
        type: 'GUILD_VOICE',
        guild: { id: 'guild-1', name: 'Guild One' },
      },
    ],
    [
      'dm-text-1',
      {
        id: 'dm-text-1',
        name: 'dm-text',
        type: 'GUILD_TEXT',
      },
    ],
  ]);

  return {
    isReady: () => true,
    readyAt: new Date(),
    channels: {
      cache: channels,
      fetch: async (channelId) => channels.get(channelId),
    },
    guilds: {
      cache: new Map([
        [
          'guild-1',
          {
            id: 'guild-1',
            name: 'Guild One',
            channels: { cache: channels },
          },
        ],
      ]),
    },
  };
}

async function withApi(t, callback) {
  const db = createSchedulerDb(':memory:');
  const app = createLocalApiApp({ db, client: createFakeClient() });
  const server = app.listen(0);
  t.after(() => {
    server.close();
    db.close();
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    return {
      status: response.status,
      body: text && contentType.includes('application/json') ? JSON.parse(text) : null,
      text,
    };
  }

  await callback({ db, request });
}

async function createScheduledMessage(request) {
  await request('POST', '/api/channel-aliases', { alias: 'general', channelId: 'text-1' });
  return request('POST', '/api/scheduled-messages', {
    channelAlias: 'general',
    content: 'hello',
    sendAt: futureIso(20),
  });
}

test('health reports ok, db, and Discord readiness', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('GET', '/api/health');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, db: true, discordReady: true });
  });
});

test('startLocalApi rejects non-loopback host and allows loopback host', async (t) => {
  const db = createSchedulerDb(':memory:');
  t.after(() => db.close());

  assert.throws(
    () => startLocalApi({ db, client: createFakeClient(), host: '0.0.0.0', port: 0 }),
    /local API host must be loopback/
  );

  const server = startLocalApi({ db, client: createFakeClient(), host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  assert.equal(server.address().address, '127.0.0.1');
});

test('discovers only text-like guild channels', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('GET', '/api/channels/discover');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [
      {
        guildId: 'guild-1',
        guildName: 'Guild One',
        channelId: 'text-1',
        channelName: 'general',
      },
      {
        guildId: 'guild-1',
        guildName: 'Guild One',
        channelId: 'news-1',
        channelName: 'announcements',
      },
    ]);
  });
});

test('rejects invalid aliases and stores valid alias metadata', async (t) => {
  await withApi(t, async ({ request }) => {
    const invalid = await request('POST', '/api/channel-aliases', {
      alias: 'bad alias',
      channelId: 'text-1',
    });

    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, { error: 'Alias must be a non-empty string without whitespace' });

    const created = await request('POST', '/api/channel-aliases', {
      alias: 'general',
      channelId: 'text-1',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.alias, 'general');
    assert.equal(created.body.channel_id, 'text-1');
    assert.equal(created.body.guild_id, 'guild-1');
    assert.equal(created.body.guild_name, 'Guild One');
    assert.equal(created.body.channel_name, 'general');

    const list = await request('GET', '/api/channel-aliases');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].alias, 'general');

    const patched = await request('PATCH', '/api/channel-aliases/general', { channelId: 'news-1' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.channel_name, 'announcements');

    const deleted = await request('DELETE', '/api/channel-aliases/general');
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { ok: true });
  });
});

test('rejects alias for voice channel', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('POST', '/api/channel-aliases', {
      alias: 'voice',
      channelId: 'voice-1',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'channelId must resolve to a visible guild text channel' });
  });
});

test('rejects alias for missing channel', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('POST', '/api/channel-aliases', {
      alias: 'missing',
      channelId: 'missing-1',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'channelId must resolve to a visible guild text channel' });
  });
});

test('rejects alias for text channel without guild', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('POST', '/api/channel-aliases', {
      alias: 'dm',
      channelId: 'dm-text-1',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'channelId must resolve to a visible guild text channel' });
  });
});

test('rejects alias create with missing JSON body', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('POST', '/api/channel-aliases');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be a JSON object' });
  });
});

test('rejects malformed JSON body with stable JSON error', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('POST', '/api/channel-aliases', '{');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be valid JSON' });
  });
});

test('rejects alias create with array body', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('POST', '/api/channel-aliases', []);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be a JSON object' });
  });
});

test('rejects alias patch with missing JSON body', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('PATCH', '/api/channel-aliases/general');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be a JSON object' });
  });
});

test('rejects alias patch with array body', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('PATCH', '/api/channel-aliases/general', []);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be a JSON object' });
  });
});

test('rejects scheduled message with zoneless timestamp', async (t) => {
  await withApi(t, async ({ request }) => {
    await request('POST', '/api/channel-aliases', { alias: 'general', channelId: 'text-1' });

    const response = await request('POST', '/api/scheduled-messages', {
      channelAlias: 'general',
      content: 'hello',
      sendAt: '2026-05-25T10:00:00',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'sendAt must be a valid ISO timestamp with Z or offset' });
  });
});

test('rejects scheduled message with missing JSON body', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('POST', '/api/scheduled-messages');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be a JSON object' });
  });
});

test('rejects scheduled message with array body', async (t) => {
  await withApi(t, async ({ request }) => {
    const response = await request('POST', '/api/scheduled-messages', []);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be a JSON object' });
  });
});

test('creates valid future scheduled message with normalized sendAt', async (t) => {
  await withApi(t, async ({ request }) => {
    await request('POST', '/api/channel-aliases', { alias: 'general', channelId: 'text-1' });

    const response = await request('POST', '/api/scheduled-messages', {
      channelAlias: 'general',
      content: 'hello',
      sendAt: futureIso(),
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.channel_alias, 'general');
    assert.equal(response.body.content, 'hello');
    assert.equal(response.body.status, 'scheduled');
    assert.match(response.body.send_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

test('lists, gets, and updates allowed scheduled message status transitions', async (t) => {
  await withApi(t, async ({ request }) => {
    await request('POST', '/api/channel-aliases', { alias: 'general', channelId: 'text-1' });
    const created = await request('POST', '/api/scheduled-messages', {
      channelAlias: 'general',
      content: 'hello',
      sendAt: futureIso(20),
    });

    const paused = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, { status: 'paused' });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, 'paused');

    const scheduled = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, { status: 'scheduled' });
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.body.status, 'scheduled');

    const fetched = await request('GET', `/api/scheduled-messages/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, created.body.id);

    const list = await request('GET', '/api/scheduled-messages');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((row) => row.id), [created.body.id]);

    const cancelled = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, { status: 'cancelled' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
  });
});

test('rejects malformed scheduled message ids', async (t) => {
  await withApi(t, async ({ request }) => {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await request(method, '/api/scheduled-messages/not-a-number', method === 'PATCH' ? {} : undefined);

      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: 'Scheduled message id must be an integer' });
    }
  });
});

test('patch scheduled message with empty body returns current message unchanged', async (t) => {
  await withApi(t, async ({ request }) => {
    const created = await createScheduledMessage(request);

    const response = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, {});

    assert.equal(response.status, 200);
    assert.equal(response.body.id, created.body.id);
    assert.equal(response.body.channel_alias, created.body.channel_alias);
    assert.equal(response.body.content, created.body.content);
    assert.equal(response.body.send_at, created.body.send_at);
    assert.equal(response.body.status, created.body.status);
  });
});

test('rejects scheduled message patch with missing JSON body', async (t) => {
  await withApi(t, async ({ request }) => {
    const created = await createScheduledMessage(request);

    const response = await request('PATCH', `/api/scheduled-messages/${created.body.id}`);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be a JSON object' });
  });
});

test('rejects scheduled message patch with array body', async (t) => {
  await withApi(t, async ({ request }) => {
    const created = await createScheduledMessage(request);

    const response = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, []);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Request body must be a JSON object' });
  });
});

test('does not allow sent message back to scheduled', async (t) => {
  await withApi(t, async ({ db, request }) => {
    await request('POST', '/api/channel-aliases', { alias: 'general', channelId: 'text-1' });
    const created = await request('POST', '/api/scheduled-messages', {
      channelAlias: 'general',
      content: 'hello',
      sendAt: futureIso(20),
    });
    db.claimScheduledMessage(created.body.id);
    db.markScheduledMessageSent({
      id: created.body.id,
      channelAlias: 'general',
      channelId: 'text-1',
      content: 'hello',
      discordMessageId: 'discord-1',
    });

    const response = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, {
      status: 'scheduled',
      sendAt: futureIso(30),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Invalid status transition' });
  });
});

test('rejects terminal scheduled message field mutations', async (t) => {
  await withApi(t, async ({ db, request }) => {
    const created = await createScheduledMessage(request);
    db.claimScheduledMessage(created.body.id);
    db.markScheduledMessageSent({
      id: created.body.id,
      channelAlias: 'general',
      channelId: 'text-1',
      content: 'hello',
      discordMessageId: 'discord-1',
    });

    for (const body of [
      { content: 'changed' },
      { sendAt: futureIso(30) },
      { channelAlias: 'general' },
    ]) {
      const response = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, body);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: 'Scheduled message cannot be modified in current status' });
    }

    const afterSent = await request('GET', `/api/scheduled-messages/${created.body.id}`);
    assert.equal(afterSent.body.content, 'hello');
    assert.equal(afterSent.body.send_at, created.body.send_at);
    assert.equal(afterSent.body.status, 'sent');

    const cancelled = await createScheduledMessage(request);
    await request('PATCH', `/api/scheduled-messages/${cancelled.body.id}`, { status: 'cancelled' });
    const cancelledMutation = await request('PATCH', `/api/scheduled-messages/${cancelled.body.id}`, { content: 'changed' });
    assert.equal(cancelledMutation.status, 400);
    assert.deepEqual(cancelledMutation.body, { error: 'Scheduled message cannot be modified in current status' });
    assert.equal(db.getScheduledMessage(cancelled.body.id).content, 'hello');
  });
});

test('rejects failed scheduled message field mutations unless retrying with future sendAt', async (t) => {
  await withApi(t, async ({ db, request }) => {
    const created = await createScheduledMessage(request);
    db.claimScheduledMessage(created.body.id);
    db.markScheduledMessageFailed({
      id: created.body.id,
      channelAlias: 'general',
      channelId: 'text-1',
      content: 'hello',
      error: 'boom',
    });

    const contentOnly = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, { content: 'changed' });
    assert.equal(contentOnly.status, 400);
    assert.deepEqual(contentOnly.body, { error: 'Scheduled message cannot be modified in current status' });
    assert.equal(db.getScheduledMessage(created.body.id).content, 'hello');

    const retry = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, {
      status: 'scheduled',
      sendAt: futureIso(30),
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, 'scheduled');
    assert.equal(retry.body.last_error, null);
    assert.notEqual(retry.body.send_at, created.body.send_at);
  });
});

test('rejects user setting scheduled message to internal sending status', async (t) => {
  await withApi(t, async ({ request }) => {
    const created = await createScheduledMessage(request);

    const response = await request('PATCH', `/api/scheduled-messages/${created.body.id}`, {
      status: 'sending',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Invalid status transition' });
  });
});

test('lists message history', async (t) => {
  await withApi(t, async ({ db, request }) => {
    await request('POST', '/api/channel-aliases', { alias: 'general', channelId: 'text-1' });
    const created = await request('POST', '/api/scheduled-messages', {
      channelAlias: 'general',
      content: 'hello',
      sendAt: futureIso(20),
    });
    db.claimScheduledMessage(created.body.id);
    db.markScheduledMessageSent({
      id: created.body.id,
      channelAlias: 'general',
      channelId: 'text-1',
      content: 'hello',
      discordMessageId: 'discord-1',
    });

    const response = await request('GET', '/api/message-history');

    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
    assert.equal(response.body[0].scheduled_message_id, created.body.id);
    assert.equal(response.body[0].status, 'sent');
    assert.equal(response.body[0].discord_message_id, 'discord-1');
  });
});

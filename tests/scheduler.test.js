const assert = require('node:assert/strict');
const test = require('node:test');

const { createSchedulerDb } = require('../src/scheduler-db');
const { runSchedulerTick, startScheduler } = require('../src/scheduler');

const DUE_AT = '2026-05-25T10:00:00.000Z';
const NOW = new Date('2026-05-25T10:30:00.000Z');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFakeClient(channels) {
  const sent = [];
  const fetches = [];
  return {
    sent,
    fetches,
    channels: {
      fetch: async (channelId) => {
        fetches.push(channelId);
        const channel = channels[channelId];
        if (!channel) throw new Error(`missing channel ${channelId}`);
        return channel;
      },
    },
  };
}

function createNoopClient() {
  return { channels: { fetch: async () => { throw new Error('unexpected fetch'); } } };
}

async function withDb(callback) {
  const db = createSchedulerDb(':memory:');
  try {
    await callback(db);
  } finally {
    db.close();
  }
}

test('passes now directly to db when listing due scheduled messages', async () => {
  const now = new Date('2026-05-25T10:30:00.000Z');
  let receivedNow;
  const db = {
    recoverStaleSendingMessages() {
      return [];
    },
    listDueScheduledMessages(value) {
      receivedNow = value;
      return [];
    },
  };

  await runSchedulerTick({ db, client: createNoopClient(), now });

  assert.equal(receivedNow, now);
});

test('recovers stale sending messages before listing due messages', async () => {
  const now = new Date('2026-05-25T10:30:00.000Z');
  const calls = [];
  const db = {
    recoverStaleSendingMessages({ olderThan }) {
      calls.push(['recover', olderThan.toISOString()]);
      return [];
    },
    listDueScheduledMessages(value) {
      calls.push(['list', value]);
      return [];
    },
  };

  await runSchedulerTick({ db, client: createNoopClient(), now, sendingStaleMs: 60_000 });

  assert.deepEqual(calls, [
    ['recover', '2026-05-25T10:29:00.000Z'],
    ['list', now],
  ]);
});

test('due message sends and records success', async () => {
  await withDb(async (db) => {
    db.upsertChannelAlias({ alias: 'general', channelId: 'channel-1' });
    const message = db.createScheduledMessage({ channelAlias: 'general', content: 'hello', sendAt: DUE_AT });
    const client = createFakeClient({
      'channel-1': {
        send: async (content) => {
          client.sent.push(content);
          return { id: 'discord-1' };
        },
      },
    });

    await runSchedulerTick({ db, client, now: NOW });

    assert.deepEqual(client.fetches, ['channel-1']);
    assert.deepEqual(client.sent, ['hello']);
    assert.equal(db.getScheduledMessage(message.id).status, 'sent');
    assert.deepEqual(
      db.listMessageHistory().map((row) => ({
        scheduled_message_id: row.scheduled_message_id,
        channel_alias: row.channel_alias,
        channel_id: row.channel_id,
        content: row.content,
        status: row.status,
        discord_message_id: row.discord_message_id,
        error: row.error,
      })),
      [
        {
          scheduled_message_id: message.id,
          channel_alias: 'general',
          channel_id: 'channel-1',
          content: 'hello',
          status: 'sent',
          discord_message_id: 'discord-1',
          error: null,
        },
      ]
    );
  });
});

test('send throws marks failed and records history', async () => {
  await withDb(async (db) => {
    db.upsertChannelAlias({ alias: 'alerts', channelId: 'channel-2' });
    const message = db.createScheduledMessage({ channelAlias: 'alerts', content: 'boom', sendAt: DUE_AT });
    const client = createFakeClient({
      'channel-2': {
        send: async () => {
          throw new Error('rate limited');
        },
      },
    });

    await runSchedulerTick({ db, client, now: NOW });

    assert.equal(db.getScheduledMessage(message.id).status, 'failed');
    assert.equal(db.getScheduledMessage(message.id).last_error, 'rate limited');
    assert.equal(db.listMessageHistory()[0].status, 'failed');
    assert.equal(db.listMessageHistory()[0].error, 'rate limited');
  });
});

test('channel fetch throws marks failed and does not throw', async () => {
  await withDb(async (db) => {
    db.upsertChannelAlias({ alias: 'missing-channel', channelId: 'channel-missing' });
    const message = db.createScheduledMessage({
      channelAlias: 'missing-channel',
      content: 'cannot fetch',
      sendAt: DUE_AT,
    });
    const client = createFakeClient({});

    await assert.doesNotReject(() => runSchedulerTick({ db, client, now: NOW }));

    assert.deepEqual(client.fetches, ['channel-missing']);
    assert.equal(db.getScheduledMessage(message.id).status, 'failed');
    assert.equal(db.getScheduledMessage(message.id).last_error, 'missing channel channel-missing');
    assert.equal(db.listMessageHistory()[0].channel_id, 'channel-missing');
    assert.equal(db.listMessageHistory()[0].error, 'missing channel channel-missing');
  });
});

test('missing alias marks failed with unknown channel id and useful error', async () => {
  await withDb(async (db) => {
    db.upsertChannelAlias({ alias: 'gone', channelId: 'channel-3' });
    const message = db.createScheduledMessage({ channelAlias: 'gone', content: 'orphaned', sendAt: DUE_AT });
    db.getChannelAlias = () => undefined;
    const client = createFakeClient({});

    await runSchedulerTick({ db, client, now: NOW });

    assert.deepEqual(client.fetches, []);
    assert.equal(db.getScheduledMessage(message.id).status, 'failed');
    assert.equal(db.getScheduledMessage(message.id).last_error, 'Channel alias not found: gone');
    assert.equal(db.listMessageHistory()[0].channel_id, 'unknown');
    assert.equal(db.listMessageHistory()[0].error, 'Channel alias not found: gone');
  });
});

test('future and non-due messages are not sent', async () => {
  await withDb(async (db) => {
    db.upsertChannelAlias({ alias: 'general', channelId: 'channel-1' });
    db.createScheduledMessage({
      channelAlias: 'general',
      content: 'later',
      sendAt: '2026-05-25T11:00:00.000Z',
    });
    const client = createFakeClient({
      'channel-1': {
        send: async (content) => client.sent.push(content),
      },
    });

    await runSchedulerTick({ db, client, now: NOW });

    assert.deepEqual(client.fetches, []);
    assert.deepEqual(client.sent, []);
    assert.equal(db.listMessageHistory().length, 0);
  });
});

test('startScheduler overlap guard prevents concurrent duplicate sends', async () => {
  await withDb(async (db) => {
    db.upsertChannelAlias({ alias: 'general', channelId: 'channel-1' });
    const message = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'slow',
      sendAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const gate = deferred();
    const sendStarted = deferred();
    const client = createFakeClient({
      'channel-1': {
        send: async (content) => {
          client.sent.push(content);
          sendStarted.resolve();
          await gate.promise;
          return { id: 'discord-slow' };
        },
      },
    });

    const scheduler = startScheduler({ db, client, pollMs: 60_000 });
    try {
      await sendStarted.promise;
      await scheduler.tick();
      assert.deepEqual(client.sent, ['slow']);

      gate.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(client.sent, ['slow']);
      assert.equal(db.getScheduledMessage(message.id).status, 'sent');
      assert.equal(db.listMessageHistory().length, 1);
    } finally {
      scheduler.stop();
      gate.resolve();
    }
  });
});

test('startScheduler stop waits for active tick before resolving', async () => {
  await withDb(async (db) => {
    db.upsertChannelAlias({ alias: 'general', channelId: 'channel-1' });
    const message = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'slow stop',
      sendAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const gate = deferred();
    const sendStarted = deferred();
    const client = createFakeClient({
      'channel-1': {
        send: async (content) => {
          client.sent.push(content);
          sendStarted.resolve();
          await gate.promise;
          return { id: 'discord-drained' };
        },
      },
    });

    const scheduler = startScheduler({ db, client, pollMs: 60_000 });
    await sendStarted.promise;

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stopped, false);

    gate.resolve();
    await stopPromise;

    assert.equal(stopped, true);
    assert.equal(db.getScheduledMessage(message.id).status, 'sent');
    assert.equal(db.listMessageHistory().length, 1);
  });
});

test('concurrent scheduler ticks send same due message once', async () => {
  await withDb(async (db) => {
    db.upsertChannelAlias({ alias: 'general', channelId: 'channel-1' });
    const message = db.createScheduledMessage({ channelAlias: 'general', content: 'race', sendAt: DUE_AT });
    const gate = deferred();
    const sendStarted = deferred();
    const client = createFakeClient({
      'channel-1': {
        send: async (content) => {
          client.sent.push(content);
          sendStarted.resolve();
          await gate.promise;
          return { id: 'discord-race' };
        },
      },
    });

    const firstTick = runSchedulerTick({ db, client, now: NOW });
    await sendStarted.promise;
    await runSchedulerTick({ db, client, now: NOW, sendingStaleMs: 24 * 60 * 60 * 1000 });
    gate.resolve();
    await firstTick;

    assert.deepEqual(client.sent, ['race']);
    assert.equal(db.getScheduledMessage(message.id).status, 'sent');
    assert.equal(db.listMessageHistory().length, 1);
  });
});

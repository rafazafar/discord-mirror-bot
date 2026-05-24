const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { createSchedulerDb } = require('../src/scheduler-db');

function createOldSchemaDb(sqlitePath) {
  const db = new Database(sqlitePath);
  db.exec(`
    create table channel_aliases (
      alias text primary key,
      channel_id text not null,
      guild_id text,
      guild_name text,
      channel_name text,
      created_at text,
      updated_at text
    );

    create table scheduled_messages (
      id integer primary key autoincrement,
      channel_alias text not null,
      content text not null,
      send_at text not null,
      status text not null,
      created_at text,
      updated_at text,
      last_error text
    );

    create table message_history (
      id integer primary key autoincrement,
      scheduled_message_id integer,
      channel_alias text not null,
      channel_id text not null,
      content text not null,
      status text not null,
      discord_message_id text,
      error text,
      sent_at text not null
    );

    insert into channel_aliases (alias, channel_id, created_at, updated_at)
    values ('general', '123', '2026-05-25T10:00:00.000Z', '2026-05-25T10:00:00.000Z');

    insert into scheduled_messages (id, channel_alias, content, send_at, status, created_at, updated_at, last_error)
    values
      (1, 'general', 'valid row', '2026-05-25T10:00:00.000Z', 'scheduled', '2026-05-25T10:00:00.000Z', '2026-05-25T10:00:00.000Z', null),
      (2, 'missing', 'orphan row', '2026-05-25T10:00:00.000Z', 'scheduled', '2026-05-25T10:00:00.000Z', '2026-05-25T10:00:00.000Z', null);

    insert into message_history (scheduled_message_id, channel_alias, channel_id, content, status, discord_message_id, error, sent_at)
    values
      (1, 'general', '123', 'valid history', 'sent', 'discord-1', null, '2026-05-25T10:00:00.000Z'),
      (999, 'general', '123', 'orphan history', 'sent', 'discord-999', null, '2026-05-25T10:00:00.000Z');
  `);
  db.close();
}

test('creates and resolves channel aliases', () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({
      alias: 'general',
      channelId: '123',
      guildId: 'guild-1',
      guildName: 'Guild One',
      channelName: 'general',
    });

    assert.deepEqual(db.getChannelAlias('general'), {
      alias: 'general',
      channel_id: '123',
      guild_id: 'guild-1',
      guild_name: 'Guild One',
      channel_name: 'general',
      created_at: db.getChannelAlias('general').created_at,
      updated_at: db.getChannelAlias('general').updated_at,
    });
    assert.equal(db.listChannelAliases().length, 1);

    db.upsertChannelAlias({
      alias: 'general',
      channelId: '456',
      guildId: 'guild-2',
      guildName: 'Guild Two',
      channelName: 'announcements',
    });

    assert.equal(db.getChannelAlias('general').channel_id, '456');
    assert.equal(db.deleteChannelAlias('general'), true);
    assert.equal(db.getChannelAlias('general'), undefined);
  } finally {
    db.close();
  }
});

test('creates scheduled messages and lists only due rows', () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({ alias: 'general', channelId: '123' });

    const due = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'due now',
      sendAt: '2026-05-25T10:00:00.000Z',
    });
    const future = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'later',
      sendAt: '2026-05-25T11:00:00.000Z',
    });
    const paused = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'paused',
      sendAt: '2026-05-25T09:00:00.000Z',
    });
    db.updateScheduledMessage(paused.id, { status: 'paused' });

    assert.equal(db.getScheduledMessage(due.id).content, 'due now');
    assert.equal(db.listScheduledMessages().length, 3);
    assert.deepEqual(db.listDueScheduledMessages('2026-05-25T10:30:00.000Z').map((row) => row.id), [due.id]);
    assert.equal(db.deleteScheduledMessage(future.id), true);
    assert.equal(db.getScheduledMessage(future.id), undefined);
  } finally {
    db.close();
  }
});

test('marks scheduled messages sent and failed with history rows', () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({ alias: 'general', channelId: '123' });
    db.upsertChannelAlias({ alias: 'alerts', channelId: '999' });

    const sent = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'sent message',
      sendAt: '2026-05-25T10:00:00.000Z',
    });
    const failed = db.createScheduledMessage({
      channelAlias: 'alerts',
      content: 'failed message',
      sendAt: '2026-05-25T10:00:00.000Z',
    });
    db.updateScheduledMessage(sent.id, { status: 'sending' });
    db.updateScheduledMessage(failed.id, { status: 'sending' });

    db.markScheduledMessageSent({
      id: sent.id,
      channelAlias: 'general',
      channelId: '123',
      content: 'sent message',
      discordMessageId: 'discord-1',
    });
    db.markScheduledMessageFailed({
      id: failed.id,
      channelAlias: 'alerts',
      channelId: '999',
      content: 'failed message',
      error: 'rate limited',
    });

    assert.equal(db.getScheduledMessage(sent.id).status, 'sent');
    assert.equal(db.getScheduledMessage(failed.id).status, 'failed');
    assert.equal(db.getScheduledMessage(failed.id).last_error, 'rate limited');
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
          scheduled_message_id: sent.id,
          channel_alias: 'general',
          channel_id: '123',
          content: 'sent message',
          status: 'sent',
          discord_message_id: 'discord-1',
          error: null,
        },
        {
          scheduled_message_id: failed.id,
          channel_alias: 'alerts',
          channel_id: '999',
          content: 'failed message',
          status: 'failed',
          discord_message_id: null,
          error: 'rate limited',
        },
      ]
    );
  } finally {
    db.close();
  }
});

test('deleting sent and failed scheduled messages keeps history with null scheduled id', () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({ alias: 'general', channelId: '123' });
    const sent = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'sent message',
      sendAt: '2026-05-25T10:00:00.000Z',
    });
    const failed = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'failed message',
      sendAt: '2026-05-25T10:00:00.000Z',
    });

    db.claimScheduledMessage(sent.id);
    db.markScheduledMessageSent({
      id: sent.id,
      channelAlias: 'general',
      channelId: '123',
      content: 'sent message',
      discordMessageId: 'discord-1',
    });
    db.claimScheduledMessage(failed.id);
    db.markScheduledMessageFailed({
      id: failed.id,
      channelAlias: 'general',
      channelId: '123',
      content: 'failed message',
      error: 'boom',
    });

    assert.equal(db.deleteScheduledMessage(sent.id), true);
    assert.equal(db.deleteScheduledMessage(failed.id), true);
    assert.deepEqual(
      db.listMessageHistory().map((row) => ({ scheduled_message_id: row.scheduled_message_id, status: row.status })),
      [
        { scheduled_message_id: null, status: 'sent' },
        { scheduled_message_id: null, status: 'failed' },
      ]
    );
  } finally {
    db.close();
  }
});

test('claims scheduled message once and marks it sending', () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({ alias: 'general', channelId: '123' });
    const message = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'claim me',
      sendAt: '2026-05-25T10:00:00.000Z',
    });

    const claimed = db.claimScheduledMessage(message.id);

    assert.equal(claimed.id, message.id);
    assert.equal(claimed.status, 'sending');
    assert.equal(db.claimScheduledMessage(message.id), null);
    assert.equal(db.getScheduledMessage(message.id).status, 'sending');
  } finally {
    db.close();
  }
});

test('marking scheduled message sent without sending state throws and writes no history', () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({ alias: 'general', channelId: '123' });
    const message = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'not claimed',
      sendAt: '2026-05-25T10:00:00.000Z',
    });

    assert.throws(
      () => db.markScheduledMessageSent({
        id: message.id,
        channelAlias: 'general',
        channelId: '123',
        content: 'not claimed',
        discordMessageId: 'discord-1',
      }),
      /Scheduled message is not sending/
    );
    assert.equal(db.getScheduledMessage(message.id).status, 'scheduled');
    assert.equal(db.listMessageHistory().length, 0);
  } finally {
    db.close();
  }
});

test('recovers stale sending messages as failed and leaves fresh sending messages alone', async () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({ alias: 'general', channelId: '123' });
    const stale = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'stale send',
      sendAt: '2026-05-25T10:00:00.000Z',
    });
    const fresh = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'fresh send',
      sendAt: '2026-05-25T10:00:00.000Z',
    });

    const staleClaim = db.claimScheduledMessage(stale.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    db.claimScheduledMessage(fresh.id);

    const recovered = db.recoverStaleSendingMessages({ olderThan: staleClaim.updated_at });

    assert.deepEqual(recovered.map((row) => row.id), [stale.id]);
    assert.equal(db.getScheduledMessage(stale.id).status, 'failed');
    assert.equal(db.getScheduledMessage(stale.id).last_error, 'Scheduler interrupted while sending');
    assert.equal(db.getScheduledMessage(fresh.id).status, 'sending');
    assert.deepEqual(
      db.listMessageHistory().map((row) => ({
        scheduled_message_id: row.scheduled_message_id,
        channel_alias: row.channel_alias,
        channel_id: row.channel_id,
        content: row.content,
        status: row.status,
        error: row.error,
      })),
      [
        {
          scheduled_message_id: stale.id,
          channel_alias: 'general',
          channel_id: '123',
          content: 'stale send',
          status: 'failed',
          error: 'Scheduler interrupted while sending',
        },
      ]
    );
  } finally {
    db.close();
  }
});

test('stale sending recovery does not overwrite finalized messages', () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({ alias: 'general', channelId: '123' });
    const message = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'already sent',
      sendAt: '2026-05-25T10:00:00.000Z',
    });

    const claimed = db.claimScheduledMessage(message.id);
    db.markScheduledMessageSent({
      id: message.id,
      channelAlias: 'general',
      channelId: '123',
      content: 'already sent',
      discordMessageId: 'discord-1',
    });

    const recovered = db.recoverStaleSendingMessages({ olderThan: claimed.updated_at });

    assert.deepEqual(recovered, []);
    assert.equal(db.getScheduledMessage(message.id).status, 'sent');
    assert.equal(db.getScheduledMessage(message.id).last_error, null);
    assert.equal(db.listMessageHistory().length, 1);
  } finally {
    db.close();
  }
});

test('updates failed scheduled message back to scheduled for retry', () => {
  const db = createSchedulerDb(':memory:');

  try {
    db.upsertChannelAlias({ alias: 'general', channelId: '123' });

    const message = db.createScheduledMessage({
      channelAlias: 'general',
      content: 'retry me',
      sendAt: '2026-05-25T10:00:00.000Z',
    });
    db.updateScheduledMessage(message.id, { status: 'sending' });
    db.markScheduledMessageFailed({
      id: message.id,
      channelAlias: 'general',
      channelId: '123',
      content: 'retry me',
      error: 'temporary error',
    });

    const retried = db.updateScheduledMessage(message.id, {
      status: 'scheduled',
      sendAt: '2026-05-25T12:00:00.000Z',
      lastError: null,
    });

    assert.equal(retried.status, 'scheduled');
    assert.equal(retried.send_at, '2026-05-25T12:00:00.000Z');
    assert.equal(retried.last_error, null);
    assert.deepEqual(db.listDueScheduledMessages('2026-05-25T11:00:00.000Z'), []);
    assert.deepEqual(db.listDueScheduledMessages('2026-05-25T12:00:00.000Z').map((row) => row.id), [message.id]);
  } finally {
    db.close();
  }
});

test('marking missing scheduled message sent throws and writes no history', () => {
  const db = createSchedulerDb(':memory:');

  try {
    assert.throws(
      () => db.markScheduledMessageSent({
        id: 999,
        channelAlias: 'general',
        channelId: '123',
        content: 'missing message',
        discordMessageId: 'discord-1',
      }),
      /Scheduled message not found/
    );
    assert.equal(db.listMessageHistory().length, 0);
  } finally {
    db.close();
  }
});

test('creating scheduled message with missing alias fails integrity check', () => {
  const db = createSchedulerDb(':memory:');

  try {
    assert.throws(
      () => db.createScheduledMessage({
        channelAlias: 'missing',
        content: 'orphan',
        sendAt: '2026-05-25T10:00:00.000Z',
      }),
      /FOREIGN KEY constraint failed/
    );
  } finally {
    db.close();
  }
});

test('marking missing scheduled message failed throws and writes no history', () => {
  const db = createSchedulerDb(':memory:');

  try {
    assert.throws(
      () => db.markScheduledMessageFailed({
        id: 999,
        channelAlias: 'general',
        channelId: '123',
        content: 'missing message',
        error: 'missing',
      }),
      /Scheduled message not found/
    );
    assert.equal(db.listMessageHistory().length, 0);
  } finally {
    db.close();
  }
});

test('migrates old schema to enforce foreign keys and drops orphan rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-db-'));
  const sqlitePath = path.join(dir, 'scheduler.sqlite');
  createOldSchemaDb(sqlitePath);

  const db = createSchedulerDb(sqlitePath);

  try {
    assert.equal(db.getScheduledMessage(1).content, 'valid row');
    assert.equal(db.getScheduledMessage(2), undefined);
    assert.equal(db.listMessageHistory().length, 1);
    assert.throws(
      () => db.createScheduledMessage({
        channelAlias: 'missing',
        content: 'orphan',
        sendAt: '2026-05-25T10:00:00.000Z',
      }),
      /FOREIGN KEY constraint failed/
    );
    assert.throws(
      () => db.markScheduledMessageSent({
        id: 999,
        channelAlias: 'general',
        channelId: '123',
        content: 'missing message',
        discordMessageId: 'discord-999',
      }),
      /Scheduled message not found/
    );
    assert.equal(db.listMessageHistory().length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

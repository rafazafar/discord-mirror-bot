const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const SCHEMA_VERSION = 2;
const VALID_STATUSES = new Set(['scheduled', 'sending', 'paused', 'sent', 'failed', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

function assertStatus(status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid scheduled message status: ${status}`);
  }
}

function toDbUpdates(updates) {
  const fields = {};

  if (Object.hasOwn(updates, 'channelAlias')) fields.channel_alias = updates.channelAlias;
  if (Object.hasOwn(updates, 'content')) fields.content = updates.content;
  if (Object.hasOwn(updates, 'sendAt')) fields.send_at = updates.sendAt;
  if (Object.hasOwn(updates, 'status')) {
    assertStatus(updates.status);
    fields.status = updates.status;
  }
  if (Object.hasOwn(updates, 'lastError')) fields.last_error = updates.lastError;

  return fields;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(tableName));
}

function createCurrentSchema(db) {
  db.exec(`
    create table if not exists channel_aliases (
      alias text primary key,
      channel_id text not null,
      guild_id text,
      guild_name text,
      channel_name text,
      created_at text,
      updated_at text
    );

    create table if not exists scheduled_messages (
      id integer primary key autoincrement,
      channel_alias text not null,
      content text not null,
      send_at text not null,
      status text not null,
      created_at text,
      updated_at text,
      last_error text,
      foreign key (channel_alias) references channel_aliases(alias)
    );

    create table if not exists message_history (
      id integer primary key autoincrement,
      scheduled_message_id integer,
      channel_alias text not null,
      channel_id text not null,
      content text not null,
      status text not null,
      discord_message_id text,
      error text,
      sent_at text not null,
      foreign key (scheduled_message_id) references scheduled_messages(id) on delete set null
    );
  `);
}

function migrateToCurrentSchema(db) {
  const scheduledExists = tableExists(db, 'scheduled_messages');
  const historyExists = tableExists(db, 'message_history');

  db.pragma('foreign_keys = OFF');
  db.exec('begin');

  try {
    if (historyExists) {
      db.exec('alter table message_history rename to message_history_old');
    }
    if (scheduledExists) {
      db.exec('alter table scheduled_messages rename to scheduled_messages_old');
    }

    createCurrentSchema(db);

    if (scheduledExists) {
      db.exec(`
        insert into scheduled_messages (id, channel_alias, content, send_at, status, created_at, updated_at, last_error)
        select sm.id, sm.channel_alias, sm.content, sm.send_at, sm.status, sm.created_at, sm.updated_at, sm.last_error
        from scheduled_messages_old sm
        join channel_aliases ca on ca.alias = sm.channel_alias
      `);
      db.exec('drop table scheduled_messages_old');
    }

    if (historyExists) {
      db.exec(`
        insert into message_history (
          id, scheduled_message_id, channel_alias, channel_id, content, status, discord_message_id, error, sent_at
        )
        select mh.id, mh.scheduled_message_id, mh.channel_alias, mh.channel_id, mh.content, mh.status,
          mh.discord_message_id, mh.error, mh.sent_at
        from message_history_old mh
        where mh.scheduled_message_id is null
          or exists (select 1 from scheduled_messages sm where sm.id = mh.scheduled_message_id)
      `);
      db.exec('drop table message_history_old');
    }

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function initializeSchema(db) {
  if (db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) {
    migrateToCurrentSchema(db);
    return;
  }

  createCurrentSchema(db);
}

function createSchedulerDb(sqlitePath) {
  if (sqlitePath !== ':memory:') {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  }

  const db = new Database(sqlitePath);
  initializeSchema(db);
  db.pragma('foreign_keys = ON');

  function getScheduledMessage(id) {
    return db.prepare('select * from scheduled_messages where id = ?').get(id);
  }

  function updateScheduledMessage(id, updates) {
    const fields = toDbUpdates(updates);
    fields.updated_at = nowIso();
    const entries = Object.entries(fields);

    if (entries.length > 0) {
      db.prepare(`update scheduled_messages set ${entries.map(([key]) => `${key} = ?`).join(', ')} where id = ?`)
        .run(...entries.map(([, value]) => value), id);
    }

    return getScheduledMessage(id);
  }

  function insertHistory({ id, channelAlias, channelId, content, status, discordMessageId = null, error = null }) {
    assertStatus(status);
    db.prepare(`
      insert into message_history (
        scheduled_message_id, channel_alias, channel_id, content, status, discord_message_id, error, sent_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, channelAlias, channelId, content, status, discordMessageId, error, nowIso());
  }

  function assertScheduledMessageExists(id) {
    if (!getScheduledMessage(id)) {
      throw new Error('Scheduled message not found');
    }
  }

  function assertScheduledMessageSending(id) {
    const message = getScheduledMessage(id);
    if (!message) {
      throw new Error('Scheduled message not found');
    }
    if (message.status !== 'sending') {
      throw new Error('Scheduled message is not sending');
    }
  }

  return {
    close() {
      db.close();
    },

    getChannelAlias(alias) {
      return db.prepare('select * from channel_aliases where alias = ?').get(alias);
    },

    listChannelAliases() {
      return db.prepare('select * from channel_aliases order by alias').all();
    },

    upsertChannelAlias({ alias, channelId, guildId = null, guildName = null, channelName = null }) {
      const timestamp = nowIso();
      db.prepare(`
        insert into channel_aliases (
          alias, channel_id, guild_id, guild_name, channel_name, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(alias) do update set
          channel_id = excluded.channel_id,
          guild_id = excluded.guild_id,
          guild_name = excluded.guild_name,
          channel_name = excluded.channel_name,
          updated_at = excluded.updated_at
      `).run(alias, channelId, guildId, guildName, channelName, timestamp, timestamp);

      return this.getChannelAlias(alias);
    },

    deleteChannelAlias(alias) {
      return db.prepare('delete from channel_aliases where alias = ?').run(alias).changes > 0;
    },

    getScheduledMessage,

    listScheduledMessages() {
      return db.prepare('select * from scheduled_messages order by send_at, id').all();
    },

    createScheduledMessage({ channelAlias, content, sendAt }) {
      const timestamp = nowIso();
      const result = db.prepare(`
        insert into scheduled_messages (
          channel_alias, content, send_at, status, created_at, updated_at, last_error
        ) values (?, ?, ?, 'scheduled', ?, ?, null)
      `).run(channelAlias, content, sendAt, timestamp, timestamp);

      return getScheduledMessage(result.lastInsertRowid);
    },

    updateScheduledMessage,

    deleteScheduledMessage(id) {
      return db.prepare('delete from scheduled_messages where id = ?').run(id).changes > 0;
    },

    listDueScheduledMessages(now) {
      const dueAt = now instanceof Date ? now.toISOString() : now;
      return db.prepare(`
        select * from scheduled_messages
        where status = 'scheduled' and send_at <= ?
        order by send_at, id
      `).all(dueAt);
    },

    claimScheduledMessage(id) {
      const result = db.prepare(`
        update scheduled_messages
        set status = 'sending', updated_at = ?
        where id = ? and status = 'scheduled'
      `).run(nowIso(), id);

      if (result.changes === 0) return null;

      const message = getScheduledMessage(id);
      return message.status === 'sending' ? message : null;
    },

    recoverStaleSendingMessages({ olderThan }) {
      const staleAt = olderThan instanceof Date ? olderThan.toISOString() : olderThan;
      const tx = db.transaction(() => {
        const staleMessages = db.prepare(`
          select sm.id, sm.channel_alias, ca.channel_id, sm.content
          from scheduled_messages sm
          join channel_aliases ca on ca.alias = sm.channel_alias
          where sm.status = 'sending' and sm.updated_at <= ?
          order by sm.updated_at, sm.id
        `).all(staleAt);

        if (staleMessages.length === 0) return [];

        const recoveredAt = nowIso();
        db.prepare(`
          update scheduled_messages
          set status = 'failed', last_error = ?, updated_at = ?
          where status = 'sending' and updated_at <= ?
        `).run('Scheduler interrupted while sending', recoveredAt, staleAt);

        const insertRecoveredHistory = db.prepare(`
          insert into message_history (
            scheduled_message_id, channel_alias, channel_id, content, status, discord_message_id, error, sent_at
          ) values (?, ?, ?, ?, 'failed', null, ?, ?)
        `);
        for (const message of staleMessages) {
          insertRecoveredHistory.run(
            message.id,
            message.channel_alias,
            message.channel_id,
            message.content,
            'Scheduler interrupted while sending',
            recoveredAt
          );
        }

        return staleMessages
          .map((message) => getScheduledMessage(message.id))
          .filter((message) => message.status === 'failed' && message.last_error === 'Scheduler interrupted while sending');
      });

      return tx();
    },

    listMessageHistory() {
      return db.prepare('select * from message_history order by id').all();
    },

    markScheduledMessageSent({ id, channelAlias, channelId, content, discordMessageId }) {
      const tx = db.transaction(() => {
        assertScheduledMessageSending(id);
        updateScheduledMessage(id, { status: 'sent', lastError: null });
        insertHistory({ id, channelAlias, channelId, content, status: 'sent', discordMessageId });
      });
      tx();
      return getScheduledMessage(id);
    },

    markScheduledMessageFailed({ id, channelAlias, channelId, content, error }) {
      const tx = db.transaction(() => {
        assertScheduledMessageSending(id);
        updateScheduledMessage(id, { status: 'failed', lastError: error });
        insertHistory({ id, channelAlias, channelId, content, status: 'failed', error });
      });
      tx();
      return getScheduledMessage(id);
    },
  };
}

module.exports = { createSchedulerDb };

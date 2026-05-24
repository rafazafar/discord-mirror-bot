const express = require('express');

const SEND_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const TEXT_CHANNEL_TYPES = new Set([0, 5, '0', '5', 'GUILD_TEXT', 'GUILD_NEWS', 'GuildText', 'GuildAnnouncement']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function errorResponse(res, status, message) {
  return res.status(status).json({ error: message });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validateAlias(alias) {
  return typeof alias === 'string' && alias.length > 0 && !/\s/.test(alias);
}

function normalizeSendAt(sendAt) {
  if (typeof sendAt !== 'string' || !SEND_AT_PATTERN.test(sendAt)) {
    throw new Error('sendAt must be a valid ISO timestamp with Z or offset');
  }

  const date = new Date(sendAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error('sendAt must be a valid ISO timestamp with Z or offset');
  }

  if (date.getTime() <= Date.now()) {
    throw new Error('sendAt must be in the future');
  }

  return date.toISOString();
}

function isTextLikeChannel(channel) {
  return channel && channel.guild && channel.viewable !== false && TEXT_CHANNEL_TYPES.has(channel.type);
}

function channelSummary(channel) {
  return {
    guildId: channel.guild.id,
    guildName: channel.guild.name,
    channelId: channel.id,
    channelName: channel.name,
  };
}

function uniqueChannelsFromCache(cache, channelsById) {
  if (!cache || typeof cache.values !== 'function') return;

  for (const channel of cache.values()) {
    if (isTextLikeChannel(channel)) channelsById.set(channel.id, channel);
  }
}

function discoverChannels(client) {
  const channelsById = new Map();

  if (client?.guilds?.cache && typeof client.guilds.cache.values === 'function') {
    for (const guild of client.guilds.cache.values()) {
      uniqueChannelsFromCache(guild.channels?.cache, channelsById);
    }
  }

  uniqueChannelsFromCache(client?.channels?.cache, channelsById);

  return [...channelsById.values()].map(channelSummary);
}

async function channelMetadata(client, channelId) {
  const channel = await client?.channels?.fetch?.(channelId);
  if (!isTextLikeChannel(channel)) {
    throw new Error('channelId must resolve to a visible guild text channel');
  }

  return {
    channelId,
    guildId: channel?.guild?.id ?? null,
    guildName: channel?.guild?.name ?? null,
    channelName: channel?.name ?? null,
  };
}

function validateAliasPayload(alias, channelId) {
  if (!validateAlias(alias)) {
    throw new Error('Alias must be a non-empty string without whitespace');
  }
  if (typeof channelId !== 'string' || channelId.length === 0) {
    throw new Error('channelId is required');
  }
}

function requireBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object');
  }

  return body;
}

function parseScheduledMessageId(id) {
  if (!/^\d+$/.test(id)) {
    throw new Error('Scheduled message id must be an integer');
  }

  return Number(id);
}

function validateCreateScheduledMessage(db, body) {
  body = requireBodyObject(body);

  if (!db.getChannelAlias(body.channelAlias)) {
    throw new Error('channelAlias not found');
  }
  if (typeof body.content !== 'string' || body.content.length === 0) {
    throw new Error('content must be a non-empty string');
  }

  return {
    channelAlias: body.channelAlias,
    content: body.content,
    sendAt: normalizeSendAt(body.sendAt),
  };
}

function assertAllowedStatusTransition(current, next, hasFutureSendAt) {
  if (!next || next === current) return;

  const allowed =
    (current === 'scheduled' && (next === 'paused' || next === 'cancelled')) ||
    (current === 'paused' && (next === 'scheduled' || next === 'cancelled')) ||
    (current === 'failed' && next === 'scheduled' && hasFutureSendAt);

  if (!allowed) {
    throw new Error('Invalid status transition');
  }
}

function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('local API host must be loopback: 127.0.0.1, localhost, or ::1');
  }
}

function buildScheduledMessageUpdates(db, current, body) {
  body = requireBodyObject(body);
  const updates = {};
  const hasFieldMutation = ['channelAlias', 'content', 'sendAt'].some((field) => Object.hasOwn(body, field));

  if (Object.hasOwn(body, 'status')) {
    assertAllowedStatusTransition(current.status, body.status, Object.hasOwn(body, 'sendAt'));
  }

  if (hasFieldMutation && current.status !== 'scheduled' && current.status !== 'paused') {
    const isFailedRetry = current.status === 'failed' && body.status === 'scheduled' && Object.hasOwn(body, 'sendAt') &&
      !Object.hasOwn(body, 'channelAlias') && !Object.hasOwn(body, 'content');
    if (!isFailedRetry) {
      throw new Error('Scheduled message cannot be modified in current status');
    }
  }

  if (Object.hasOwn(body, 'channelAlias')) {
    if (!db.getChannelAlias(body.channelAlias)) {
      throw new Error('channelAlias not found');
    }
    updates.channelAlias = body.channelAlias;
  }
  if (Object.hasOwn(body, 'content')) {
    if (typeof body.content !== 'string' || body.content.length === 0) {
      throw new Error('content must be a non-empty string');
    }
    updates.content = body.content;
  }
  if (Object.hasOwn(body, 'sendAt')) {
    updates.sendAt = normalizeSendAt(body.sendAt);
  }
  if (Object.hasOwn(body, 'status')) {
    updates.status = body.status;
    if (current.status === 'failed' && body.status === 'scheduled') updates.lastError = null;
  }

  return updates;
}

function createLocalApiApp({ db, client }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed') {
      return errorResponse(res, 400, 'Request body must be valid JSON');
    }
    return next(error);
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, db: true, discordReady: Boolean(client?.isReady?.() || client?.readyAt) });
  });

  app.get('/api/channels/discover', (req, res) => {
    res.json(discoverChannels(client));
  });

  app.get('/api/channel-aliases', (req, res) => {
    res.json(db.listChannelAliases());
  });

  app.post('/api/channel-aliases', asyncRoute(async (req, res) => {
    const { alias, channelId } = requireBodyObject(req.body);
    validateAliasPayload(alias, channelId);
    const metadata = await channelMetadata(client, channelId);
    res.status(201).json(db.upsertChannelAlias({ alias, ...metadata }));
  }));

  app.patch('/api/channel-aliases/:alias', asyncRoute(async (req, res) => {
    const { alias } = req.params;
    const { channelId } = requireBodyObject(req.body);
    validateAliasPayload(alias, channelId);
    const metadata = await channelMetadata(client, channelId);
    res.json(db.upsertChannelAlias({ alias, ...metadata }));
  }));

  app.delete('/api/channel-aliases/:alias', (req, res) => {
    if (!validateAlias(req.params.alias)) {
      return errorResponse(res, 400, 'Alias must be a non-empty string without whitespace');
    }
    if (!db.deleteChannelAlias(req.params.alias)) {
      return errorResponse(res, 404, 'Alias not found');
    }
    return res.json({ ok: true });
  });

  app.get('/api/scheduled-messages', (req, res) => {
    res.json(db.listScheduledMessages());
  });

  app.post('/api/scheduled-messages', (req, res) => {
    const payload = validateCreateScheduledMessage(db, req.body);
    res.status(201).json(db.createScheduledMessage(payload));
  });

  app.get('/api/scheduled-messages/:id', (req, res) => {
    const id = parseScheduledMessageId(req.params.id);
    const message = db.getScheduledMessage(id);
    if (!message) return errorResponse(res, 404, 'Scheduled message not found');
    return res.json(message);
  });

  app.patch('/api/scheduled-messages/:id', (req, res) => {
    const id = parseScheduledMessageId(req.params.id);
    const current = db.getScheduledMessage(id);
    if (!current) return errorResponse(res, 404, 'Scheduled message not found');

    const updates = buildScheduledMessageUpdates(db, current, req.body);
    return res.json(db.updateScheduledMessage(id, updates));
  });

  app.delete('/api/scheduled-messages/:id', (req, res) => {
    const id = parseScheduledMessageId(req.params.id);
    if (!db.deleteScheduledMessage(id)) {
      return errorResponse(res, 404, 'Scheduled message not found');
    }
    return res.json({ ok: true });
  });

  app.get('/api/message-history', (req, res) => {
    res.json(db.listMessageHistory());
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return errorResponse(res, 400, error.message || 'Request failed');
  });

  return app;
}

function startLocalApi({ db, client, host, port }) {
  assertLoopbackHost(host);
  return createLocalApiApp({ db, client }).listen(port, host);
}

module.exports = { createLocalApiApp, startLocalApi };

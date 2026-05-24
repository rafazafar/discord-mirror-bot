const DEFAULT_SENDING_STALE_MS = 5 * 60 * 1000;

async function runSchedulerTick({ db, client, now = new Date(), sendingStaleMs = DEFAULT_SENDING_STALE_MS }) {
  const staleCutoff = new Date(now.getTime() - sendingStaleMs);
  db.recoverStaleSendingMessages({ olderThan: staleCutoff, now });
  const dueMessages = db.listDueScheduledMessages(now);

  for (const message of dueMessages) {
    const claimedMessage = db.claimScheduledMessage(message.id);
    if (!claimedMessage) continue;

    const channelAlias = message.channel_alias;
    const alias = db.getChannelAlias(channelAlias);

    if (!alias) {
      db.markScheduledMessageFailed({
        id: message.id,
        channelAlias,
        channelId: 'unknown',
        content: message.content,
        error: `Channel alias not found: ${channelAlias}`,
      });
      continue;
    }

    const channelId = alias.channel_id;
    try {
      const channel = await client.channels.fetch(channelId);
      const sentMessage = await channel.send(message.content);
      db.markScheduledMessageSent({
        id: message.id,
        channelAlias,
        channelId,
        content: message.content,
        discordMessageId: sentMessage.id,
      });
    } catch (error) {
      db.markScheduledMessageFailed({
        id: message.id,
        channelAlias,
        channelId,
        content: message.content,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function startScheduler({ db, client, pollMs }) {
  let activeTick = null;

  async function tick() {
    if (activeTick) return;

    activeTick = (async () => {
      await runSchedulerTick({ db, client });
    })().finally(() => {
      activeTick = null;
    });

    return activeTick;
  }

  const interval = setInterval(() => {
    tick().catch((error) => console.error('Scheduler tick failed:', error));
  }, pollMs);
  tick().catch((error) => console.error('Scheduler tick failed:', error));

  return {
    stop() {
      clearInterval(interval);
      return activeTick || Promise.resolve();
    },
    tick,
  };
}

module.exports = { runSchedulerTick, startScheduler };

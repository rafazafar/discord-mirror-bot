# Selfbot Scheduled Messages Design

## Goal

Add a local-only scheduling API to send one-time Discord messages through the existing selfbot session. The feature is for personal local use and accepts the Discord selfbot ToS risk.

## Scope

In scope:

- Local HTTP API with no authentication, bound to `127.0.0.1` only.
- SQLite persistence.
- Friendly channel aliases backed by exact Discord channel IDs.
- Channel discovery from guild text channels visible to the selfbot account.
- One-time scheduled messages.
- Management actions: create, list, update, pause, resume, cancel/delete.
- Send history for successful and failed attempts.

Out of scope for first version:

- Recurring schedules.
- Remote access or authentication.
- Dashboard UI implementation.
- Webhook-based sending.
- Multi-account sending.

## Architecture

Run the API, scheduler, and Discord selfbot client in the existing `mirror.js` process.

This is the smallest reliable design because the process already owns the logged-in Discord client. Scheduled sends can call `client.channels.fetch(channelId)` and then `channel.send(content)` directly without IPC, token sharing, or a second daemon. PM2 already manages `mirror.js`, so operational complexity stays low.

The main tradeoff is process coupling: an API crash can restart the mirror bot. This is acceptable for local personal use and can be mitigated with small route handlers, centralized error responses, and PM2 restart behavior.

## Components

### Local API

Expose an Express server on `127.0.0.1` using a configurable port, defaulting to `3000`.

Endpoints:

- `GET /api/health`: returns API, DB, and Discord readiness.
- `GET /api/channels/discover`: returns visible guild text channels.
- `GET /api/channel-aliases`: lists saved aliases.
- `POST /api/channel-aliases`: creates alias for a channel.
- `PATCH /api/channel-aliases/:alias`: updates alias metadata or target channel.
- `DELETE /api/channel-aliases/:alias`: deletes alias.
- `GET /api/scheduled-messages`: lists scheduled messages.
- `POST /api/scheduled-messages`: creates one-time scheduled message.
- `GET /api/scheduled-messages/:id`: returns one scheduled message.
- `PATCH /api/scheduled-messages/:id`: updates message, send time, alias, or status.
- `DELETE /api/scheduled-messages/:id`: cancels or deletes a message.
- `GET /api/message-history`: lists send attempts.

The API has no auth by user choice. It must bind only to localhost to avoid accidental LAN exposure.

### Channel Discovery And Aliases

Discovery reads guild channels visible to the selfbot account and returns text-like channels with:

- `guildId`
- `guildName`
- `channelId`
- `channelName`

Discord channel names are not unique, so schedules use friendly aliases while aliases store exact channel IDs. UIs can display `guildName / #channelName` for clarity.

Alias create/update input should accept:

```json
{
  "alias": "work-alerts",
  "channelId": "123456789012345678"
}
```

When possible, the API should enrich alias rows with the current guild/channel names from the Discord client.

### Scheduler

The scheduler starts after Discord `ready` and DB initialization. It polls SQLite every few seconds for rows where:

- `status = 'scheduled'`
- `send_at <= now`

For each due row, it resolves `channel_alias` to `channel_id`, fetches the Discord channel, sends `content` with `channel.send(content)`, records the attempt in history, and marks the scheduled message as `sent` or `failed`.

The scheduler should avoid double-sending if a tick overlaps another tick. First version can use a simple in-process `isSchedulerRunning` guard because there is only one Node process.

## Data Model

### `channel_aliases`

- `alias` text primary key
- `channel_id` text not null
- `guild_id` text
- `guild_name` text
- `channel_name` text
- `created_at` text not null
- `updated_at` text not null

### `scheduled_messages`

- `id` integer primary key autoincrement
- `channel_alias` text not null
- `content` text not null
- `send_at` text not null, ISO-8601 timestamp with explicit offset or `Z`
- `status` text not null, one of `scheduled`, `paused`, `sent`, `failed`, `cancelled`
- `created_at` text not null
- `updated_at` text not null
- `last_error` text

### `message_history`

- `id` integer primary key autoincrement
- `scheduled_message_id` integer
- `channel_alias` text not null
- `channel_id` text not null
- `content` text not null
- `status` text not null, one of `sent`, `failed`
- `discord_message_id` text
- `error` text
- `sent_at` text not null

## API Validation

Reject requests when:

- `alias` is empty or contains whitespace.
- `channelId` is missing.
- `content` is empty.
- `sendAt` is missing, invalid, lacks an explicit timezone offset or `Z`, or is in the past at creation time.
- `channelAlias` does not exist.
- Status transitions are invalid, such as changing `sent` back to `scheduled`.

Allowed first-version status transitions:

- `scheduled -> paused`
- `paused -> scheduled`
- `scheduled -> cancelled`
- `paused -> cancelled`
- `scheduled -> sent`
- `scheduled -> failed`
- `failed -> scheduled` if `send_at` is updated to a future time

## Error Handling

API routes should return JSON errors with stable shape:

```json
{
  "error": "Human-readable message"
}
```

Scheduler send failures should not crash the bot. They should mark the job `failed`, store `last_error`, and write a `message_history` row with status `failed`.

## Configuration

Add optional config values to `config.js` and `config.example.js`:

- `enableLocalApi`: default `true`
- `localApiHost`: default `'127.0.0.1'`
- `localApiPort`: default `3000`
- `schedulerPollMs`: default `5000`
- `sqlitePath`: default `'./data/scheduler.sqlite'`

## Security Notes

This feature intentionally sends as the user's Discord account through selfbot APIs. That can violate Discord ToS and can risk account enforcement. The design minimizes unrelated risk by binding the unauthenticated API to `127.0.0.1` only.

## Testing Plan

- Initialize DB on startup and verify tables exist.
- Smoke test API with `curl`:
  - health
  - discover channels
  - create alias
  - create scheduled message
  - list scheduled messages
  - list history after send attempt
- Verify scheduler sends one due message to a test channel.
- Verify failed channel alias or send error marks job `failed` and records history.

## Future Work

- Local dashboard consuming the API.
- Recurring schedules.
- Dry-run endpoint.
- Message preview with resolved channel alias.
- Optional auth token if API ever binds beyond localhost.

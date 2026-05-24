const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadMirror() {
  delete require.cache[require.resolve('../mirror')];
  return require('../mirror');
}

test('requiring mirror exports pure helpers without runtime side effects', () => {
  const originalLoad = Module._load;
  Module._load = function guardedLoad(request, parent, isMain) {
    if (request === './config.js' || request === './webhookMap.json' || request === 'discord.js-selfbot-v13') {
      throw new Error(`unexpected runtime require: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let mirror;
  try {
    mirror = loadMirror();
  } finally {
    Module._load = originalLoad;
  }
  const { startSchedulerServices, main, loginClient } = mirror;

  assert.equal(typeof startSchedulerServices, 'function');
  assert.equal(typeof main, 'function');
  assert.equal(typeof loginClient, 'function');
});

test('startSchedulerServices starts scheduler and local API with defaults, then cleans up in order', async () => {
  const { startSchedulerServices } = loadMirror();
  const calls = [];
  const db = { close: () => calls.push('db.close') };
  const scheduler = { stop: async () => calls.push('scheduler.stop') };
  const server = { close: (callback) => { calls.push('api.close'); callback(); } };
  const client = { user: { tag: 'bot#0001' } };

  const runtime = startSchedulerServices({
    client,
    config: {},
    createSchedulerDb: (sqlitePath) => {
      calls.push(['db', sqlitePath]);
      return db;
    },
    startScheduler: (options) => {
      calls.push(['scheduler', options.db, options.client, options.pollMs]);
      return scheduler;
    },
    startLocalApi: (options) => {
      calls.push(['api', options.db, options.client, options.host, options.port]);
      return server;
    },
  });

  assert.deepEqual(calls, [
    ['db', './data/scheduler.sqlite'],
    ['scheduler', db, client, 5000],
    ['api', db, client, '127.0.0.1', 3000],
  ]);

  await runtime.cleanup();

  assert.deepEqual(calls.slice(3), ['scheduler.stop', 'api.close', 'db.close']);
});

test('startSchedulerServices skips local API when disabled', () => {
  const { startSchedulerServices } = loadMirror();
  let apiStarted = false;

  const runtime = startSchedulerServices({
    client: {},
    config: { enableLocalApi: false },
    createSchedulerDb: () => ({ close() {} }),
    startScheduler: () => ({ async stop() {} }),
    startLocalApi: () => {
      apiStarted = true;
    },
  });

  assert.equal(apiStarted, false);
  return runtime.cleanup();
});

test('startSchedulerServices cleanup closes DB even when API close fails', async () => {
  const { startSchedulerServices } = loadMirror();
  const calls = [];
  const db = { close: () => calls.push('db.close') };
  const scheduler = { stop: async () => calls.push('scheduler.stop') };
  const server = {
    close: (callback) => {
      calls.push('api.close');
      callback(new Error('close failed'));
    },
  };

  const runtime = startSchedulerServices({
    client: {},
    config: {},
    createSchedulerDb: () => db,
    startScheduler: () => scheduler,
    startLocalApi: () => server,
  });

  await assert.rejects(() => runtime.cleanup(), /close failed/);
  assert.deepEqual(calls, ['scheduler.stop', 'api.close', 'db.close']);
});

test('loginClient logs and exits non-zero when Discord login fails', async () => {
  const { loginClient } = loadMirror();
  const logs = [];
  let exitCode;
  const client = {
    login: async () => {
      throw new Error('bad token');
    },
  };

  await loginClient({
    client,
    token: 'token',
    console: { error: (...args) => logs.push(args) },
    process: { exit: (code) => { exitCode = code; } },
  });

  assert.equal(exitCode, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /Discord login failed/);
  assert.equal(logs[0][1].message, 'bad token');
});

// Runs src/background.js in a sandbox with a fake chrome.* and clock. The
// side-effect imports are replaced by loading those libs into the same global
// first, which is what the browser's module loader does before the body runs.
// The sandbox has no IndexedDB: with the database off, nothing may reach it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const SOURCE = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');
const IMPORTS = /^import '\.\/lib\/(budget|settings|memory|records|db)\.js';\n/gm;
const BODY = SOURCE.replace(IMPORTS, '');
const LIBS = ['budget.js', 'settings.js', 'memory.js', 'records.js', 'db.js'].map((f) => fs.readFileSync(path.join(SRC, 'lib', f), 'utf8'));
const LOOKUPS_ON = { settings: { lookups: true } };

function slot() {
  const listeners = [];
  return { listeners, addListener: (l) => listeners.push(l) };
}

function fakeArea(initial = {}) {
  const data = new Map(Object.entries(initial));
  const onChanged = slot();
  const stats = { getAll: 0 };
  return {
    data, stats, onChanged,
    async get(keys) {
      if (keys === null) {
        stats.getAll += 1;
        return Object.fromEntries(data);
      }
      return Object.fromEntries([].concat(keys).filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async getKeys() { return [...data.keys()]; },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data.get(k), newValue: v };
        data.set(k, structuredClone(v));
      }
      onChanged.listeners.forEach((l) => l(changes));
    },
    async remove(keys) { [].concat(keys).forEach((k) => data.delete(k)); },
  };
}

function loadWorker({ local = {}, session = fakeArea(), now = 1_000_000 } = {}) {
  const badge = [];
  const chrome = {
    storage: { local: fakeArea(local), session },
    runtime: { onMessage: slot(), onStartup: slot(), onInstalled: slot() },
    action: {
      setBadgeText: (d) => badge.push({ text: d.text, tabId: d.tabId }),
      setBadgeBackgroundColor: (d) => badge.push({ color: d.color, tabId: d.tabId }),
    },
  };
  const clock = { now };
  const context = vm.createContext({ chrome, Date: { now: () => clock.now } });
  for (const lib of LIBS) vm.runInContext(lib, context);
  vm.runInContext(BODY, context, { filename: 'background.js' });

  // Resolves with the reply, cloned as Chrome's messaging does, or with
  // 'no reply' when the listener declines.
  const send = (msg, sender = { tab: { id: 7 } }) => new Promise((resolve) => {
    if (!chrome.runtime.onMessage.listeners[0](msg, sender, (r) => resolve(structuredClone(r)))) resolve('no reply');
  });
  const state = () => session.data.get('budget');
  const fail = () => send({ type: 'report', result: { ok: false, status: 403 } });
  return { chrome, clock, badge, send, state, fail };
}

const cacheOf = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c:user${i}`, { c: 'Spain', a: true, k: 'unverified', t: i }]));

test('imports only its five libs, registers every listener at load, holds no timer (Req 9.3, 9.5)', () => {
  assert.equal(SOURCE.match(IMPORTS).length, 5);
  assert.doesNotMatch(BODY, /^\s*import\b/m);
  assert.doesNotMatch(SOURCE, /set(Timeout|Interval)/);
  const { chrome } = loadWorker();
  for (const s of [chrome.runtime.onMessage, chrome.runtime.onStartup, chrome.runtime.onInstalled, chrome.storage.local.onChanged]) {
    assert.equal(s.listeners.length, 1);
  }
});

test('permit: refused as disabled while lookups are off, the install default (Req 3.6, 3.9)', async () => {
  const w = loadWorker();
  assert.deepEqual(await w.send({ type: 'permit', handle: 'ivan' }), { grant: false, reason: 'disabled', retryAt: null });
});

test('permit: grants 2 s apart, and the state survives the worker sleeping (Req 3.5)', async () => {
  const w = loadWorker({ local: LOOKUPS_ON });
  assert.deepEqual(await w.send({ type: 'permit', handle: 'ivan' }), { grant: true });
  assert.deepEqual(await w.send({ type: 'permit', handle: 'olga' }), { grant: false, reason: 'gap', retryAt: 1_002_000 });

  const woken = loadWorker({ local: LOOKUPS_ON, session: w.chrome.storage.session, now: 1_002_000 });
  assert.deepEqual(await woken.send({ type: 'permit', handle: 'ivan' }), { grant: false, reason: 'inflight', retryAt: 1_030_000 });
  assert.deepEqual(await woken.send({ type: 'permit', handle: 'olga' }), { grant: true });
  assert.deepEqual(woken.state().grants, [1_000_000, 1_002_000]);
});

test('permit: two tabs asking at once get one grant between them (Req 3.1)', async () => {
  const w = loadWorker({ local: LOOKUPS_ON });
  const answers = await Promise.all([
    w.send({ type: 'permit', handle: 'ivan' }, { tab: { id: 1 } }),
    w.send({ type: 'permit', handle: 'olga' }, { tab: { id: 2 } }),
  ]);
  assert.deepEqual(answers.map((a) => a.grant).sort(), [false, true]);
});

test('permit: a missing handle is an error, and the next op still runs', async () => {
  const w = loadWorker({ local: LOOKUPS_ON });
  assert.deepEqual(await w.send({ type: 'permit' }), { error: 'permit needs a handle' });
  assert.deepEqual(await w.send({ type: 'permit', handle: 'ivan' }), { grant: true });
});

test('report: 3 failures stop lookups for the session and paint "!" on red (Req 7.1)', async () => {
  const w = loadWorker({ local: LOOKUPS_ON });
  assert.deepEqual(await w.fail(), { stopped: false });
  assert.deepEqual(await w.fail(), { stopped: false });
  assert.deepEqual(w.badge, []);
  assert.deepEqual(await w.fail(), { stopped: true });
  assert.deepEqual(w.badge, [{ text: '!', tabId: undefined }, { color: '#d93025', tabId: undefined }]);
  assert.equal((await w.send({ type: 'permit', handle: 'ivan' })).reason, 'stopped');
});

test('report: a 429 cools down until X\'s reset, with no failure and no badge (Req 3.4)', async () => {
  const w = loadWorker({ local: LOOKUPS_ON });
  assert.deepEqual(await w.send({ type: 'report', result: { ok: false, status: 429, rateLimit: { reset: 1_500 } } }), { stopped: false });
  assert.equal(w.state().failures, 0);
  assert.deepEqual(w.badge, []);
  assert.deepEqual(await w.send({ type: 'permit', handle: 'ivan' }), { grant: false, reason: 'cooldown', retryAt: 1_500_000 });
});

test('pause on or off clears a stop and the badge; any other write leaves it', async () => {
  const w = loadWorker({ local: LOOKUPS_ON });
  await w.fail(); await w.fail(); await w.fail();
  w.badge.length = 0;

  await w.chrome.storage.local.set({ 'c:ivan': { c: 'Russia', a: true, k: 'unverified', t: 1 } });
  await w.chrome.storage.local.set({ settings: { lookups: true, budget: 30 } });
  assert.equal((await w.send({ type: 'permit', handle: 'ivan' })).reason, 'stopped');

  await w.chrome.storage.local.set({ settings: { lookups: true, paused: true } });
  assert.equal((await w.send({ type: 'permit', handle: 'ivan' })).reason, 'paused');
  assert.deepEqual(w.badge, [{ text: '', tabId: undefined }]);
  assert.equal(w.state().failures, 0);

  await w.chrome.storage.local.set({ settings: { lookups: true, paused: false } });
  assert.deepEqual(await w.send({ type: 'permit', handle: 'ivan' }), { grant: true });
  assert.equal(w.badge.length, 1); // nothing to clear the second time
});

test('layout: "?" on the reporting tab only, then back to the global badge', async () => {
  const w = loadWorker();
  assert.deepEqual(await w.send({ type: 'layout', known: false }, { tab: { id: 3 } }), {});
  assert.deepEqual(await w.send({ type: 'layout', known: true }, { tab: { id: 3 } }), {});
  assert.deepEqual(w.badge, [{ text: '?', tabId: 3 }, { color: '#b06000', tabId: 3 }, { text: null, tabId: 3 }]);
  assert.deepEqual(await w.send({ type: 'layout', known: false }, {}), { error: 'layout must come from a tab' });
});

test('startup: prunes the cache to 50,000, oldest first, other keys untouched', async () => {
  const w = loadWorker({ local: { ...cacheOf(50_003), ...LOOKUPS_ON, 'qid:legacy': 'Q' } });
  await w.chrome.runtime.onStartup.listeners[0]();
  const keys = [...w.chrome.storage.local.data.keys()];
  assert.equal(keys.filter((k) => k.startsWith('c:')).length, 50_000);
  assert.ok(!keys.includes('c:user0') && !keys.includes('c:user2'));
  assert.ok(keys.includes('c:user3') && keys.includes('settings') && keys.includes('qid:legacy'));
});

test('startup: a cache at the cap is counted, never loaded', async () => {
  const w = loadWorker({ local: cacheOf(50_000) });
  await w.chrome.runtime.onInstalled.listeners[0]();
  assert.equal(w.chrome.storage.local.stats.getAll, 0);
  assert.equal(w.chrome.storage.local.data.size, 50_000);
});

test('prune: a quota error drops the oldest 20% of the cache', async () => {
  const w = loadWorker({ local: { ...cacheOf(10), ...LOOKUPS_ON } });
  assert.deepEqual(await w.send({ type: 'prune' }), { removed: 2 });
  const keys = [...w.chrome.storage.local.data.keys()];
  assert.deepEqual(keys.filter((k) => k.startsWith('c:')), ['c:user2', 'c:user3', 'c:user4', 'c:user5', 'c:user6', 'c:user7', 'c:user8', 'c:user9']);
  assert.ok(keys.includes('settings'));
});

test('unknown or inherited message types get no reply', async () => {
  const w = loadWorker();
  assert.equal(await w.send({ type: 'block', handle: 'ivan' }), 'no reply');
  assert.equal(await w.send({ type: 'toString' }), 'no reply');
  assert.equal(await w.send(null), 'no reply');
});

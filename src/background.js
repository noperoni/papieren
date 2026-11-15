// Service worker (ES module): owns the lookup budget, the toolbar badge and,
// with the database switched on, its IndexedDB (database design).
// The libs register themselves on globalThis.Papieren as a side effect;
// memory.js before records.js, which reads it.
import './lib/budget.js';
import './lib/settings.js';
import './lib/memory.js';
import './lib/records.js';
import './lib/db.js';

const { budget, settings, records, db } = globalThis.Papieren;

const STATE_KEY = 'budget';      // chrome.storage.session: cleared with the browser session (Req 7.1)
const DB_ERROR = 'dbError';      // chrome.storage.session: why the database failed (database Req 7.2)
const DB_EPOCH = 'dbEpoch';      // chrome.storage.local: when behaviour rows were last deleted, read by content.js
const CACHE_PREFIX = 'c:';       // chrome.storage.local cache entries, see design "Cache entry"
const CACHE_MAX = 50000;
const QUOTA_KEEP = 0.8;          // a quota error drops the oldest 20%
const RED = '#d93025';
const AMBER = '#b06000';
const OFF = { error: 'off' };
const FLUSH_STORES = ['memory', 'history', 'stats', 'flags'];
const CLEAR = { memory: ['memory', 'flags'], history: ['history'], stats: ['stats'] }; // flags derive from memory

// Two tabs can ask at once and every op is read-modify-write on session
// storage, so ops run one after another. A failed op does not block the next.
let tail = Promise.resolve();
function serial(fn) {
  const run = tail.then(fn);
  tail = run.catch(() => {});
  return run;
}

const loadState = async () => (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? budget.initial();
const saveState = (state) => chrome.storage.session.set({ [STATE_KEY]: state });

// The global badge carries only "stopped". "?" is per tab, see layout().
function paintStopped(stopped) {
  chrome.action.setBadgeText({ text: stopped ? '!' : '' });
  if (stopped) chrome.action.setBadgeBackgroundColor({ color: RED });
}

// Deletes the cache entries drop(entry, i, n) picks: i counts from the
// oldest fetch time `t`, n is the number of entries.
async function pruneCache(drop) {
  const entries = Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith(CACHE_PREFIX));
  entries.sort(([, a], [, b]) => (a?.t ?? 0) - (b?.t ?? 0));
  const keys = entries.filter(([, e], i) => drop(e, i, entries.length)).map(([k]) => k);
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

// --- Database (database design): dormant while settings.db.on is false ---

const dbSettings = async () => settings.normalize((await chrome.storage.local.get('settings')).settings).db;

// Short, for the popup's status line: a DOMException's name, else the message.
const reasonOf = (e) => String((typeof DOMException === 'function' && e instanceof DOMException ? e.name : e?.message) ?? e).slice(0, 80);

// The gate of every db-* handler but db-off. The switch is read first, so a
// late flush writes nothing and IndexedDB never opens while off. A failure
// this session answers again; a new one is kept in dbError (Req 7.2).
async function withDb(fn) {
  const conf = await dbSettings();
  if (!conf.on) return OFF;
  const known = (await chrome.storage.session.get(DB_ERROR))[DB_ERROR];
  if (known) return { error: known };
  try {
    return await fn(conf);
  } catch (e) {
    const error = reasonOf(e);
    await chrome.storage.session.set({ [DB_ERROR]: error });
    return { error };
  }
}

const collect = async (t, store, index, range) => {
  const out = [];
  await db.each(t, store, index, range, (v) => { out.push(v); });
  return out;
};

// Recounts one flag from its memory rows, then writes or deletes its flags
// row. Resolves with the row, n 0 when deleted.
async function recount(t, kind, key, now) {
  const r = records.flagRange(kind, key, now);
  const flag = records.flagFor(kind, await collect(t, 'memory', r.index, IDBKeyRange.bound(r.lower, r.upper)), now);
  if (!flag) {
    await db.deleteWhere(t, 'flags', null, [kind, key]);
    return { kind, key, n: 0 };
  }
  const row = { kind, key, ...flag, t: now };
  await db.put(t, 'flags', row);
  return row;
}

// One readwrite transaction (design, Worker messages): rows, reveal marks,
// stats increments, then the touched flags in memory.js's Flags shape.
const writeFlush = (rows, now) => db.tx(FLUSH_STORES, 'readwrite', async (t) => {
  const [olds, seen] = await Promise.all([
    Promise.all(rows.memory.map((r) => db.get(t, 'memory', [r.kind, r.key, r.author]))),
    Promise.all(rows.history.map((h) => db.get(t, 'history', [h.day, h.tweet]))),
  ]);
  // Another tab may have stored a newer sighting; a tweet's history row for the day stays the first.
  await Promise.all([
    ...rows.memory.map((r, i) => db.put(t, 'memory', records.keepRow(olds[i], r))),
    ...rows.history.filter((_, i) => !seen[i]).map((h) => db.put(t, 'history', h)),
  ]);
  await Promise.all(rows.revealed.map(async (tweet) => {
    const target = records.revealTarget(await collect(t, 'history', 'tweet', IDBKeyRange.only(tweet)), rows.day);
    if (target && !target.revealed) await db.put(t, 'history', { ...target, revealed: true });
  }));
  await Promise.all(rows.stats.map(async (s) => {
    const old = await db.get(t, 'stats', [rows.day, s.rule]);
    await db.put(t, 'stats', { day: rows.day, rule: s.rule, judged: (old?.judged ?? 0) + s.judged, hid: (old?.hid ?? 0) + s.hid });
  }));
  const touched = await Promise.all(records.flagKeys(rows.memory).map(({ kind, key }) => recount(t, kind, key, now)));
  return records.toFlags(touched);
});

// QuotaExceeded sweeps once and retries once; a second failure is the gate's.
async function flush(rows, conf, now) {
  try {
    return await writeFlush(rows, now);
  } catch (e) {
    if (e?.name !== 'QuotaExceededError') throw e;
    await sweep(conf, now);
    return writeFlush(rows, now);
  }
}

// Every tab judges on its own copy of the flags and its own sightings, so
// rows deleted here would go on hiding posts there until F5. Bumping
// dbEpoch has every x.com tab drop both and ask for the flags again.
const dropTabState = (now) => chrome.storage.local.set({ [DB_EPOCH]: now });

// Sweep (database design): Retention per store and for the c: cache, the
// size cap, the flag recount, then meta.lastSweep. Tabs drop their state
// when memory rows or flags changed.
async function sweep(conf, now) {
  const cut = records.cutoffs(conf.keep, now);
  const before = (v) => IDBKeyRange.upperBound(v, true);
  let memoryRows = 0;
  await db.tx(['memory', 'history', 'stats'], 'readwrite', async (t) => {
    memoryRows = await db.count(t, 'memory');
    await Promise.all([
      db.deleteWhere(t, 'memory', 't', before(cut.memory)),
      db.deleteWhere(t, 'history', 't', before(cut.history)),
      db.deleteWhere(t, 'stats', 'day', before(cut.stats)),
    ]);
  });
  await pruneCache((e) => !(e?.t >= cut.cache));
  let usage = 0;
  try {
    usage = (await navigator.storage.estimate()).usage ?? 0;
  } catch {
    // no estimate: no size cap this round
  }
  const share = records.capShare(usage);
  let changed = false;
  await db.tx(['memory', 'history', 'flags', 'meta'], 'readwrite', async (t) => {
    // One round: the oldest share of each store by t (Req 2.5).
    if (share > 0) {
      await Promise.all(['history', 'memory'].map(async (store) => {
        let left = Math.ceil((await db.count(t, store)) * share);
        await db.each(t, store, 't', null, (_, c) => {
          if (left-- <= 0) return false;
          c.delete();
        });
      }));
    }
    // After the deletions, so no flag outlives its rows.
    const old = await collect(t, 'flags');
    const next = await Promise.all(old.map((f) => recount(t, f.kind, f.key, now)));
    changed = (await db.count(t, 'memory')) !== memoryRows || next.some((f, i) => f.n !== old[i].n || f.first !== old[i].first);
    await db.put(t, 'meta', now, 'lastSweep');
  });
  if (changed) await dropTabState(now);
}

async function sweepDue(now) {
  const last = await db.tx(['meta'], 'readonly', (t) => db.get(t, 'meta', 'lastSweep'));
  return !(now - last < records.DAY_MS); // never swept is due
}

// Counts keys first, so a cache under the cap is never loaded into the
// worker. With the database on, a sweep.
async function startup() {
  const count = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(CACHE_PREFIX)).length;
  if (count > CACHE_MAX) await serial(() => pruneCache((e, i, n) => i < n - CACHE_MAX));
  await serial(() => withDb((conf) => sweep(conf, Date.now())));
}

const handlers = {
  // { handle } -> Permit (Req 3.1, 3.5, 3.9)
  permit: (msg) => serial(async () => {
    if (typeof msg.handle !== 'string' || !msg.handle) throw new Error('permit needs a handle');
    const [state, stored] = await Promise.all([loadState(), chrome.storage.local.get('settings')]);
    const out = budget.permit(state, msg.handle, Date.now(), settings.normalize(stored.settings));
    await saveState(out.state);
    return out.permit;
  }),

  // { result: { ok, status, rateLimit? } } -> { stopped } (Req 3.4, 7.1)
  report: (msg) => serial(async () => {
    const r = msg.result ?? {};
    const prev = await loadState();
    const next = budget.report(prev, { ok: r.ok === true, status: Number(r.status), rateLimit: r.rateLimit }, Date.now());
    await saveState(next);
    if (next.stopped !== prev.stopped) paintStopped(next.stopped);
    return { stopped: next.stopped };
  }),

  // { known } from a tab's content script: "?" on that tab only. A null text
  // drops the tab's own value, so the tab falls back to the global badge.
  layout: async (msg, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) throw new Error('layout must come from a tab');
    chrome.action.setBadgeText({ tabId, text: msg.known ? null : '?' });
    if (!msg.known) chrome.action.setBadgeBackgroundColor({ tabId, color: AMBER });
    return {};
  },

  // A content script's cache write hit the quota: it retries once after this.
  prune: () => serial(async () => ({ removed: await pruneCache((e, i, n) => i < n - Math.floor(n * QUOTA_KEEP)) })),

  // { day, memory, history, revealed, stats } from a tab -> { flags } for the keys it touched
  'db-flush': (msg) => serial(() => withDb(async (conf) => {
    const now = Date.now();
    if (await sweepDue(now)) await sweep(conf, now);
    return { flags: await flush(records.parseFlush(msg, now), conf, now) };
  })),

  // At a tab's boot -> { flags }, every flags row. A Reply_Everywhere flag
  // is recounted first: its 24 h window slides between sweeps, and a stale
  // one would hide its Author under a false label until the next flush.
  'db-flags': () => serial(() => withDb(async () => {
    const now = Date.now();
    const rows = await db.tx(['flags', 'memory'], 'readwrite', async (t) =>
      Promise.all((await collect(t, 'flags')).map((f) => (f.kind === 'conv' ? recount(t, f.kind, f.key, now) : f))));
    return { flags: records.toFlags(rows) };
  })),

  // { kind } from the popup's "Delete all" (Req 2.4). The cache lives in storage.local.
  'db-clear': (msg) => serial(async () => {
    if (msg.kind === 'cache') return (await dbSettings()).on ? { removed: await pruneCache(() => true) } : OFF;
    if (!Object.hasOwn(CLEAR, msg.kind)) throw new Error('db-clear needs a kind');
    return withDb(async () => {
      await db.clear(CLEAR[msg.kind]);
      if (CLEAR[msg.kind].includes('flags')) await dropTabState(Date.now());
      return {};
    });
  }),

  // Popup open, and before an export.
  'db-sweep': () => serial(() => withDb(async (conf) => {
    await sweep(conf, Date.now());
    return {};
  })),

  // After the popup's confirmation, db.on already false, so no switch check.
  // Deletes the database; the c: cache stays (Req 1.5). The settings change
  // has already queued the same drop (below): this one answers the popup.
  'db-off': () => serial(async () => {
    await db.drop();
    return {};
  }),
};

// Every listener is registered synchronously at top level, so an event that
// wakes the worker finds it. Nothing here holds a timer (Req 9.3, 9.5).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = Object.hasOwn(handlers, msg?.type) ? handlers[msg.type] : null;
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});

// Any settings change clears dbError, so the next db-* message tries again
// (database Req 7.2). Turning pause on or off clears a stop (design: background.js).
chrome.storage.local.onChanged.addListener((changes) => {
  const c = changes.settings;
  if (!c) return;
  serial(() => chrome.storage.session.remove(DB_ERROR));
  // On to off deletes the database here as well, so a popup closed before
  // its db-off message still leaves none behind (database Req 1.5).
  if (c.oldValue?.db?.on === true && c.newValue?.db?.on !== true) serial(() => db.drop());
  if ((c.oldValue?.paused === true) === (c.newValue?.paused === true)) return;
  serial(async () => {
    const state = await loadState();
    if (!state.stopped && !state.failures) return;
    await saveState({ ...state, stopped: false, failures: 0 });
    paintStopped(false);
  });
});

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);

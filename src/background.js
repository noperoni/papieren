// Service worker (ES module): owns the lookup budget and the toolbar badge.
// The libs register themselves on globalThis.Papieren as a side effect.
import './lib/budget.js';
import './lib/settings.js';

const { budget, settings } = globalThis.Papieren;

const STATE_KEY = 'budget';      // chrome.storage.session: cleared with the browser session (Req 7.1)
const CACHE_PREFIX = 'c:';       // chrome.storage.local cache entries, see design "Cache entry"
const CACHE_MAX = 50000;
const QUOTA_KEEP = 0.8;          // a quota error drops the oldest 20%
const RED = '#d93025';
const AMBER = '#b06000';

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

// Deletes the oldest cache entries by fetch time `t`, keeping keepFor(count).
async function pruneCache(keepFor) {
  const entries = Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith(CACHE_PREFIX));
  const drop = entries.length - keepFor(entries.length);
  if (drop <= 0) return 0;
  entries.sort(([, a], [, b]) => (a?.t ?? 0) - (b?.t ?? 0));
  await chrome.storage.local.remove(entries.slice(0, drop).map(([k]) => k));
  return drop;
}

// Counts keys first, so a cache under the cap is never loaded into the worker.
async function startup() {
  const count = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(CACHE_PREFIX)).length;
  if (count > CACHE_MAX) await serial(() => pruneCache(() => CACHE_MAX));
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
  prune: () => serial(async () => ({ removed: await pruneCache((n) => Math.floor(n * QUOTA_KEEP)) })),
};

// Every listener is registered synchronously at top level, so an event that
// wakes the worker finds it. Nothing here holds a timer (Req 9.3, 9.5).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = Object.hasOwn(handlers, msg?.type) ? handlers[msg.type] : null;
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});

// Turning pause on or off clears a stop (design: background.js).
chrome.storage.local.onChanged.addListener((changes) => {
  const c = changes.settings;
  if (!c || (c.oldValue?.paused === true) === (c.newValue?.paused === true)) return;
  serial(async () => {
    const state = await loadState();
    if (!state.stopped && !state.failures) return;
    await saveState({ ...state, stopped: false, failures: 0 });
    paintStopped(false);
  });
});

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);

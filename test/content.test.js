// Runs src/content.js in a sandbox: the real libs, a fake adapter over fake
// cells, fake chrome.*, and the page hook played by the test over the same
// DOM events. Covers the paths where a mistake costs the account or the feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const LIBS = ['lib/settings.js', 'lib/rules.js', 'lib/x-parse.js', 'lib/variants.js', 'lib/feed.js'].map(read);
const CONTENT = read('content.js');
const ABOUT = fs.readFileSync(path.join(__dirname, 'fixtures', 'about-legacy.json'), 'utf8');
const RUSSIA = { c: 'Russia', a: true, s: 'Russia', k: 'confirmed', t: Date.now() };
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function fakeCell(tweetId, handle) {
  const cell = {
    post: { tweetId, handle }, dataset: {}, isConnected: true,
    closest: () => (['hidden', 'checking'].includes(cell.dataset.papieren) ? cell : null),
  };
  return cell;
}

function load({ local = {}, cells = [], layout = true, cookie = 'twid=u%3D42; ct0=c', permit = { grant: true }, failSets = 0 } = {}) {
  const data = new Map(Object.entries(local));
  const listeners = [];
  const sent = [];
  const timers = [];
  let failing = failSets;
  const area = {
    data,
    async get() { return Object.fromEntries(data); },
    async set(items) {
      if (failing > 0 && Object.keys(items).some((k) => k.startsWith('c:'))) {
        failing -= 1;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { newValue: structuredClone(v) };
        data.set(k, structuredClone(v));
      }
      listeners.forEach((l) => l(changes));
    },
    async remove(k) { data.delete(k); },
    onChanged: { addListener: (l) => listeners.push(l) },
  };
  const replies = { permit, report: { stopped: false }, prune: { removed: 1 }, layout: {} };
  const onMessage = [];
  const chrome = {
    storage: { local: area },
    runtime: {
      id: 'papieren-test',
      async sendMessage(msg) { sent.push(structuredClone(msg)); return structuredClone(replies[msg.type]); },
      onMessage: { addListener: (l) => onMessage.push(l) },
    },
  };

  const document = new EventTarget();
  Object.assign(document, {
    cookie, readyState: 'complete', hidden: false,
    body: { isConnected: true }, documentElement: { dataset: {} },
    querySelectorAll: () => cells.filter((c) => c.dataset.papieren !== undefined),
  });
  const toPage = [];
  document.addEventListener('papieren:to-page', (e) => toPage.push(JSON.parse(e.detail)));
  const fromPage = (msg) => document.dispatchEvent(new CustomEvent('papieren:from-page', { detail: JSON.stringify(msg) }));

  const observed = { io: null, off: [] };
  class IntersectionObserver {
    constructor(cb) { this.cb = cb; observed.io = this; }
    observe() {}
    unobserve() {}
    disconnect() { observed.off.push('io'); }
  }
  const inView = (cell) => observed.io.cb([{ isIntersecting: true, target: cell }]);

  const location = { pathname: '/home' };
  const context = vm.createContext({
    chrome, document, location, CustomEvent, IntersectionObserver,
    MutationObserver: class { observe() {} disconnect() { observed.off.push('mo'); } },
    AbortController,
    requestAnimationFrame: (fn) => { setImmediate(fn); return 1; },
    setTimeout: (fn, ms) => timers.push(ms), clearTimeout: () => {},
  });
  for (const lib of LIBS) vm.runInContext(lib, context);
  const v = context.Papieren.variants;
  const adapter = {
    ...v.legacy, fallbackQid: 'FALLBACK',
    findCells: () => cells.filter((c) => c.isConnected), cellOf: () => null, readPost: (c) => c.post,
  };
  v.detect = () => (layout ? adapter : null);
  vm.runInContext(CONTENT, context);

  const click = (cell) => {
    const ev = new Event('click');
    Object.defineProperty(ev, 'target', { value: cell });
    document.dispatchEvent(ev);
  };
  const stats = () => new Promise((resolve) => onMessage[0]({ type: 'stats' }, {}, (r) => resolve(structuredClone(r))));
  return { data, sent, timers, toPage, fromPage, inView, location, click, stats, replies, area, document, runtime: chrome.runtime, observed };
}

test('X\'s own About answer is cached with lookups off (Req 3.8)', async () => {
  const t = load();
  await settle();
  t.fromPage({ kind: 'about', handle: 'Ivan_Example', body: ABOUT });
  await settle();
  assert.equal(t.data.get('c:ivan_example').c, 'Russia');
  assert.equal(t.sent.filter((m) => m.type === 'permit').length, 0);
});

test('a query id X uses is stored once', async () => {
  const t = load();
  await settle();
  t.fromPage({ kind: 'qid', variant: 'legacy', qid: 'Q1' });
  t.fromPage({ kind: 'qid', variant: 'legacy', qid: 'Q1' });
  t.fromPage({ kind: 'qid', variant: 'evil', qid: 'Q2' });
  await settle();
  assert.equal(t.data.get('qid:legacy'), 'Q1');
  assert.ok(!t.data.has('qid:evil'));
});

test('a cache write over quota asks the worker to prune, then retries once', async () => {
  const t = load({ failSets: 1 });
  await settle();
  t.fromPage({ kind: 'about', handle: 'Ivan_Example', body: ABOUT });
  await settle();
  assert.deepEqual(t.sent.filter((m) => m.type === 'prune'), [{ type: 'prune' }]);
  assert.equal(t.data.get('c:ivan_example').c, 'Russia');
});

test('malformed bridge messages change nothing', async () => {
  const t = load();
  await settle();
  const size = t.data.size;
  t.fromPage({ kind: 'about', handle: 'x' });
  t.fromPage({ kind: 'lookup-result', reqId: 999, status: 200, body: ABOUT });
  t.fromPage({ kind: 'nonsense' });
  await settle();
  assert.equal(t.data.size, size);
});

test('block mode hides a listed country with its label; a click reveals it until navigation (Req 1.1, 5.1, 5.2)', async () => {
  const cell = fakeCell('1', 'Ivan_Example');
  const t = load({ local: { settings: { countries: ['Russia'] }, 'c:ivan_example': RUSSIA }, cells: [cell] });
  await settle();
  assert.equal(cell.dataset.papieren, 'hidden');
  assert.equal(cell.dataset.papierenLabel, 'Hidden: @Ivan_Example · Russia · confirmed (click to show)');
  assert.deepEqual(await t.stats(), { layout: 'legacy', byCountry: { Russia: { n: 1, confirmed: 1, flagged: 0 } } });

  t.click(cell);
  assert.equal(cell.dataset.papieren, 'revealed');
  await t.area.set({ 'c:other': RUSSIA }); // any re-evaluation keeps the reveal
  await settle();
  assert.equal(cell.dataset.papieren, 'revealed');

  t.location.pathname = '/search';
  await t.area.set({ 'c:other2': RUSSIA });
  await settle();
  assert.equal(cell.dataset.papieren, 'hidden');
});

test('a settings change applies live: unlisting the country shows the post (Req 6.2)', async () => {
  const cell = fakeCell('1', 'Ivan_Example');
  const t = load({ local: { settings: { countries: ['Russia'] }, 'c:ivan_example': RUSSIA }, cells: [cell] });
  await settle();
  await t.area.set({ settings: { countries: ['France'] } });
  await settle();
  assert.equal(cell.dataset.papieren, undefined);
});

test('lookups: permit first, one GET through the hook, report, cache, then hidden (Req 3.1, 3.5)', async () => {
  const cell = fakeCell('1', 'Ivan_Example');
  const t = load({ local: { settings: { lookups: true, countries: ['Russia'] }, 'qid:legacy': 'SNIFFED' }, cells: [cell] });
  await settle();
  t.fromPage({ kind: 'ready' });
  t.inView(cell);
  await settle();
  assert.deepEqual(t.sent.filter((m) => m.type === 'permit'), [{ type: 'permit', handle: 'Ivan_Example' }]);
  assert.equal(t.toPage.filter((m) => m.kind === 'lookup').length, 1);
  const ask = t.toPage.find((m) => m.kind === 'lookup');
  assert.match(ask.url, /^https:\/\/x\.com\/i\/api\/graphql\/SNIFFED\/AboutAccountQuery\?/);

  t.fromPage({ kind: 'lookup-result', reqId: ask.reqId, status: 200, rateLimit: { remaining: 30 }, body: ABOUT });
  await settle();
  assert.deepEqual(t.sent.find((m) => m.type === 'report'), { type: 'report', result: { ok: true, status: 200, rateLimit: { remaining: 30 } } });
  assert.equal(t.data.get('c:ivan_example').k, 'confirmed');
  assert.equal(cell.dataset.papieren, 'hidden');
});

// A refusal must park the queue: re-asking at once spins forever, hence the timeout.
test('lookups: no permit, no request; the queue sleeps until the worker\'s retry time', { timeout: 5000 }, async () => {
  const cell = fakeCell('1', 'Ivan_Example');
  const t = load({ local: { settings: { lookups: true, countries: ['Russia'] } }, cells: [cell],
    permit: { grant: false, reason: 'budget', retryAt: Date.now() + 60_000 } });
  await settle();
  t.fromPage({ kind: 'ready' });
  t.inView(cell);
  await settle();
  assert.equal(t.toPage.filter((m) => m.kind === 'lookup').length, 0);
  assert.equal(t.timers.length, 1);
  assert.ok(t.timers[0] > 55_000 && t.timers[0] <= 60_000);
});

test('lookups: nothing is asked while switched off, nor before the hook is ready (Req 3.6)', async () => {
  const off = fakeCell('1', 'Ivan_Example');
  const t1 = load({ local: { settings: { countries: ['Russia'] } }, cells: [off] });
  await settle();
  t1.fromPage({ kind: 'ready' });
  t1.inView(off);
  await settle();
  assert.equal(t1.sent.filter((m) => m.type === 'permit').length, 0);

  const early = fakeCell('1', 'Ivan_Example');
  const t2 = load({ local: { settings: { lookups: true, countries: ['Russia'] } }, cells: [early] });
  await settle();
  t2.inView(early);
  await settle();
  assert.equal(t2.sent.filter((m) => m.type === 'permit').length, 0);
});

test('allowlist: pending is "checking" until the worker says stopped, then shown (Req 2.2, 7.3)', async () => {
  const cell = fakeCell('1', 'Olga');
  const t = load({ local: { settings: { lookups: true, mode: 'allow', countries: ['France'] } }, cells: [cell],
    permit: { grant: false, reason: 'stopped', retryAt: null } });
  await settle();
  assert.equal(cell.dataset.papieren, 'checking');
  t.fromPage({ kind: 'ready' });
  t.inView(cell);
  await settle();
  assert.equal(cell.dataset.papieren, undefined);
});

test('own posts are neither looked up nor hidden (Req 2.4)', async () => {
  const cell = fakeCell('7', 'me_myself');
  const t = load({ local: { settings: { lookups: true, mode: 'allow', countries: ['France'] } }, cells: [cell] });
  await settle();
  const me = { rest_id: '42', core: { screen_name: 'me_myself' } };
  t.fromPage({ kind: 'payload', op: 'HomeTimeline', body: JSON.stringify({ x: { __typename: 'Tweet', rest_id: '7', core: { user_results: { result: me } } } }) });
  t.fromPage({ kind: 'ready' });
  t.inView(cell);
  await settle();
  assert.equal(cell.dataset.papieren, undefined);
  assert.equal(t.sent.filter((m) => m.type === 'permit').length, 0);
});

test('an unknown layout filters nothing and tells the worker (design: UnknownVariant)', async () => {
  const cell = fakeCell('1', 'Ivan_Example');
  const t = load({ local: { settings: { countries: ['Russia'] }, 'c:ivan_example': RUSSIA }, cells: [cell], layout: false });
  await settle();
  assert.deepEqual(t.sent.filter((m) => m.type === 'layout'), [{ type: 'layout', known: false }]);
  assert.equal(cell.dataset.papieren, undefined);
});

// After an extension reload Chrome leaves the old script running in the tab
// with chrome.runtime.id gone and no more storage events: stale settings.
test('orphaned by an extension reload, the next DOM change shows every post and nothing re-marks', async () => {
  const cell = fakeCell('1', 'Ivan_Example');
  const t = load({ local: { settings: { countries: ['Russia'] }, 'c:ivan_example': RUSSIA }, cells: [cell] });
  await settle();
  assert.equal(cell.dataset.papieren, 'hidden');
  delete t.runtime.id;
  await t.area.set({ 'c:other': RUSSIA }); // stands in for a DOM change
  await settle();
  assert.equal(cell.dataset.papieren, undefined);
  assert.equal(t.document.documentElement.dataset.papierenPlaceholder, undefined);
  assert.deepEqual(t.observed.off, ['mo', 'io']);
  t.click(cell);
  await t.area.set({ 'c:other2': RUSSIA });
  await settle();
  assert.equal(cell.dataset.papieren, undefined);
});

test('orphaned, the tab coming back into view hands the feed back at once', async () => {
  const cell = fakeCell('1', 'Ivan_Example');
  const t = load({ local: { settings: { countries: ['Russia'] }, 'c:ivan_example': RUSSIA }, cells: [cell] });
  await settle();
  delete t.runtime.id;
  t.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(cell.dataset.papieren, undefined);
});

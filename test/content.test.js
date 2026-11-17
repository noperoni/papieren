// Runs src/content.js in a sandbox: the real libs, a fake adapter over fake
// cells, fake chrome.*, and the page hook played by the test over the same
// DOM events. Covers the paths where a mistake costs the account or the feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
// The content-script libraries in manifest order, so a new one is never missed here.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
const LIBS = MANIFEST.content_scripts.find((c) => c.js.includes('src/content.js')).js
  .filter((f) => f !== 'src/content.js').map((f) => read(f.replace(/^src\//, '')));
const CONTENT = read('content.js');
const ABOUT = fs.readFileSync(path.join(__dirname, 'fixtures', 'about-legacy.json'), 'utf8');
// SHA-256 resolved in one microtask. node's crypto.subtle digests on the
// libuv threadpool, which can outlast settle() under a loaded test run and
// land a payload's intake after the tab has already flushed and failed.
const subtle = { digest: async (_alg, data) => Uint8Array.from(createHash('sha256').update(data).digest()).buffer };
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
  const pending = []; // the callbacks behind timers, run by runTimers()
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
  const noFlags = { copy: {}, everywhere: {}, media: {}, offender: {} };
  const replies = { permit, report: { stopped: false }, prune: { removed: 1 }, layout: {}, 'db-flags': { flags: noFlags }, 'db-flush': { flags: noFlags } };
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
    setTimeout: (fn, ms) => { timers.push(ms); pending.push(fn); return pending.length; },
    clearTimeout: (id) => { if (id) pending[id - 1] = null; },
    crypto: { subtle }, TextEncoder,
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
  const runTimers = () => {
    for (let i = 0, n = pending.length; i < n; i++) {
      const fn = pending[i];
      pending[i] = null;
      fn?.();
    }
  };
  return { data, sent, timers, runTimers, toPage, fromPage, inView, location, click, stats, replies, area, document, runtime: chrome.runtime, observed };
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
  assert.deepEqual(await t.stats(), { layout: 'legacy', byCountry: { Russia: { n: 1, confirmed: 1, flagged: 0 } }, byRule: {} });

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
  const wake = t.timers.filter((ms) => ms > 5_000); // the database's flush timer is 5 s at most
  assert.equal(wake.length, 1);
  assert.ok(wake[0] > 55_000 && wake[0] <= 60_000);
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

// --- Database (database design, content.js) ---

const user = (id, handle, extra = {}) => ({ rest_id: id, core: { screen_name: handle }, ...extra });
const tweet = (id, u, legacy = {}) => ({ __typename: 'Tweet', rest_id: id, core: { user_results: { result: u } }, legacy });
const reply = (id, u, text, conv = 'c1') => tweet(id, u, { conversation_id_str: conv, in_reply_to_status_id_str: '1', full_text: text });
const payload = (...tweets) => ({ kind: 'payload', op: 'TweetDetail', body: JSON.stringify({ list: tweets }) });
const SAME = 'Congratulations on the launch, truly amazing work!';
const hide = async (t) => {
  t.document.hidden = true;
  t.document.dispatchEvent(new Event('visibilitychange'));
  await settle();
};
const copyThread = (t, cells) => t.fromPage(payload(...cells.map((c, i) => reply(c.post.tweetId, user(`10${i}`, `a${i}`), SAME))));

test('copy-paste: three Authors with one text hide with the count; the flush carries fingerprints, never text (Req 3.1, 3.6, 4, 6.1)', async () => {
  const cells = ['11', '12', '13'].map((id, i) => fakeCell(id, `a${i}`));
  const ivan = fakeCell('14', 'Ivan_Example');
  const t = load({
    local: { settings: { countries: ['Russia'], db: { copy: true, offender: true } }, 'c:ivan_example': RUSSIA },
    cells: [...cells, ivan],
  });
  await settle();
  assert.equal(t.sent.filter((m) => m.type === 'db-flags').length, 1);
  copyThread(t, cells);
  await settle();
  assert.ok(cells.every((c) => c.dataset.papieren === 'hidden'));
  assert.equal(cells[0].dataset.papierenLabel, 'Hidden: @a0 · copy-paste reply, 3 accounts (click to show)');
  assert.equal(ivan.dataset.papieren, 'hidden');
  assert.deepEqual((await t.stats()).byRule, { 'bm:copy': 3 });
  t.click(cells[0]);

  await hide(t);
  const flushes = t.sent.filter((m) => m.type === 'db-flush');
  assert.equal(flushes.length, 1);
  const f = flushes[0];
  assert.doesNotMatch(JSON.stringify(f), /launch/i);
  const copies = f.memory.filter((m) => m.kind === 'copy');
  assert.equal(copies.length, 3);
  assert.match(copies[0].fp, /^[0-9a-f]{16}$/);
  assert.ok(copies.every((m) => m.fp === copies[0].fp));
  // Offences for the behaviour hides only: a Repeat_Offender ignores country hides.
  assert.deepEqual(f.memory.filter((m) => m.kind === 'offence').map((m) => [m.tweet, m.author, m.rule]),
    [['11', '100', 'bm:copy'], ['12', '101', 'bm:copy'], ['13', '102', 'bm:copy']]);
  assert.deepEqual(f.history.map((h) => [h.tweet, h.handle, h.page, h.rule]).sort(),
    [['11', 'a0', 'home', 'bm:copy'], ['12', 'a1', 'home', 'bm:copy'], ['13', 'a2', 'home', 'bm:copy'], ['14', 'Ivan_Example', 'home', 'country']]);
  assert.deepEqual(f.revealed, ['11']);
  assert.deepEqual(f.stats, { country: { judged: 4, hid: 1 }, 'bm:copy': { judged: 4, hid: 3 }, 'bm:offender': { judged: 4, hid: 0 } });
});

test('worker flags hide at boot; neither a followed Author nor the viewer is hit (Req 3.4, 3.8)', async () => {
  const bad = fakeCell('21', 'bad');
  const friend = fakeCell('22', 'friend');
  const mine = fakeCell('23', 'me_myself');
  const t = load({ local: { settings: { db: { offender: true } } }, cells: [bad, friend, mine] });
  t.replies['db-flags'] = { flags: { copy: {}, everywhere: {}, media: {}, offender: { 200: 5, 201: 5, 42: 5 } } };
  await settle();
  t.fromPage(payload(tweet('21', user('200', 'bad')), tweet('22', user('201', 'friend', { legacy: { following: true } })), tweet('23', user('42', 'me_myself'))));
  await settle();
  assert.equal(bad.dataset.papierenLabel, 'Hidden: @bad · repeat offender, hidden 5 times (click to show)');
  assert.equal(friend.dataset.papieren, undefined);
  assert.equal(mine.dataset.papieren, undefined);
});

test('recycled media: the earliest post stays, the later ones hide (Req 3.3)', async () => {
  const cells = ['31', '32', '33'].map((id, i) => fakeCell(id, `m${i}`));
  const t = load({ local: { settings: { db: { media: true } } }, cells });
  await settle();
  t.fromPage(payload(...cells.map((c, i) => tweet(c.post.tweetId, user(`30${i}`, `m${i}`), { extended_entities: { media: [{ id_str: 'p9' }] } }))));
  await settle();
  assert.deepEqual(cells.map((c) => c.dataset.papieren), [undefined, 'hidden', 'hidden']);
  assert.equal(cells[1].dataset.papierenLabel, 'Hidden: @m1 · recycled media, 3 accounts (click to show)');
});

test('dbEpoch: the worker deleted rows, so the tab drops its sightings and flags and asks again', async () => {
  const cells = ['31', '32', '33'].map((id, i) => fakeCell(id, `m${i}`));
  const bad = fakeCell('21', 'bad');
  const t = load({ local: { settings: { db: { media: true, offender: true } } }, cells: [...cells, bad] });
  t.replies['db-flags'] = { flags: { copy: {}, everywhere: {}, media: {}, offender: { 200: 5 } } };
  await settle();
  t.fromPage(payload(tweet('21', user('200', 'bad')),
    ...cells.map((c, i) => tweet(c.post.tweetId, user(`30${i}`, `m${i}`), { extended_entities: { media: [{ id_str: 'p9' }] } }))));
  await settle();
  assert.deepEqual([...cells, bad].map((c) => c.dataset.papieren), [undefined, 'hidden', 'hidden', 'hidden']);

  t.replies['db-flags'] = { flags: { copy: {}, everywhere: {}, media: {}, offender: {} } };
  await t.area.set({ dbEpoch: 2 });
  await settle();
  assert.equal(t.sent.filter((m) => m.type === 'db-flags').length, 2);
  assert.ok([...cells, bad].every((c) => c.dataset.papieren !== 'hidden'));
});

test('an { error } answer runs the tab without the database; a settings change asks again (Req 7.2)', async () => {
  const cells = ['11', '12', '13'].map((id, i) => fakeCell(id, `a${i}`));
  const t = load({ local: { settings: { db: { copy: true } } }, cells });
  t.replies['db-flush'] = { error: 'UnknownError' };
  await settle();
  copyThread(t, cells);
  await settle();
  await hide(t);
  assert.ok(cells.every((c) => c.dataset.papieren === undefined));
  t.document.hidden = false;
  t.runTimers();
  await settle();
  assert.equal(t.sent.filter((m) => m.type === 'db-flush').length, 1);

  await t.area.set({ settings: { db: { copy: true, everywhere: true } } });
  await settle();
  assert.equal(t.sent.filter((m) => m.type === 'db-flags').length, 2);
  assert.ok(cells.every((c) => c.dataset.papieren === 'hidden'));
});

test('flush: at most one per 5 s, none while hidden (Req 7.3)', async () => {
  const cells = ['11', '12', '13'].map((id, i) => fakeCell(id, `a${i}`));
  const t = load({ local: { settings: { db: { copy: true } } }, cells });
  await settle();
  copyThread(t, cells);
  await settle();
  assert.equal(t.sent.filter((m) => m.type === 'db-flush').length, 0);
  t.runTimers();
  await settle();
  assert.equal(t.sent.filter((m) => m.type === 'db-flush').length, 1);
  t.click(cells[0]); // a new row waits the 5 s out
  assert.ok(t.timers.at(-1) > 4000 && t.timers.at(-1) <= 5000);
  assert.equal(t.sent.filter((m) => m.type === 'db-flush').length, 1);

  await hide(t); // one last flush, then no timer until the tab is visible again
  assert.equal(t.sent.filter((m) => m.type === 'db-flush').length, 2);
  const timers = t.timers.length;
  t.click(cells[1]);
  assert.equal(t.timers.length, timers);
});

// --- Packs (packs design, task 5.2) ---

const BAIT = {
  papierenPack: 1, id: 'bait', name: 'Bait', kind: 'junk', description: 'Asks for likes.', version: 1, threshold: 3,
  tells: [], languages: { en: [{ w: 3, on: 'text', phrase: 'like if you agree' }] },
};

test('packs: read at boot, a bait post hides with the Pack\'s name; switching it off or editing it re-judges live (Req 2.1, 7.1)', async () => {
  const cell = fakeCell('21', 'amy');
  const plain = fakeCell('22', 'amy');
  const broken = { ...BAIT, id: 'broken', threshold: 0 };
  const t = load({ local: { settings: { packs: { mode: 'block', on: ['bait', 'broken'] } }, 'packs:builtin': [BAIT, broken] }, cells: [cell, plain] });
  await settle();
  t.fromPage(payload(tweet('21', user('7', 'amy'), { full_text: 'Like if you agree!', lang: 'en' }), tweet('22', user('7', 'amy'), { full_text: 'Nice day', lang: 'en' })));
  await settle();
  assert.equal(cell.dataset.papieren, 'hidden');
  assert.equal(cell.dataset.papierenLabel, 'Hidden: @amy · Bait (click to show)');
  assert.equal(plain.dataset.papieren, undefined);
  assert.deepEqual((await t.stats()).byRule, { 'pack:bait': 1 });

  await t.area.set({ 'packs:builtin': [{ ...BAIT, threshold: 4 }, broken] });
  await settle();
  assert.equal(cell.dataset.papieren, undefined);

  await t.area.set({ 'packs:builtin': [BAIT, broken] });
  await settle();
  assert.equal(cell.dataset.papieren, 'hidden');
  await t.area.set({ settings: { packs: { mode: 'block', on: [] } } });
  await settle();
  assert.equal(cell.dataset.papieren, undefined);
});

test('packs: All_But hides what no Pack matches; a post X sent no payload for stays (Req 2.2, 2.6)', async () => {
  const bait = fakeCell('31', 'amy');
  const plain = fakeCell('32', 'amy');
  const domOnly = fakeCell('33', 'bob');
  const t = load({ local: { settings: { packs: { mode: 'allbut', on: ['bait'] } }, 'packs:user': [BAIT] }, cells: [bait, plain, domOnly] });
  await settle();
  t.fromPage(payload(tweet('31', user('7', 'amy'), { full_text: 'like if you agree', lang: 'en' }), tweet('32', user('7', 'amy'), { full_text: 'Nice day', lang: 'en' })));
  await settle();
  assert.equal(bait.dataset.papieren, undefined);
  assert.equal(plain.dataset.papierenLabel, 'Hidden: @amy · outside your packs (click to show)');
  assert.equal(domOnly.dataset.papieren, undefined);
});

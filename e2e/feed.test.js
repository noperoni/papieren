// The D rows of papieren/TESTING.md that need a feed, run against fakex.js's
// routed x.com: nothing here reaches X. What they cannot show is whether
// real X still looks like the fake; the live run on the burner does that.
// Inside b.sw(() => ...) the function runs in the worker, where t is the
// helper set from harness.js, not a test context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { launch, EXT } from './harness.js';
import { fakeX, post, cellState } from './fakex.js';

const FLUSH = 5000;
const HEADED = process.env.PAPIEREN_HEADED === '1';
// The local day, as memory.dayOf names files and rows: the UTC date lags it
// from midnight to 01:00 in Paris.
const today = () => new Date().toLocaleDateString('sv-SE');

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const hidden = (page, id, label) => until(async () => {
  const s = await cellState(page, id);
  return s?.mark === 'hidden' && (!label || label.test(s.label)) && s;
}, `post ${id} hidden${label ? ` as ${label}` : ''}`, 12_000);

const shown = (page, id) => until(async () => {
  const s = await cellState(page, id);
  return s && s.mark !== 'hidden' && s.mark !== 'checking';
}, `post ${id} shown`, 12_000);

// One browser, a fake X, France ticked and @alpha seeded as French.
async function setup(tc, { db, headless = true } = {}) {
  const b = await launch({ headless });
  tc.after(() => b.close());
  const x = await fakeX(b.ctx);
  await b.sw(async (db) => {
    await t.seed('alpha', 'France');
    await t.seed('bravo', 'Spain');
    await t.set({ countries: ['France'], ...(db ? { db } : {}) });
  }, db);
  return { b, x };
}

const HOME = [post(1, 'alpha'), post(2, 'bravo'), post(3, 'alpha'), post(4, 'charlie')];
// Three accounts post the same reply to @root's post 100.
const SAME = 'Congratulations on the launch, truly amazing work!';
const THREAD = [post(100, 'root'), ...['a0', 'a1', 'a2'].map((h, i) => post(101 + i, h, { conv: '100', text: SAME })), post(104, 'alpha', { conv: '100', text: 'hm' })];
// Posts carrying images: @mike's image 777 is the one the checks recycle.
const MEDIA = [post(10, 'mike', { media: ['777'] }), post(11, 'nova', { media: ['778'] }), post(12, 'alpha')];

const settleFlush = () => new Promise((r) => setTimeout(r, FLUSH + 1500));
const memoryRows = (b) => b.sw(() => t.rows('memory'));

test('D3.1 copy-paste replies hide once a third account posts the same reply', async (tc) => {
  const { b, x } = await setup(tc, { db: { copy: true } });
  x.set('/root/status/100', THREAD.filter((p) => p.id !== '103'));
  const page = await x.open('/root/status/100');
  await settleFlush();
  await shown(page, '101');
  await shown(page, '102');
  await x.append(page, [THREAD.find((p) => p.id === '103')]);
  for (const id of ['101', '102', '103']) await hidden(page, id, /^Hidden: @a\d · copy-paste reply, 3 accounts \(click to show\)$/);
  await shown(page, '100');
  await settleFlush(); // the third copy hides from the tab's own count; its row lands with the next flush
  const rows = await memoryRows(b);
  assert.equal(rows.some((r) => 'text' in r), false, 'no reply text kept');
  const copies = rows.filter((r) => r.kind === 'copy');
  assert.ok(copies.length >= 3, JSON.stringify(rows));
  for (const r of copies) assert.match(r.key, /^[0-9a-f]{16}$/);
});

test('D3.3 to D7.2: recycled media, toggling, popup counts, database failure', async (tc) => {
  const { b, x } = await setup(tc, { db: { media: true } });
  x.set('/home', MEDIA);
  const home = await x.open('/home');

  await tc.test('D3.3 a recycled image hides when it is not the earliest post', async () => {
    const m = await until(async () => (await memoryRows(b)).find((r) => r.kind === 'media' && r.handle === 'mike'), 'mike media row', FLUSH + 4000);
    await b.sw(async (key) => {
      await t.put('memory', ...['901', '902'].map((a, i) => ({ kind: 'media', key, author: a, handle: 'seeded' + i, tweet: String(i + 1), t: Date.now() })));
      await t.put('flags', { kind: 'media', key, n: 3, first: '1', t: Date.now() });
    }, m.key);
    await home.reload();
    await home.waitForFunction(() => document.title === 'fake X ready');
    await hidden(home, '10', /^Hidden: @mike · recycled media, 3 accounts \(click to show\)$/);
    await shown(home, '11');
  });

  await tc.test('D3.5 unticking the detection shows the post, ticking hides it, no reload', async () => {
    await b.sw(() => t.set({ db: { media: false } }));
    await shown(home, '10');
    await b.sw(() => t.set({ db: { media: true } }));
    await hidden(home, '10', /recycled media/);
  });

  await tc.test('D6.2 the popup lists the behaviour hide under the country rows', async () => {
    const p = await b.popup({ tabOf: home });
    const table = p.locator('#counts');
    await until(async () => (await table.textContent()).includes('Recycled media'), 'Recycled media row');
    assert.equal((await table.locator('thead th').first().textContent()).trim(), 'Reason');
    const rows = (await table.locator('tbody tr').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
    const france = rows.findIndex((r) => r.startsWith('France'));
    const media = rows.findIndex((r) => /^Recycled media 1\b/.test(r));
    assert.ok(france >= 0 && media > france, rows.join(' | '));
    await p.close();
  });

  await tc.test('D7.2 a database failure runs without the database until settings change', async () => {
    await b.sw(() => chrome.storage.session.set({ dbError: 'test' }));
    await home.reload();
    await home.waitForFunction(() => document.title === 'fake X ready');
    await hidden(home, '12', /France/);
    await shown(home, '10');
    const p = await b.popup({ tabOf: home });
    const status = p.locator('#status');
    assert.match(await status.textContent(), /Database unavailable \(test\): running without it\./);
    await p.locator('#paused').check();
    await p.locator('#paused').uncheck();
    await until(async () => !(await status.textContent()).includes('Database unavailable'), 'line gone');
    await hidden(home, '10', /recycled media/);
  });
});

test('deleted rows stop hiding in an open tab without F5: Delete all, then a sweep', async (tc) => {
  const { b, x } = await setup(tc, { db: { media: true } });
  // Three accounts post image 999: the two later posts hide on the tab's own sightings.
  x.set('/home', ['m0', 'm1', 'm2'].map((h, i) => post(50 + i, h, { media: ['999'] })));
  const home = await x.open('/home');
  await hidden(home, '51', /recycled media/);
  await hidden(home, '52');
  await until(async () => (await memoryRows(b)).length === 3, 'three media rows', FLUSH + 4000);
  const p = await b.popup();
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'db-clear', kind: 'memory' }));
  await shown(home, '51');
  await shown(home, '52');
  await p.close();

  // Image 888 was posted by three accounts 400 days ago, past any Retention:
  // the worker's flag hides post 60 until the popup's sweep deletes them.
  await b.sw(async (old) => {
    await t.put('memory', ...['901', '902', '903'].map((a, i) => ({ kind: 'media', key: '888', author: a, handle: 'old' + i, tweet: String(i + 1), t: old })));
    await t.put('flags', { kind: 'media', key: '888', n: 3, first: '1', t: Date.now() });
  }, Date.now() - 400 * 864e5);
  x.set('/home', [post(60, 'm9', { media: ['888'] })]);
  await home.reload();
  await home.waitForFunction(() => document.title === 'fake X ready');
  await hidden(home, '60', /recycled media/);
  await b.popup();
  await shown(home, '60');
});

test('D3.8 followed accounts never reach behaviour memory', async (tc) => {
  const { b, x } = await setup(tc, { db: { copy: true, everywhere: true, media: true, offender: true } });
  const fol = (id, h, more) => post(id, h, { following: true, ...more });
  x.set('/home', [fol(20, 'fol1', { media: ['900'] }), fol(21, 'fol2', { media: ['900'] }), post(22, 'stranger', { media: ['901'] })]);
  x.set('/root/status/100', [post(100, 'root'), fol(30, 'fol1', { conv: '100', text: SAME }), fol(31, 'fol2', { conv: '100', text: SAME }),
    fol(32, 'fol3', { conv: '100', text: SAME }), post(33, 'stranger', { conv: '100', text: 'first' })]);
  const page = await x.open('/home');
  await x.open('/root/status/100', page);
  await settleFlush();
  const handles = new Set((await memoryRows(b)).map((r) => r.handle));
  assert.ok(handles.has('stranger'), `memory is being written at all: ${[...handles]}`);
  for (const h of ['fol1', 'fol2', 'fol3']) assert.equal(handles.has(h), false, `${h} in memory`);
  for (const id of ['30', '31', '32']) await shown(page, id);
});

test('D4.1 to D4.3: hidden history, statistics, reveal', async (tc) => {
  const { b, x } = await setup(tc);
  x.set('/home', HOME);
  const home = await x.open('/home');
  await hidden(home, '1');
  await hidden(home, '3');

  await tc.test('D4.1 one history row per hidden post per day, survives F5', async () => {
    await settleFlush();
    const first = await b.sw(() => t.rows('history'));
    assert.equal(first.length, 2);
    await home.reload();
    await home.waitForFunction(() => document.title === 'fake X ready');
    await hidden(home, '1');
    await settleFlush();
    const again = await b.sw(() => t.rows('history'));
    assert.equal(again.length, first.length);
    for (const r of again) {
      assert.ok(['home', 'status', 'search'].includes(r.page), r.page);
      assert.match(r.rule, /^(country|bm:(copy|everywhere|media|offender))$/);
    }
  });

  await tc.test('D4.2 today\'s country statistics', async () => {
    const row = (await b.sw(() => t.rows('stats'))).find((r) => r.rule === 'country' && r.day === today());
    assert.ok(row, 'country row today');
    assert.ok(row.hid > 0 && row.judged >= row.hid, JSON.stringify(row));
  });

  await tc.test('D4.3 clicking a placeholder marks its history row revealed', async () => {
    await home.locator('a[href$="/status/1"]').locator('xpath=ancestor::div[@data-testid="cellInnerDiv"]').click();
    await until(async () => (await b.sw(() => t.rows('history'))).find((r) => r.tweet === '1')?.revealed === true, 'revealed: true', FLUSH + 4000);
  });
});

const scroller = (x, page, from) => async (seconds) => {
  for (let i = 0; i < seconds; i++) {
    await x.append(page, [post(from++, 'alpha')]);
    await new Promise((r) => setTimeout(r, 1000));
  }
};

test('D7.3 flushes from one tab are at least 5 s apart', async (tc) => {
  const { b, x } = await setup(tc);
  await b.sw(() => t.watch());
  x.set('/home', HOME);
  const home = await x.open('/home');
  await scroller(x, home, 200)(16);
  const flushes = await b.sw(() => t.flushes);
  assert.ok(flushes.length >= 2, `${flushes.length} flushes`);
  for (let i = 1; i < flushes.length; i++) assert.ok(flushes[i].at - flushes[i - 1].at >= FLUSH - 50, `gap ${flushes[i].at - flushes[i - 1].at} ms`);
});

// Headless Chromium reports every tab visible whatever is in front, so this
// half needs a window: PAPIEREN_HEADED=1 opens a plain Chromium on the desktop.
test('D7.3 one flush as the tab hides, none while it stays hidden', {
  skip: !HEADED && 'headless never hides a tab: PAPIEREN_HEADED=1 runs it; test/content.test.js:406 covers it meanwhile',
}, async (tc) => {
  const { b, x } = await setup(tc, { headless: false });
  await b.sw(() => t.watch());
  x.set('/home', HOME);
  const home = await x.open('/home');
  const scroll = scroller(x, home, 300);
  await scroll(6);
  const t0 = Date.now();
  await b.sw(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://x.com/*' });
    await chrome.tabs.create({ url: 'about:blank', active: true, windowId: tab.windowId });
  });
  await until(() => home.evaluate(() => document.hidden), 'the x.com tab hidden', 3000);
  await scroll(12);
  const after = (await b.sw(() => t.flushes)).filter((f) => f.at >= t0);
  assert.ok(after.length <= 1, `${after.length} flushes after hiding`);
  for (const f of after) assert.ok(f.at - t0 < 1500, `a flush ${f.at - t0} ms after hiding`);
});

test('D3.7 and D7.1: no request leaves the extension, none goes anywhere but x.com', async (tc) => {
  const { b, x } = await setup(tc, { db: { copy: true, everywhere: true, media: true, offender: true } });
  x.set('/home', [...HOME, ...MEDIA]);
  x.set('/root/status/100', THREAD);
  const page = await x.open('/home');
  await x.open('/root/status/100', page);
  await settleFlush();
  const p = await b.popup({ tabOf: page });
  await p.locator('#db-export').click();
  await new Promise((r) => setTimeout(r, 500));
  const odd = x.requests.filter((u) => !(
    u.startsWith(`chrome-extension://${b.id}/`) || u.startsWith('blob:')
    || /^https:\/\/x\.com\/(home|root\/status\/100|favicon\.ico)$/.test(u)
    || /^https:\/\/x\.com\/i\/api\/graphql\/fakeQid0+\/(HomeTimeline|TweetDetail|SearchTimeline)\?variables=/.test(u)));
  assert.deepEqual(odd, []);
});

// TESTING.md's source checks, run from the repository root as written there.
const grep = (...args) => {
  try {
    return execFileSync('grep', args, { cwd: `${EXT}/..`, encoding: 'utf8' }).trim().split('\n');
  } catch (e) {
    if (e.status === 1) return []; // no match
    throw e;
  }
};

test('D7.1 S1 to S3: what the source can send, where, and what it stores', () => {
  const s1 = grep('-rnE', 'nativeFetch\\(|sendBeacon|WebSocket|EventSource|\\.send\\(', 'papieren/src', 'papieren/popup');
  assert.equal(s1.length, 1, s1.join('\n'));
  assert.match(s1[0], /^papieren\/src\/page-hook\.js:(\d+):.*nativeFetch\(/);
  const line = Number(s1[0].split(':')[1]);
  const below = grep('-nE', "method: 'GET'", 'papieren/src/page-hook.js').map((l) => Number(l.split(':')[0]));
  assert.ok(below.some((n) => n > line && n <= line + 3), `method: 'GET' just below line ${line}`);
  const hosts = new Set(grep('-rnoE', 'https?://[a-z.]+', 'papieren/src', 'papieren/popup', 'papieren/manifest.json').map((l) => l.replace(/^.*?:\d+:/, '')));
  assert.ok(hosts.has('https://x.com'), [...hosts].join(' '));
  assert.deepEqual([...hosts].filter((h) => h !== 'https://x.com' && h !== 'https://api.x.com'), []);
  const s3 = grep('-rnE', 'localStorage|sessionStorage|indexedDB|storage\\.sync', 'papieren/src', 'papieren/popup')
    .filter((l) => !l.startsWith('papieren/src/lib/db.js:'));
  assert.deepEqual(s3, []);
});

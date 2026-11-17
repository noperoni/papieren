// The D rows of papieren/TESTING.md that need only the popup and the worker:
// no x.com tab, so nothing here touches X. Each check gets a fresh profile,
// which is the "fresh install" the rows start from.
// Inside b.sw(() => ...) the function runs in the worker, where t is the
// helper set from harness.js, not a test context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, download, parseCsv } from './harness.js';

const KEEP = { cache: 30, memory: 3, history: 7, stats: 90 };
// The local day, as memory.dayOf names files and rows: the UTC date lags it
// from midnight to 01:00 in Paris.
const today = () => new Date().toLocaleDateString('sv-SE');

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function fresh(tc) {
  const b = await launch();
  tc.after(() => b.close());
  return b;
}

// Ticks "Keep a local database" and waits for the save to land.
async function switchOn(b, page) {
  await page.locator('#db-on').check();
  await until(() => b.sw(() => t.peek('settings').then((s) => s?.db?.on === true)), 'db.on saved');
}

// Invented rows of every kind, a few of them shaped like spreadsheet formulas.
async function seedAll(b) {
  await b.sw(async (day) => {
    await t.seed('alpha', 'France');
    await t.seed('=beta', 'Spain', { s: '+via' });
    await t.put('memory', { kind: 'copy', key: 'k1', author: '1', handle: '@gamma', tweet: '11', rule: 'copy', t: Date.now() });
    await t.put('history', { day, tweet: '21', handle: '=delta', page: 'home', rule: 'country', revealed: false, t: Date.now() });
    await t.put('stats', { day, rule: 'country', judged: 4, hid: 2 });
  }, today());
}

test('D1.1 fresh install: switch off, controls greyed out, no database', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  assert.equal(await p.locator('#db-on').isChecked(), false);
  const detections = p.locator('#db-detections input[type=checkbox]');
  assert.equal(await detections.count(), 4);
  for (const box of await detections.all()) {
    assert.equal(await box.isChecked(), false);
    assert.equal(await box.isDisabled(), true);
  }
  for (const [kind, days] of Object.entries(KEEP)) {
    const field = p.locator(`#db-keep input[data-kind=${kind}]`);
    assert.equal(await field.inputValue(), String(days));
    assert.equal(await field.isDisabled(), true);
  }
  assert.equal(await p.locator('#db-export').isDisabled(), true);
  assert.equal(await p.locator('#db-csv').isDisabled(), true);
  assert.equal(await b.sw(() => t.dbExists()), false);
});

test('D1.3 switching on sweeps the cache past its Retention, and only that', async (tc) => {
  const b = await fresh(tc);
  await b.sw(async () => {
    await t.seed('Z', 'France', { t: t.ago(31) });
    await t.seed('Y', 'Spain');
  });
  const before = await b.sw(() => t.cacheCount());
  const p = await b.popup();
  await switchOn(b, p);
  await p.close();
  await b.popup();
  await until(() => b.sw(() => t.peek('c:z').then((v) => v === undefined)), 'c:z swept');
  assert.equal(await b.sw(() => t.cacheCount()), before - 1);
});

test('D1.4 switching off asks first, exports, then deletes the database and keeps the cache', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await switchOn(b, p);
  await seedAll(b);
  const cache = await b.sw(() => t.cacheCount());

  await p.locator('#db-on').click();
  assert.equal(await p.locator('#db-on').isChecked(), true, 'box stays ticked while the panel is open');
  assert.equal(await p.locator('#db-off').isVisible(), true);
  await p.locator('#db-off-cancel').click();
  assert.equal(await p.locator('#db-off').isVisible(), false);
  assert.equal(await p.locator('#db-on').isChecked(), true);
  assert.equal(await b.sw(() => t.peek('settings').then((s) => s.db.on)), true, 'Cancel changes nothing');
  assert.equal((await b.sw(() => t.rows('history'))).length, 1);

  await p.locator('#db-on').click();
  const file = await download(p, () => p.locator('#db-off-export').click());
  assert.equal(file.name, `papieren-database-${today()}.json`);
  assert.equal(JSON.parse(file.text).history.length, 1);
  await p.locator('#db-off-confirm').click();
  await until(() => b.sw(() => t.dbExists().then((x) => !x)), 'database deleted');
  assert.equal(await b.sw(() => t.cacheCount()), cache);
  assert.equal(await p.locator('#db-on').isChecked(), false);
  assert.equal(await p.locator('#db-export').isDisabled(), true);
  assert.equal(await p.locator('#db-keep input[data-kind=history]').isDisabled(), true);
});

test('D1.4 confirming while the export still runs waits for it, and nothing recreates the database', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await switchOn(b, p);
  await seedAll(b);
  // A large cache makes the export's storage read slow, the window the drop raced into.
  await b.sw(() => chrome.storage.local.set(Object.fromEntries(Array.from({ length: 20000 },
    (_, i) => [`c:bulk${i}`, { c: 'France', a: true, k: 'unverified', t: Date.now() }]))));
  await p.locator('#db-on').click();
  const file = await download(p, async () => {
    await p.locator('#db-off-export').click();
    await p.locator('#db-off-confirm').click();
  });
  const data = JSON.parse(file.text);
  assert.equal(data.memory.length, 1);
  assert.equal(data.history.length, 1);
  await until(() => b.sw(() => t.dbExists().then((x) => !x)), 'database deleted');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await b.sw(() => t.dbExists()), false, 'nothing recreated it');
});

test('D1.4 the switch going off deletes the database even if no db-off message follows', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await switchOn(b, p);
  await seedAll(b);
  await p.close();
  await b.sw(() => t.set({ db: { on: false } }));
  await until(() => b.sw(() => t.dbExists().then((x) => !x)), 'database deleted');
});

test('D2.1 an invalid Retention reverts, a valid one saves', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await switchOn(b, p);
  const field = p.locator('#db-keep input[data-kind=history]');
  for (const bad of ['400', '', '2.5']) {
    await field.fill(bad);
    await field.press('Tab');
    assert.equal(await field.inputValue(), '7', `${JSON.stringify(bad)} snaps back`);
  }
  await field.fill('14');
  await field.press('Tab');
  await until(() => b.sw(() => t.peek('settings').then((s) => s.db.keep.history === 14)), 'keep.history 14 saved');
  await p.close();
  const again = await b.popup();
  assert.equal(await again.locator('#db-keep input[data-kind=history]').inputValue(), '14');
});

test('D2.3 opening the popup sweeps history past its Retention', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await switchOn(b, p);
  const field = p.locator('#db-keep input[data-kind=history]');
  await field.fill('1');
  await field.press('Tab');
  await until(() => b.sw(() => t.peek('settings').then((s) => s.db.keep.history === 1)), 'keep.history 1 saved');
  await b.sw(() => t.put('history', { day: '2026-01-01', tweet: '1', handle: 'seeded', page: 'home', rule: 'country', revealed: false, t: t.ago(2) }));
  await p.close();
  await b.popup();
  await until(() => b.sw(() => t.rows('history').then((r) => !r.some((x) => x.handle === 'seeded'))), 'seeded row swept');
});

test('D2.4 Delete all asks twice and disarms on focus loss', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await switchOn(b, p);
  await seedAll(b);
  const del = p.locator('#db-keep button[data-clear=history]');
  await del.click();
  assert.equal(await del.textContent(), 'Click again to delete');
  assert.equal((await b.sw(() => t.rows('history'))).length, 1, 'one click deletes nothing');
  await del.press('Tab');
  assert.equal(await del.textContent(), 'Delete all');
  await del.click();
  await del.click();
  await until(async () => (await p.locator('#db-note').textContent()) === 'Deleted the whole hidden history.', 'delete note');
  assert.equal((await b.sw(() => t.rows('history'))).length, 0);
  assert.equal((await b.sw(() => t.rows('stats'))).length, 1, 'other kinds untouched');
});

test('D5.1 Export JSON carries version, time, retention and all four kinds', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await switchOn(b, p);
  await seedAll(b);
  const file = await download(p, () => p.locator('#db-export').click());
  const data = JSON.parse(file.text);
  assert.equal(data.papieren, await b.sw(() => chrome.runtime.getManifest().version));
  assert.match(data.exported, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(data.retention, KEEP);
  for (const kind of ['cache', 'memory', 'history', 'stats']) assert.ok(Array.isArray(data[kind]) && data[kind].length > 0, kind);
});

test('D5.2 Export CSV: one column per header, no formulas, three trailing columns', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await switchOn(b, p);
  await seedAll(b);
  for (const kind of ['cache', 'memory', 'history', 'stats']) {
    await p.locator('#db-kind').selectOption(kind);
    const file = await download(p, () => p.locator('#db-csv').click());
    assert.equal(file.name, `papieren-${kind}-${today()}.csv`);
    const [header, ...rows] = parseCsv(file.text);
    assert.deepEqual(header.slice(-3), ['exported', 'version', 'retention_days'], kind);
    assert.ok(rows.length > 0, `${kind} has rows`);
    for (const row of rows) {
      assert.equal(row.length, header.length, `${kind}: ${row.join(',')}`);
      for (const cell of row) assert.doesNotMatch(cell, /^[=+@\t\r]|^-(?!\d)/, `${kind} cell ${cell}`);
    }
  }
});

// Quota (design: QuotaExceeded). Chromium's DevTools quota override shows in
// Storage.getUsageAndQuota but IndexedDB commits ignore it (measured
// 2026-11-15: 2.4 MB written against a 1.5 MB quota), and the real quota is
// a share of the disk, so the error is injected: the flush's own transaction
// rejects as a full disk aborts it, before writing anything. The sweep, the
// retry and the gate around them are the real worker against real IndexedDB.
for (const [fails, what] of [[1, 'sweeps once and the retry lands'], [2, 'fails twice and the gate keeps the error']]) {
  test(`D7.2 quota: a full database ${what}`, async (tc) => {
    const b = await fresh(tc);
    const p = await b.popup(); // opening it sweeps, so the old rows go in after
    await switchOn(b, p);
    await b.sw(async (n) => {
      const pad = 'x'.repeat(200);
      const old = [];
      for (let i = 0; i < 50; i++) old.push({ day: '2026-01-01', tweet: String(1000 + i), handle: 'old' + i, page: 'home', rule: 'country', revealed: false, t: t.ago(30), pad });
      await t.put('history', ...old);
      // Swept just now, so the flush's daily sweep is not due: only the quota path sweeps.
      await Papieren.db.tx(['meta'], 'readwrite', (x) => Papieren.db.put(x, 'meta', Date.now(), 'lastSweep'));
      const { db } = Papieren;
      const tx = db.tx;
      t.quota = { left: n, thrown: 0 };
      db.tx = (stores, mode, fn) => {
        if (mode === 'readwrite' && stores.includes('stats') && stores.includes('flags') && t.quota.left > 0) {
          t.quota.left--;
          t.quota.thrown++;
          return Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        }
        return tx(stores, mode, fn);
      };
    }, fails);
    const answer = await p.evaluate((day) => chrome.runtime.sendMessage({
      type: 'db-flush', day, memory: [], revealed: [], stats: { country: { judged: 2, hid: 2 } },
      history: [1, 2].map((i) => ({ tweet: String(2000 + i), handle: 'new' + i, page: 'home', rule: 'country', t: Date.now() })),
    }), today());
    const rows = await b.sw(() => t.rows('history'));
    const { quota, dbError } = await b.sw(async () => ({ quota: t.quota, dbError: (await chrome.storage.session.get('dbError')).dbError }));
    assert.equal(quota.thrown, fails, 'the injection fired, so the worker kept its patch');
    assert.equal(rows.filter((r) => r.handle.startsWith('old')).length, 0, 'the quota sweep removed rows past Retention');
    const fresh2 = rows.filter((r) => r.handle.startsWith('new')).length;
    if (fails === 1) {
      assert.ok(answer.flags && !answer.error, JSON.stringify(answer));
      assert.equal(fresh2, 2, 'the retry wrote the flush');
      assert.equal(dbError, undefined);
    } else {
      assert.deepEqual(answer, { error: 'QuotaExceededError' });
      assert.equal(fresh2, 0);
      assert.equal(dbError, 'QuotaExceededError', 'the popup line has its reason');
    }
  });
}

test('6.4 settings file: dated export, import restores and says what came in', async (tc) => {
  const b = await fresh(tc);
  const p = await b.popup();
  await p.locator('input[name="mode"][value="allow"]').check();
  await p.locator('#countries input').first().check();
  await until(() => b.sw(() => t.peek('settings').then((s) => s?.countries?.length === 1)), 'one country saved');

  const file = await download(p, () => p.locator('#export').click());
  assert.equal(file.name, `papieren-settings-${today()}.json`);
  assert.equal(await p.locator('#file-note').textContent(), `Exported ${file.name}.`);
  const saved = JSON.parse(file.text);
  assert.deepEqual(Object.keys(saved), ['v', 'mode', 'countries', 'placeholder', 'paused', 'lookups', 'budget', 'db', 'packs']);

  const put = (name, text) => p.locator('#import').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  const mode = () => b.sw(() => t.peek('settings').then((s) => s.mode));
  await p.locator('input[name="mode"][value="block"]').check();
  await until(async () => (await mode()) === 'block', 'block saved');

  await put('bad.json', '{');
  await until(async () => (await p.locator('#file-note').textContent()) === 'Not imported: The file is not valid JSON.', 'bad JSON refused');
  await put('bad-mode.json', JSON.stringify({ ...saved, mode: 'x' }));
  await until(async () => (await p.locator('#file-note').textContent()) === 'Not imported: mode must be "block" or "allow".', 'bad mode refused');
  assert.equal(await mode(), 'block', 'a refused file changes nothing');

  await put('lookups.json', JSON.stringify({ ...saved, lookups: true, db: { ...saved.db, on: true } }));
  const want = 'Imported: show only 1 country. Lookups and the database switch stay as they were.';
  await until(async () => (await p.locator('#file-note').textContent()) === want, 'import note');
  const after = await b.sw(() => t.peek('settings'));
  assert.equal(after.mode, 'allow', 'the file restored the mode');
  assert.deepEqual(after.countries, saved.countries);
  assert.equal(after.lookups, false, 'an import never switches lookups on');
  assert.equal(after.db.on, false, 'nor the database');
  assert.ok(await p.locator('input[name="mode"][value="allow"]').isChecked(), 'the popup shows it');
});

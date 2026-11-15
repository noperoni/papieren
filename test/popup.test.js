const test = require('node:test');
const assert = require('node:assert/strict');
const { seenCountries, visibleCountries, countRows, detectionRows, statusLines, dbFile, settingsFile, importNote } = require('../popup/popup.js');
const { normalize, parseImport } = require('../src/lib/settings.js');

test('seenCountries: cache entries only, named countries only, once each', () => {
  const all = {
    settings: { c: 'Nope' },
    'qid:legacy': 'abc',
    'c:a': { c: 'India' },
    'c:b': { c: 'India' },
    'c:c': { c: null },
    'c:d': { c: 'Korea' },
  };
  assert.deepEqual(seenCountries(all).sort(), ['India', 'Korea']);
  assert.deepEqual(seenCountries(undefined), []);
});

test('visibleCountries: ticked first, stored extras kept, query narrows both', () => {
  const list = ['France', 'India', 'Russia', 'Unknown'];
  assert.deepEqual(visibleCountries(list, ['Russia', 'Europe']), ['Russia', 'Europe', 'France', 'India', 'Unknown']);
  assert.deepEqual(visibleCountries(list, ['Russia'], ' RU '), ['Russia']);
  assert.deepEqual(visibleCountries(list, [], 'n'), ['France', 'India', 'Unknown']);
});

test('countRows: most hidden first, ties by name, marks default to 0 (Req 5.4, 8.4)', () => {
  const rows = countRows({
    India: { n: 2, confirmed: 1, flagged: 0 },
    Brazil: { n: 2, confirmed: 0, flagged: 2 },
    Unknown: { n: 5 },
  });
  assert.deepEqual(rows.map((r) => r.country), ['Unknown', 'Brazil', 'India']);
  assert.deepEqual(rows[0], { country: 'Unknown', n: 5, confirmed: 0, flagged: 0 });
  assert.deepEqual(countRows(undefined), []);
});

test('statusLines: pause says it all, otherwise every applicable line (Req 7.1)', () => {
  const now = 1_000;
  const time = (ms) => `t${ms}`;
  const s = (over) => normalize({ countries: ['India'], ...over });

  assert.deepEqual(statusLines({ settings: s({ paused: true }), stats: { layout: null }, now, time }),
    ['Paused: every post is shown and no lookups run.']);
  assert.deepEqual(statusLines({ settings: s({ lookups: true }), now, time }), []);
  assert.match(statusLines({ settings: s(), now, time })[0], /^Lookups off/);

  const lines = statusLines({ settings: s({ mode: 'allow', countries: [] }), stats: { layout: null }, now, time });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /layout not recognised/);
  assert.match(lines[1], /nothing ticked/);

  assert.match(statusLines({ settings: s({ lookups: true }), budget: { stopped: true }, now, time })[0], /stopped after 3/);
  assert.equal(statusLines({ settings: s({ lookups: true }), budget: { cooldownUntil: 5_000 }, now, time })[0],
    'X rate limit: lookups resume at t5000.');
  assert.deepEqual(statusLines({ settings: s({ lookups: true }), budget: { cooldownUntil: 500 }, now, time }), []);
});

test('statusLines: the database line needs the switch on and a dbError (database Req 7.2)', () => {
  const now = 1_000;
  const time = (ms) => `t${ms}`;
  const s = (db) => normalize({ countries: ['India'], lookups: true, db });

  assert.deepEqual(statusLines({ settings: s({ on: true }), dbError: 'QuotaExceededError', now, time }),
    ['Database unavailable (QuotaExceededError): running as if switched off.']);
  assert.deepEqual(statusLines({ settings: s({ on: false }), dbError: 'blocked', now, time }), []);
  assert.deepEqual(statusLines({ settings: s({ on: true }), now, time }), []);
  // Under the layout line, above the lookups lines.
  const lines = statusLines({ settings: normalize({ db: { on: true } }), stats: { layout: null }, dbError: 'blocked', now, time });
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^Database unavailable \(blocked\)/);
  assert.match(lines[2], /^Lookups off/);
});

test('detectionRows: fixed order, only detections that hid something (database Req 6.2)', () => {
  assert.deepEqual(detectionRows({ 'bm:offender': 2, 'bm:copy': 1, 'bm:media': 0, country: 9 }),
    [{ name: 'Copy-paste reply', n: 1 }, { name: 'Repeat offender', n: 2 }]);
  assert.deepEqual(detectionRows(undefined), []);
});

test('dbFile: JSON of every kind, or one kind as CSV, named by date (database Req 5)', () => {
  const now = Date.UTC(2026, 10, 15, 12);
  const data = {
    version: '0.1.0', now, keep: { cache: 30, memory: 3, history: 7, stats: 90 },
    cache: [{ handle: 'a', c: 'India', t: now }],
    memory: [{ kind: 'copy', key: 'f00d', author: '1', handle: 'a', t: now }],
    history: [{ day: '2026-11-15', tweet: '9', handle: 'a', page: 'home', rule: 'country', revealed: false, t: now }],
    stats: [{ day: '2026-11-15', rule: 'country', judged: 4, hid: 1 }],
  };

  const all = dbFile('all', data);
  assert.equal(all.type, 'application/json');
  assert.match(all.name, /^papieren-database-\d{4}-\d{2}-\d{2}\.json$/);
  const json = JSON.parse(all.text);
  assert.equal(json.papieren, '0.1.0');
  assert.deepEqual(json.retention, data.keep);
  assert.deepEqual([json.cache.length, json.memory.length, json.history.length, json.stats.length], [1, 1, 1, 1]);

  const csv = dbFile('history', data);
  assert.equal(csv.type, 'text/csv');
  assert.match(csv.name, /^papieren-history-\d{4}-\d{2}-\d{2}\.csv$/);
  const [header, row, end] = csv.text.split('\n');
  assert.equal(header, 'day,tweet,handle,page,rule,revealed,time,exported,version,retention_days');
  assert.match(row, /^2026-11-15,9,a,home,country,false,.*,0\.1\.0,7$/);
  assert.equal(end, '');

  assert.match(dbFile('cache', data).text.split('\n')[1], /^a,India,/);
  assert.equal(dbFile('stats', { ...data, stats: [] }).text.split('\n').length, 2);
});

test('settingsFile: dated JSON that imports back unchanged (Req 6.4)', () => {
  const settings = normalize({ mode: 'allow', countries: ['India', 'Peru'], budget: 12 });
  const file = settingsFile(settings, new Date(2026, 10, 15, 23, 30).getTime());
  assert.equal(file.name, 'papieren-settings-2026-11-15.json', 'the local day, as the database exports');
  assert.equal(file.type, 'application/json');
  assert.ok(file.text.endsWith('}\n'));
  assert.deepEqual(parseImport(file.text, normalize({})), { ok: true, settings });
});

test('importNote: mode and country count, and what a file never changes (Req 3.7)', () => {
  const tail = ' Lookups and the database switch stay as they were.';
  assert.equal(importNote(normalize({ countries: ['India', 'Peru'] })), `Imported: hide 2 countries.${tail}`);
  assert.equal(importNote(normalize({ mode: 'allow', countries: ['Peru'] })), `Imported: show only 1 country.${tail}`);
  assert.equal(importNote(normalize({})), `Imported: hide 0 countries.${tail}`);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const records = require('../src/lib/records.js');

const { DAY_MS, dayOf, flagFor, cutoffs, capShare, cacheRows, toJson, toCsv, fileName } = records;

const NOW = new Date(2026, 10, 14, 12, 0, 0).getTime(); // local noon, 2026-11-14
const HOUR = 60 * 60 * 1000;
const KEEP = { cache: 30, memory: 3, history: 7, stats: 90 };
const META = { version: '0.2.0', now: NOW, keep: KEEP };

// --- flags from stored rows (Req 3.1 to 3.4) ---

test('flagFor copy: distinct Authors, null under 3', () => {
  const row = (author) => ({ kind: 'copy', key: 'f1', author, t: NOW });
  assert.equal(flagFor('copy', [row('1'), row('2'), row('2')], NOW), null);
  assert.deepEqual(flagFor('copy', [row('1'), row('2'), row('3')], NOW), { n: 3 });
});

test('flagFor conv: distinct conversations of one Author within 24 h', () => {
  const row = (key, ago) => ({ kind: 'conv', key, author: '1', t: NOW - ago });
  const rows = [row('a', 0), row('b', HOUR), row('c', 23 * HOUR), row('d', 24 * HOUR), row('e', 24 * HOUR + 1)];
  assert.equal(flagFor('conv', rows, NOW), null);
  assert.deepEqual(flagFor('conv', [...rows, row('f', 2 * HOUR)], NOW), { n: 5 });
});

test('flagFor media: distinct Authors and the earliest tweet id', () => {
  const row = (author, tweet) => ({ kind: 'media', key: 'm1', author, tweet, t: NOW });
  assert.equal(flagFor('media', [row('1', '50'), row('2', '40')], NOW), null);
  assert.deepEqual(flagFor('media', [row('1', '1000'), row('2', '999'), row('3', '10000')], NOW), { n: 3, first: '999' });
});

test('flagFor offence: distinct hidden tweets of one Author, null under 5', () => {
  const row = (key) => ({ kind: 'offence', key, author: '9', rule: 'bm:copy', t: NOW });
  assert.equal(flagFor('offence', ['1', '2', '3', '4'].map(row), NOW), null);
  assert.deepEqual(flagFor('offence', ['1', '2', '3', '4', '5'].map(row), NOW), { n: 5 });
});

// --- Retention (Req 2.3) and the size cap (Req 2.5) ---

test('cutoffs: a record N days old stays, one older is deleted', () => {
  const c = cutoffs(KEEP, NOW);
  const gone = (kind, age) => NOW - age < c[kind];
  assert.equal(gone('memory', 3 * DAY_MS), false);
  assert.equal(gone('memory', 3 * DAY_MS + 1), true);
  assert.equal(gone('memory', 2 * DAY_MS), false);
  assert.equal(gone('history', 7 * DAY_MS + 1), true);
  assert.equal(gone('cache', 29 * DAY_MS), false);
  assert.equal(c.stats, dayOf(NOW - 90 * DAY_MS));
  assert.equal(c.stats < dayOf(NOW - 89 * DAY_MS), true);
});

test('capShare: nothing up to 100 MB, down to 90 MB above it', () => {
  const MB = 1024 * 1024;
  assert.equal(capShare(100 * MB), 0);
  assert.equal(capShare(50 * MB), 0);
  assert.equal(capShare(120 * MB), 30 / 120);
});

test('dayOf: local date with zero padding', () => {
  assert.equal(dayOf(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');
  assert.equal(dayOf(NOW), '2026-11-14');
});

// --- export (Req 5.1 to 5.3) ---

test('cacheRows: c: entries only, keyed by handle', () => {
  const all = { settings: {}, 'qid:legacy': 'x', 'c:alice': { c: 'France', a: true, k: 'unverified', t: 1 } };
  assert.deepEqual(cacheRows(all), [{ handle: 'alice', c: 'France', a: true, k: 'unverified', t: 1 }]);
});

test('toJson: every Record_Kind with date, version and Retention', () => {
  const j = toJson({ ...META, cache: [], memory: [{ kind: 'copy' }], history: [], stats: [] });
  assert.equal(j.papieren, '0.2.0');
  assert.equal(j.exported, new Date(NOW).toISOString());
  assert.deepEqual(j.retention, KEEP);
  assert.deepEqual(Object.keys(j), ['papieren', 'exported', 'retention', 'cache', 'memory', 'history', 'stats']);
});

test('toCsv: header row, ISO times, and the three trailing columns', () => {
  const csv = toCsv('history', [{ day: '2026-11-14', tweet: '123', handle: 'bot', page: 'status', rule: 'bm:copy', revealed: false, t: NOW }], META);
  const [header, row, end] = csv.split('\n');
  assert.equal(header, 'day,tweet,handle,page,rule,revealed,time,exported,version,retention_days');
  assert.equal(row, `2026-11-14,123,bot,status,bm:copy,false,${new Date(NOW).toISOString()},${new Date(NOW).toISOString()},0.2.0,7`);
  assert.equal(end, '');
});

test('toCsv: quoting, empty cells and formula guard', () => {
  const csv = toCsv('cache', [{ handle: 'a', c: 'Korea, Republic of', a: true, k: 'flagged', t: NOW },
    { handle: 'b', c: '=HYPERLINK("x")', a: false, k: 'unverified', t: NOW }], META);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'handle,country,accurate,via,created,confidence,time,id,exported,version,retention_days');
  assert.match(lines[1], /^a,"Korea, Republic of",true,,,flagged,/);
  assert.match(lines[2], /^b,"'=HYPERLINK\(""x""\)",false,,,unverified,/);
});

test('toCsv: every Record_Kind has columns, an empty kind is a header only', () => {
  for (const kind of records.KINDS) assert.equal(toCsv(kind, [], META).split('\n').length, 2);
});

test('fileName: dated JSON for everything, CSV per kind', () => {
  assert.equal(fileName('all', NOW), 'papieren-database-2026-11-14.json');
  assert.equal(fileName('stats', NOW), 'papieren-stats-2026-11-14.csv');
});

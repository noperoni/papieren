const test = require('node:test');
const assert = require('node:assert/strict');
const records = require('../src/lib/records.js');
const memory = require('../src/lib/memory.js');

const { DAY_MS, dayOf, flagFor, cutoffs, capShare, keepRow, parseFlush, flagKeys, flagRange, toFlags, revealTarget, cacheRows, toJson, toCsv, fileName } = records;

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

test('flagFor offence and pack: distinct tweets of one Author from the first, the earliest tweet per rule', () => {
  const row = (kind, key, rule) => ({ kind, key, author: '9', rule, t: NOW });
  assert.equal(flagFor('offence', [], NOW), null);
  assert.deepEqual(flagFor('offence', [row('offence', '30', 'bm:copy')], NOW), { n: 1, first: { 'bm:copy': '30' } });
  const offences = [row('offence', '30', 'bm:copy'), row('offence', '200', 'bm:media'), row('offence', '9', 'bm:copy'), row('offence', '30', 'bm:copy')];
  assert.deepEqual(flagFor('offence', offences, NOW), { n: 3, first: { 'bm:copy': '9', 'bm:media': '200' } });
  const hides = [row('pack', '50', 'pack:ragebait'), row('pack', '40', 'pack:ragebait'), row('pack', '60', 'pack:bait')];
  assert.deepEqual(flagFor('pack', hides, NOW), { n: 3, first: { 'pack:ragebait': '40', 'pack:bait': '60' } });
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

// --- db-flush intake and the flags answer (Req 3.1 to 3.4, 4.1 to 4.3) ---

test('parseFlush: stored rows in the design\'s field order, malformed rows dropped', () => {
  const out = parseFlush({
    day: '2026-11-14',
    memory: [
      { kind: 'copy', fp: 'ab12', author: '1', handle: 'a', t: NOW, text: 'never stored' },
      { kind: 'conv', conv: '77', author: '2', handle: 'b', t: NOW },
      { kind: 'media', media: 'm1', author: '3', handle: 'c', tweet: '500', t: NOW },
      { kind: 'offence', author: '4', handle: 'd', tweet: '600', rule: 'bm:copy', t: NOW },
      { kind: 'copy', author: '1', handle: 'a', t: NOW },              // no fp
      { kind: 'media', media: 'm2', author: '3', handle: 'c', t: NOW }, // no tweet
      { kind: 'offence', author: '4', handle: 'd', tweet: '601', t: NOW }, // no rule
      { kind: 'toString', author: '1', handle: 'a', t: NOW },
      { kind: 'conv', conv: '78', author: '2', handle: 'bad handle', t: NOW },
      { kind: 'conv', conv: '79', author: '2', handle: 'b', t: 'now' },
      null,
    ],
    history: [{ tweet: '600', handle: 'd', page: 'status', rule: 'bm:copy', t: NOW }, { tweet: '601', handle: 'd', page: 'profile', rule: 'country', t: NOW }],
    revealed: ['600', '600', 7],
    stats: { country: { judged: 3, hid: 1 }, 'bm:copy': { judged: 0, hid: 0 }, 'bad rule!': { judged: 1, hid: 0 }, 'bm:media': { judged: -2, hid: 1.5 } },
  }, NOW);
  assert.deepEqual(out.memory.map((r) => Object.keys(r)), [
    ['kind', 'key', 'author', 'handle', 't'], ['kind', 'key', 'author', 'handle', 't'],
    ['kind', 'key', 'author', 'handle', 'tweet', 't'], ['kind', 'key', 'author', 'handle', 'tweet', 'rule', 't']]);
  assert.deepEqual(out.memory.map((r) => r.key), ['ab12', '77', 'm1', '600']);
  assert.deepEqual(out.history, [{ day: '2026-11-14', tweet: '600', handle: 'd', page: 'status', rule: 'bm:copy', revealed: false, t: NOW }]);
  assert.deepEqual(out.revealed, ['600']);
  assert.deepEqual(out.stats, [{ rule: 'country', judged: 3, hid: 1 }]);
});

test('parseFlush: an offence for a country or Pack hide, or for the offender detection, is dropped', () => {
  const offence = (tweet, rule) => ({ kind: 'offence', author: '4', handle: 'd', tweet, rule, t: NOW });
  const out = parseFlush({ memory: [offence('1', 'country'), offence('2', 'bm:offender'), offence('3', 'bm:media'), offence('4', 'pack:x')] }, NOW);
  assert.deepEqual(out.memory.map((r) => r.key), ['3']);
});

test('parseFlush: a pack row needs a tweet and a pack:<id> rule', () => {
  const hide = (tweet, rule) => ({ kind: 'pack', author: '4', handle: 'd', tweet, rule, t: NOW });
  const out = parseFlush({ memory: [hide('1', 'pack:ragebait'), hide('2', 'bm:copy'), hide('3', 'pack:Bad Id'), hide(undefined, 'pack:x')] }, NOW);
  assert.deepEqual(out.memory, [{ kind: 'pack', key: '1', author: '4', handle: 'd', tweet: '1', rule: 'pack:ragebait', t: NOW }]);
});

test('keepRow: a new key as it is, the newer t wins, a media row keeps the earlier tweet', () => {
  const copy = (t, handle) => ({ kind: 'copy', key: 'f', author: '1', handle, t });
  const media = (tweet, t) => ({ kind: 'media', key: 'm', author: '1', handle: 'a', tweet, t });
  assert.deepEqual(keepRow(undefined, copy(NOW, 'a')), copy(NOW, 'a'));
  assert.deepEqual(keepRow(copy(NOW, 'stored'), copy(NOW - 5, 'late')), copy(NOW, 'stored'));
  assert.deepEqual(keepRow(copy(NOW - 5, 'stored'), copy(NOW, 'renamed')), copy(NOW, 'renamed'));
  assert.deepEqual(keepRow(media('99', NOW - 5), media('1000', NOW)), media('99', NOW));
  assert.deepEqual(keepRow(media('1000', NOW), media('99', NOW - 5)), media('99', NOW));
});

test('parseFlush: one row per key, the newer t wins, media keeps the earlier tweet', () => {
  const media = (tweet, t, handle = 'c') => ({ kind: 'media', media: 'm1', author: '3', handle, tweet, t });
  const out = parseFlush({
    day: '2026-11-14',
    memory: [media('900', NOW - 1, 'old'), media('1000', NOW, 'new'), media('99', NOW - 2, 'oldest'),
      { kind: 'copy', fp: 'f', author: '1', handle: 'a', t: NOW }, { kind: 'copy', fp: 'f', author: '1', handle: 'a', t: NOW - 5 }],
    history: [{ tweet: '5', handle: 'a', page: 'home', rule: 'country', t: NOW }, { tweet: '5', handle: 'a', page: 'search', rule: 'country', t: NOW + 1 }],
  }, NOW);
  assert.deepEqual(out.memory, [
    { kind: 'media', key: 'm1', author: '3', handle: 'new', tweet: '99', t: NOW },
    { kind: 'copy', key: 'f', author: '1', handle: 'a', t: NOW },
  ]);
  assert.deepEqual(out.history.map((h) => h.page), ['home']);
});

test('parseFlush: a missing or malformed day is the worker\'s own, empty lists are empty', () => {
  assert.deepEqual(parseFlush({ day: '14/11/2026' }, NOW), { day: '2026-11-14', memory: [], history: [], revealed: [], stats: [] });
  assert.equal(parseFlush(undefined, NOW).day, '2026-11-14');
});

test('flagKeys: copy and media by key, conv and offence by author, each once', () => {
  const rows = [
    { kind: 'copy', key: 'f', author: '1' }, { kind: 'copy', key: 'f', author: '2' },
    { kind: 'conv', key: 'c1', author: '1' }, { kind: 'conv', key: 'c2', author: '1' },
    { kind: 'media', key: 'm', author: '1' }, { kind: 'offence', key: '600', author: '4' }, { kind: 'pack', key: '601', author: '4' },
  ];
  assert.deepEqual(flagKeys(rows), [
    { kind: 'copy', key: 'f' }, { kind: 'conv', key: '1' }, { kind: 'media', key: 'm' }, { kind: 'offence', key: '4' }, { kind: 'pack', key: '4' }]);
});

test('flagRange: [kind, key] for copy and media, the author\'s 24 h for conv, all for offence', () => {
  assert.deepEqual(flagRange('copy', 'f', NOW), { index: 'key', lower: ['copy', 'f'], upper: ['copy', 'f'] });
  assert.deepEqual(flagRange('media', 'm', NOW), { index: 'key', lower: ['media', 'm'], upper: ['media', 'm'] });
  assert.deepEqual(flagRange('conv', '1', NOW), { index: 'author', lower: ['conv', '1', NOW - 24 * HOUR], upper: ['conv', '1', Infinity] });
  assert.deepEqual(flagRange('offence', '4', NOW), { index: 'author', lower: ['offence', '4', -Infinity], upper: ['offence', '4', Infinity] });
  assert.deepEqual(flagRange('pack', '4', NOW), { index: 'author', lower: ['pack', '4', -Infinity], upper: ['pack', '4', Infinity] });
});

test('toFlags: memory.js\'s Flags shape, 0 for a deleted flag, unknown kinds skipped', () => {
  const flags = toFlags([
    { kind: 'copy', key: 'f', n: 3, t: NOW }, { kind: 'conv', key: '1', n: 5 }, { kind: 'media', key: 'm', n: 4, first: '99' },
    { kind: 'offence', key: '4', n: 0 }, { kind: 'media', key: 'gone', n: 0 }, { kind: 'toString', key: 'x', n: 9 },
    { kind: 'offence', key: '5', n: 2, first: { 'bm:copy': '7' } }, { kind: 'pack', key: '5', n: 1, first: { 'pack:x': '8' } },
  ]);
  assert.deepEqual(flags, {
    copy: { f: 3 }, everywhere: { 1: 5 }, media: { m: { n: 4, first: '99' }, gone: 0 },
    offender: { 4: 0, 5: { n: 2, first: { 'bm:copy': '7' } } }, packs: { 5: { n: 1, first: { 'pack:x': '8' } } },
  });
  const live = memory.emptyFlags();
  live.media.gone = { n: 3, first: '1' };
  live.offender[4] = 6;
  memory.merge(live, flags);
  assert.deepEqual(live, {
    copy: { f: 3 }, everywhere: { 1: 5 }, media: { m: { n: 4, first: '99' } },
    offender: { 5: { n: 2, first: { 'bm:copy': '7' } } }, packs: { 5: { n: 1, first: { 'pack:x': '8' } } },
  });
});

test('revealTarget: the day\'s row, else the latest, none when the tweet has no row', () => {
  const rows = [{ day: '2026-11-12', t: 2 }, { day: '2026-11-13', t: 3 }, { day: '2026-11-11', t: 1 }];
  assert.equal(revealTarget(rows, '2026-11-13'), rows[1]);
  assert.equal(revealTarget(rows, '2026-11-14'), rows[1]);
  assert.equal(revealTarget([], '2026-11-14'), undefined);
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

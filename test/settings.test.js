const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, normalize, parseImport } = require('../src/lib/settings.js');

test('defaults: block mode, lookups off, budget 40 (Req 3.6)', () => {
  assert.deepEqual(normalize(undefined), { ...DEFAULTS, countries: [] });
  assert.equal(DEFAULTS.mode, 'block');
  assert.equal(DEFAULTS.lookups, false);
  assert.equal(DEFAULTS.budget, 40);
});

test('normalize: budget is an integer clamped to 1..45 (Req 3.1)', () => {
  const b = (budget) => normalize({ budget }).budget;
  assert.equal(b(100), 45);
  assert.equal(b(0), 1);
  assert.equal(b(-3), 1);
  assert.equal(b(12.9), 12);
  assert.equal(b('40'), 40);
  assert.equal(b(NaN), 40);
});

test('normalize: bad mode and placeholder fall back, lookups only on when exactly true', () => {
  const s = normalize({ mode: 'deny', placeholder: 'blur', lookups: 'yes', paused: 1 });
  assert.equal(s.mode, 'block');
  assert.equal(s.placeholder, 'line');
  assert.equal(s.lookups, false);
  assert.equal(s.paused, false);
  assert.equal(normalize({ lookups: true }).lookups, true);
});

test('normalize: countries trimmed, deduplicated, invalid dropped, capped at 300', () => {
  assert.deepEqual(normalize({ countries: [' Russia', 'Russia', '', 'x'.repeat(65), 7, 'Europe'] }).countries,
    ['Russia', 'Europe']);
  const many = Array.from({ length: 400 }, (_, i) => `C${i}`);
  assert.equal(normalize({ countries: many }).countries.length, 300);
});

const file = (over = {}) => JSON.stringify({ v: 1, mode: 'allow', countries: ['France', 'France', 'Unknown'], ...over });

test('import: a good file replaces settings, duplicates dropped, budget clamped', () => {
  const r = parseImport(file({ budget: 99, placeholder: 'remove' }), DEFAULTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, {
    v: 1, mode: 'allow', countries: ['France', 'Unknown'], placeholder: 'remove', paused: false, lookups: false, budget: 45,
    db: normalize(undefined).db, packs: { mode: 'block', on: [] },
  });
});

test('import never changes the lookups switch (Req 3.7)', () => {
  assert.equal(parseImport(file({ lookups: true }), DEFAULTS).settings.lookups, false);
  assert.equal(parseImport(file({ lookups: false }), { ...DEFAULTS, lookups: true }).settings.lookups, true);
});

test('import: a bad file is rejected whole with a reason (Req 6.4)', () => {
  const bad = [
    'not json',
    '[]',
    'null',
    file({ v: 2 }),
    file({ mode: 'deny' }),
    file({ countries: 'Russia' }),
    file({ countries: ['Russia', ''] }),
    file({ countries: ['Russia', 42] }),
    file({ countries: ['x'.repeat(65)] }),
    file({ countries: Array.from({ length: 301 }, (_, i) => `C${i}`) }),
    file({ placeholder: 'blur' }),
    file({ paused: 'no' }),
    file({ budget: 'lots' }),
  ];
  for (const text of bad) {
    const r = parseImport(text, DEFAULTS);
    assert.equal(r.ok, false, text.slice(0, 60));
    assert.equal(typeof r.reason, 'string');
    assert.equal('settings' in r, false);
  }
});

// --- Database block (database Req 2.1, 2.2, 3.5) ---

test('db defaults: detections off, Retention 30 / 3 / 7 / 90 days', () => {
  assert.deepEqual(normalize(undefined).db, {
    copy: false, everywhere: false, media: false, offender: false,
    keep: { cache: 30, memory: 3, history: 7, stats: 90 },
  });
});

test('db normalize: only exact true switches anything on; Retention clamped to 1..365', () => {
  const db = normalize({ db: { copy: true, media: 1, keep: { cache: 400, memory: 0, history: 7.8, stats: 'x' } } }).db;
  assert.equal(db.copy, true);
  assert.equal(db.media, false);
  assert.deepEqual(db.keep, { cache: 365, memory: 1, history: 7, stats: 90 });
  assert.deepEqual(normalize({ db: [] }).db, normalize(undefined).db);
  assert.deepEqual(normalize({ db: { keep: null } }).db.keep, normalize(undefined).db.keep);
});

test('db import: a good block is taken', () => {
  const r = parseImport(file({ db: { everywhere: true, keep: { history: 14 } } }), DEFAULTS);
  assert.equal(r.ok, true);
  assert.equal(r.settings.db.everywhere, true);
  assert.deepEqual(r.settings.db.keep, { cache: 30, memory: 3, history: 14, stats: 90 });
});

// The database switch went on 2026-11-17: the key is read and ignored.
test('db: the old switch, stored as false or carried by an old export, is dropped', () => {
  const stored = normalize({ db: { on: false, copy: true, keep: { memory: 5 } } }).db;
  assert.equal('on' in stored, false);
  assert.equal(stored.copy, true);
  assert.equal(stored.keep.memory, 5);
  for (const on of [true, false]) {
    const r = parseImport(file({ db: { on, media: true } }), DEFAULTS);
    assert.equal(r.ok, true);
    assert.equal('on' in r.settings.db, false);
    assert.equal(r.settings.db.media, true);
  }
});

test('db import: a file without db keeps the current block whole', () => {
  const cur = normalize({ db: { copy: true, keep: { memory: 5 } } });
  assert.deepEqual(parseImport(file(), cur).settings.db, cur.db);
});

test('db import: a malformed block rejects the whole file', () => {
  const bad = [
    { db: 'on' },
    { db: [] },
    { db: { copy: 'yes' } },
    { db: { on: 1 } },
    { db: { keep: [] } },
    { db: { keep: { cache: 0 } } },
    { db: { keep: { stats: 366 } } },
    { db: { keep: { memory: 2.5 } } },
    { db: { keep: { history: '7' } } },
  ];
  for (const over of bad) {
    const r = parseImport(file(over), DEFAULTS);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(typeof r.reason, 'string');
  }
});

// --- Packs block (packs Req 4.2, 6.3) ---

test('packs defaults: Blocklist, every Pack off', () => {
  assert.deepEqual(normalize(undefined).packs, { mode: 'block', on: [] });
  assert.deepEqual(DEFAULTS.packs, { mode: 'block', on: [] });
});

test('packs normalize: bad mode falls back; duplicates, bad ids and ids beyond 100 dropped', () => {
  assert.deepEqual(normalize({ packs: { mode: 'allbut', on: ['ragebait', 'ragebait', 'Bad', 7, '', 'ai-tone'] } }).packs,
    { mode: 'allbut', on: ['ragebait', 'ai-tone'] });
  assert.equal(normalize({ packs: { mode: 'allow' } }).packs.mode, 'block');
  assert.deepEqual(normalize({ packs: [] }).packs, { mode: 'block', on: [] });
  const many = Array.from({ length: 120 }, (_, i) => `p${i}`);
  assert.deepEqual(normalize({ packs: { on: many } }).packs.on, many.slice(0, 100));
});

test('packs import: a good block is taken, ids that do not exist here dropped', () => {
  const r = parseImport(file({ packs: { mode: 'allbut', on: ['ragebait', 'mine', 'gone'] } }), DEFAULTS, ['ragebait', 'mine', 'other']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings.packs, { mode: 'allbut', on: ['ragebait', 'mine'] });
  assert.deepEqual(parseImport(file({ packs: { on: ['ragebait'] } }), DEFAULTS).settings.packs, { mode: 'block', on: [] });
});

test('packs import: a file without packs keeps the current block', () => {
  const cur = normalize({ packs: { mode: 'allbut', on: ['ragebait'] } });
  assert.deepEqual(parseImport(file(), cur, []).settings.packs, cur.packs);
});

test('packs import: a bad block is rejected whole', () => {
  const ids = Array.from({ length: 101 }, (_, i) => `p${i}`);
  for (const packs of [[], 'on', { mode: 'allow' }, { on: 'ragebait' }, { on: ['Bad'] }, { on: ids }]) {
    const r = parseImport(file({ packs }), DEFAULTS, ids);
    assert.equal(r.ok, false, JSON.stringify(packs).slice(0, 60));
    assert.match(r.reason, /^packs/);
  }
});

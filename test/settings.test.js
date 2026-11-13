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

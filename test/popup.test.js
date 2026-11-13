const test = require('node:test');
const assert = require('node:assert/strict');
const { seenCountries, visibleCountries, countRows, statusLines } = require('../popup/popup.js');
const { normalize } = require('../src/lib/settings.js');

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

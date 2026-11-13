const test = require('node:test');
const assert = require('node:assert/strict');
const { pickerList } = require('../src/lib/countries.js');

test('the list holds ISO countries by English name', () => {
  const list = pickerList();
  for (const name of ['Russia', 'United States', 'India', 'Kosovo']) assert.ok(list.includes(name), name);
  assert.ok(list.length > 240);
});

test('non-places are left out', () => {
  const list = pickerList();
  for (const name of ['Pseudo-Accents', 'Unknown Region', 'United Nations', 'European Union']) {
    assert.ok(!list.includes(name), name);
  }
});

test('values seen in the cache are merged once, sorted in, Unknown last', () => {
  const list = pickerList(['Europe', 'Russia', ' Europe ', 'Unknown', '', null]);
  assert.equal(list.filter((n) => n === 'Europe').length, 1);
  assert.equal(list.filter((n) => n === 'Russia').length, 1);
  assert.equal(list.filter((n) => n === 'Unknown').length, 1);
  assert.equal(list.at(-1), 'Unknown');
  const rest = list.slice(0, -1);
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b, 'en')));
});

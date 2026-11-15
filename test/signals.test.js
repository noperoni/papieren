const test = require('node:test');
const assert = require('node:assert/strict');
const signals = require('../src/lib/signals.js');
const { evaluate } = require('../src/lib/rules.js');

// One process per test file: this registry holds only the fakes below.
const calls = [];
const fake = (id, rank, answer, on = true) => ({
  id,
  rank,
  active: () => on,
  judge: (post) => {
    calls.push(id);
    return typeof answer === 'function' ? answer(post) : answer;
  },
});

signals.register(fake('late', 30, (post) => (post.facts?.bait ? { handle: post.author.handle, rule: 'pack:x', label: 'X' } : null)));
signals.register(fake('off', 5, () => { throw new Error('an inactive Signal was judged'); }, false));
signals.register(fake('early', 10, (post) => (post.facts?.wait ? { pending: post.author.handle } : null)));

const ctx = { settings: { paused: false }, filteredPage: true, isFocal: false, viewerId: 'v1' };
const post = (facts) => ({ author: { id: '1', handle: 'ann' }, facts });

test('register keeps rank order and refuses a duplicate id', () => {
  assert.deepEqual(signals.all().map((s) => s.id), ['off', 'early', 'late']);
  assert.throws(() => signals.register(fake('early', 99, null)), /registered twice/);
  assert.equal(signals.get('late').rank, 30);
  assert.equal(signals.get('nope'), undefined);
});

test('an inactive Signal is never judged; the active ones run by rank', () => {
  calls.length = 0;
  assert.deepEqual(evaluate(post({}), ctx), { hide: false });
  assert.deepEqual(calls, ['early', 'late']);
});

test('a later Match beats an earlier Pending; a Pending alone is "checking"', () => {
  assert.deepEqual(evaluate(post({ wait: true, bait: true }), ctx), { hide: true, why: 'match', handle: 'ann', rule: 'pack:x', label: 'X' });
  assert.deepEqual(evaluate(post({ wait: true }), ctx), { hide: true, why: 'checking', handle: 'ann', country: 'pending' });
});

test('the guards hold before any Signal: viewer, focal, unfiltered, paused', () => {
  calls.length = 0;
  const bait = post({ bait: true });
  assert.deepEqual(evaluate({ ...bait, author: { id: 'v1', handle: 'me' } }, ctx), { hide: false });
  assert.deepEqual(evaluate(bait, { ...ctx, isFocal: true }), { hide: false });
  assert.deepEqual(evaluate(bait, { ...ctx, filteredPage: false }), { hide: false });
  assert.deepEqual(evaluate(bait, { ...ctx, settings: { paused: true } }), { hide: false });
  assert.deepEqual(calls, []);
});

test('the viewer as reposter is left out of post.authors', () => {
  let seen;
  signals.register(fake('spy', 40, (p) => { seen = p.authors.map((a) => a.handle); return null; }));
  evaluate({ author: { id: '1', handle: 'ann' }, reposter: { id: 'v1', handle: 'me' } }, ctx);
  assert.deepEqual(seen, ['ann']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/lib/rules.js');
require('../src/signals/country.js');

const SHOW = { hide: false };
const author = (handle, country, id) => ({ id, handle, country });

function ctx(over = {}, settings = {}) {
  return {
    settings: { mode: 'block', countries: ['Russia', 'Europe', 'Unknown'], paused: false, ...settings },
    filteredPage: true,
    isFocal: false,
    viewerId: 'v1',
    lookupsStopped: false,
    ...over,
  };
}
const allow = (over = {}) => ctx(over, { mode: 'allow' });

test('exemptions: unfiltered page, focal post and pause show everything', () => {
  const p = { author: author('ivan', 'Russia') };
  assert.deepEqual(evaluate(p, ctx({ filteredPage: false })), SHOW);
  assert.deepEqual(evaluate(p, ctx({ isFocal: true })), SHOW);
  assert.deepEqual(evaluate(p, ctx({}, { paused: true })), SHOW);
  assert.deepEqual(evaluate({ author: author('x', 'pending') }, ctx({ isFocal: true }, { mode: 'allow' })), SHOW);
});

test('no identifiable author leaves the post visible (Req 7.5)', () => {
  assert.deepEqual(evaluate({}, ctx()), SHOW);
  assert.deepEqual(evaluate({}, allow()), SHOW);
});

test('block: listed country hides, unlisted shows', () => {
  assert.deepEqual(evaluate({ author: author('ivan', 'Russia') }, ctx()),
    { hide: true, why: 'match', rule: 'country', handle: 'ivan', label: 'Russia', country: 'Russia' });
  assert.deepEqual(evaluate({ author: author('joe', 'United States') }, ctx()), SHOW);
});

test('block: a listed region matches by its label (Req 1.4)', () => {
  assert.deepEqual(evaluate({ author: author('eu', 'Europe') }, ctx()),
    { hide: true, why: 'match', rule: 'country', handle: 'eu', label: 'Europe', country: 'Europe' });
});

test('block: null country counts as Unknown (Req 7.4)', () => {
  assert.deepEqual(evaluate({ author: author('anon', null) }, ctx()),
    { hide: true, why: 'match', rule: 'country', handle: 'anon', label: 'Unknown', country: 'Unknown' });
  assert.deepEqual(evaluate({ author: author('anon', null) }, ctx({}, { countries: [] })), SHOW);
});

test('block: pending authors stay visible (Req 1.2), even with lookups stopped', () => {
  assert.deepEqual(evaluate({ author: author('new', 'pending') }, ctx()), SHOW);
  assert.deepEqual(evaluate({ author: author('new', 'pending') }, ctx({ lookupsStopped: true })), SHOW);
});

test('block: a repost hides when either author matches (Req 1.6)', () => {
  const clean = author('joe', 'United States');
  const listed = author('ivan', 'Russia');
  assert.deepEqual(evaluate({ author: listed, reposter: clean }, ctx()),
    { hide: true, why: 'match', rule: 'country', handle: 'ivan', label: 'Russia', country: 'Russia' });
  assert.deepEqual(evaluate({ author: clean, reposter: listed }, ctx()),
    { hide: true, why: 'match', rule: 'country', handle: 'ivan', label: 'Russia', country: 'Russia' });
  assert.deepEqual(evaluate({ author: author('new', 'pending'), reposter: listed }, ctx()),
    { hide: true, why: 'match', rule: 'country', handle: 'ivan', label: 'Russia', country: 'Russia' });
  assert.deepEqual(evaluate({ author: clean, reposter: author('new', 'pending') }, ctx()), SHOW);
});

test('allow: listed shows, unlisted hides (Req 2.1)', () => {
  const c = allow();
  c.settings.countries = ['France'];
  assert.deepEqual(evaluate({ author: author('marie', 'France') }, c), SHOW);
  assert.deepEqual(evaluate({ author: author('joe', 'United States') }, c),
    { hide: true, why: 'match', rule: 'country', handle: 'joe', label: 'United States', country: 'United States' });
  assert.deepEqual(evaluate({ author: author('anon', null) }, c),
    { hide: true, why: 'match', rule: 'country', handle: 'anon', label: 'Unknown', country: 'Unknown' });
});

test('allow: pending is "checking" while lookups run, shown once stopped (Req 2.2, 7.3, 3.9)', () => {
  const p = { author: author('new', 'pending') };
  assert.deepEqual(evaluate(p, allow()),
    { hide: true, why: 'checking', handle: 'new', country: 'pending' });
  assert.deepEqual(evaluate(p, allow({ lookupsStopped: true })), SHOW);
});

test('allow: repost hides when either author is unlisted, a known miss beats checking', () => {
  const c = () => { const x = allow(); x.settings.countries = ['France']; return x; };
  const fr = author('marie', 'France');
  const us = author('joe', 'United States');
  const pending = author('new', 'pending');
  assert.deepEqual(evaluate({ author: fr, reposter: us }, c()),
    { hide: true, why: 'match', rule: 'country', handle: 'joe', label: 'United States', country: 'United States' });
  assert.deepEqual(evaluate({ author: us, reposter: fr }, c()),
    { hide: true, why: 'match', rule: 'country', handle: 'joe', label: 'United States', country: 'United States' });
  assert.deepEqual(evaluate({ author: pending, reposter: us }, c()),
    { hide: true, why: 'match', rule: 'country', handle: 'joe', label: 'United States', country: 'United States' });
  assert.deepEqual(evaluate({ author: fr, reposter: pending }, c()),
    { hide: true, why: 'checking', handle: 'new', country: 'pending' });
  assert.deepEqual(evaluate({ author: fr, reposter: author('luc', 'France') }, c()), SHOW);
});

test('viewer: own posts always show (Req 2.4), in both modes', () => {
  const me = author('me', 'Nowhere', 'v1');
  assert.deepEqual(evaluate({ author: me }, allow()), SHOW);
  assert.deepEqual(evaluate({ author: me, reposter: author('ivan', 'Russia') }, ctx()), SHOW);
});

test('viewer as reposter is not judged, the original author still is', () => {
  const me = author('me', 'pending', 'v1');
  const c = allow();
  c.settings.countries = ['France'];
  assert.deepEqual(evaluate({ author: author('marie', 'France'), reposter: me }, c), SHOW);
  assert.deepEqual(evaluate({ author: author('joe', 'United States'), reposter: me }, c),
    { hide: true, why: 'match', rule: 'country', handle: 'joe', label: 'United States', country: 'United States' });
});

test('no viewer id means no viewer exemption', () => {
  const p = { author: author('ivan', 'Russia') };
  assert.deepEqual(evaluate(p, ctx({ viewerId: undefined })).hide, true);
});

test('the confidence mark never changes a verdict (Req 8.5)', () => {
  const posts = [
    { author: author('ivan', 'Russia') },
    { author: author('joe', 'United States') },
    { author: author('new', 'pending') },
    { author: author('anon', null), reposter: author('marie', 'France') },
  ];
  for (const c of [ctx(), allow(), allow({ lookupsStopped: true })]) {
    for (const p of posts) {
      const base = evaluate(p, c);
      for (const k of ['confirmed', 'flagged', 'unverified']) {
        const marked = {
          author: p.author && { ...p.author, k, confidence: k },
          reposter: p.reposter && { ...p.reposter, k, confidence: k },
        };
        assert.deepEqual(evaluate(marked, c), base);
      }
    }
  }
});

// ---- Packs on the seam (packs design, rules.test.js) ----

const packsSignal = require('../src/signals/packs.js');
packsSignal.stored('packs:builtin', [{
  papierenPack: 1, id: 'bait', name: 'Bait', kind: 'junk', description: 'Asks for likes.', version: 1, threshold: 3,
  tells: [], languages: { en: [{ w: 3, on: 'text', phrase: 'like if you agree' }] },
}]);
const baitFacts = () => ({ sig: { packs: { text: 'like if you agree', lang: 'en', media: [], domains: [], reply: false, quote: false } } });
const withPacks = (over = {}, settings = {}) => ctx(over, { packs: { mode: 'block', on: ['bait'] }, ...settings });

test('packs: a Pack match beats a pending country and loses to a country match', () => {
  assert.deepEqual(evaluate({ author: author('bob', 'pending', '1'), facts: baitFacts() }, withPacks({}, { mode: 'allow' })),
    { hide: true, why: 'match', rule: 'pack:bait', handle: 'bob', label: 'Bait' });
  assert.equal(evaluate({ author: author('ivan', 'Russia', '1'), facts: baitFacts() }, withPacks()).rule, 'country');
  assert.deepEqual(evaluate({ author: author('bob', 'pending', '1'), facts: { sig: { packs: { text: 'hi', lang: 'en' } } } }, withPacks({}, { mode: 'allow' })),
    { hide: true, why: 'checking', handle: 'bob', country: 'pending' });
});

test('packs: viewer, focal post, pause and an unfiltered page are never hidden on a Pack (Req 2.4, 2.5)', () => {
  const p = (id) => ({ author: author('bob', 'France', id), facts: baitFacts() });
  assert.equal(evaluate(p('1'), withPacks()).rule, 'pack:bait');
  assert.deepEqual(evaluate(p('v1'), withPacks()), SHOW);
  assert.deepEqual(evaluate(p('1'), withPacks({ isFocal: true })), SHOW);
  assert.deepEqual(evaluate(p('1'), withPacks({ filteredPage: false })), SHOW);
  assert.deepEqual(evaluate(p('1'), withPacks({}, { paused: true })), SHOW);
  assert.deepEqual(evaluate(p('v1'), withPacks({}, { packs: { mode: 'allbut', on: ['bait'] } })), SHOW);
});

// Req 8.3 benchmark (packs design, Resource Budget): 20 Packs of 300 Tells
// and 100 Posts. Intake scoring is timed and reported; the mutation batch,
// which only reads the memo, must stay inside the 8 ms of country Req 9.2.
// The Patterns are built-in shapes (\b, one alternation, an optional s), not
// the worst checkPattern lets through: that cost is packs.test.js's.
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib/packs.js');
const { walkTimeline } = require('../src/lib/x-parse.js');
const packsSignal = require('../src/signals/packs.js');
const { evaluate } = require('../src/lib/rules.js');

// Seeded, so every run scores the same Packs and Posts.
let seed = 47;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
const WORDS = Array.from({ length: 3000 }, () => Array.from({ length: 3 + rand(6) }, () => 'abcdefghijklmnopqrstuvwxyz'[rand(26)]).join(''));
const word = () => WORDS[rand(WORDS.length)];
const words = (k) => Array.from({ length: k }, word).join(' ');
const weight = () => (rand(4) ? 1 : -1) * (1 + rand(4));
const DOMAINS = Array.from({ length: 50 }, () => `${word()}.com`);

function unique(n, make) {
  const out = new Map();
  while (out.size < n) {
    const t = make();
    out.set(`${t.on} ${t.phrase}`, t);
  }
  return [...out.values()];
}

function pack(i) {
  const text = [
    ...unique(200, () => ({ w: weight(), on: 'text', phrase: words(1 + rand(3)) })),
    ...Array.from({ length: 40 }, () => ({ w: weight(), on: 'text', pattern: `\\b(?:${word()}|${word()}|${word()}) ${word()}s?\\b` })),
  ];
  const tells = [
    ...unique(30, () => ({ w: weight(), on: rand(2) ? 'name' : 'bio', phrase: words(1 + rand(2)) })),
    ...Array.from({ length: 10 }, () => ({ w: weight(), on: rand(2) ? 'name' : 'bio', pattern: `\\b${word()} (?:${word()}|${word()})\\b` })),
    ...lib.MEASURES.map((measure) => ({ w: 1, on: 'shape', measure, min: measure === 'caps' ? 0.5 : 3 })),
    ...lib.MEDIA.map((has) => ({ w: 1, on: 'media', has })),
    ...Array.from({ length: 6 }, () => ({ w: 2, on: 'media', domain: DOMAINS[rand(DOMAINS.length)] })),
    ...lib.CONTEXTS.map((is) => ({ w: -1, on: 'context', is })),
  ];
  return {
    papierenPack: 1, id: `bench-${i}`, name: `Bench ${i}`, kind: 'junk', description: 'Benchmark.',
    version: 1, threshold: 6, tells, languages: { en: text },
  };
}

const PACKS = Array.from({ length: 20 }, (_, i) => pack(i));
const POSTS = Array.from({ length: 100 }, (_, i) => {
  const urls = Array.from({ length: rand(3) }, (_, k) => ({ url: `https://t.co/${k}`, expanded_url: `https://${DOMAINS[rand(DOMAINS.length)]}/x` }));
  const user = { __typename: 'User', rest_id: `u${i}`, core: { screen_name: `user${i}`, name: words(2) }, profile_bio: { description: words(15 + rand(20)) } };
  const full = words(30 + rand(50)).slice(0, 480);
  const legacy = { full_text: full, display_text_range: [0, full.length], lang: 'en', entities: { urls } };
  return { __typename: 'Tweet', rest_id: String(i + 1), core: { user_results: { result: user } }, legacy };
});
const PAYLOAD = JSON.stringify({ list: POSTS });
const walk = () => [...walkTimeline(PAYLOAD).tweets.values()];

const settings = { mode: 'block', countries: [], paused: false, packs: { mode: 'block', on: PACKS.map((p) => p.id) } };
const ctx = { settings, filteredPage: true, isFocal: false, viewerId: 'v', lookupsStopped: false };
const batch = (records) => records.map((r) => evaluate({ author: { ...r.author, country: null }, facts: r.facts }, ctx));
const timed = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

packsSignal.stored('packs:user', PACKS);
packsSignal.stored('packs:builtin', []);

test('20 Packs of 300 Tells: every Pack valid and whole', () => {
  assert.deepEqual(packsSignal.rules(settings), PACKS.map((p) => `pack:${p.id}`));
  for (const p of PACKS) {
    const r = lib.validate(p);
    assert.ok(r.ok, r.reason);
    assert.equal(r.pack.tells.length + r.pack.languages.en.length, 300);
  }
});

test('Req 8.3: the batch reads the memo inside 8 ms for 100 Posts; intake scoring reported', (t) => {
  const cold = walk();
  const first = timed(() => packsSignal.prepare(cold, { settings, viewerId: 'v' }));
  let intake = Infinity;
  let read = Infinity;
  for (let k = 0; k < 3; k++) {
    const records = walk();
    intake = Math.min(intake, timed(() => packsSignal.prepare(records, { settings, viewerId: 'v' })));
    read = Math.min(read, timed(() => batch(records)));
  }
  t.diagnostic(`intake, first with compile: ${first.toFixed(1)} ms; warm best of 3: ${intake.toFixed(1)} ms per 100 Posts`);
  t.diagnostic(`batch read: ${read.toFixed(2)} ms per 100 Posts; hidden ${batch(cold).filter((v) => v.hide).length} of 100`);
  assert.ok(read < 8, `batch read took ${read.toFixed(2)} ms`);

  // The batch never scores: every Post was scored at intake.
  const calls = t.mock.method(lib, 'score');
  batch(cold);
  assert.equal(calls.mock.callCount(), 0);
});

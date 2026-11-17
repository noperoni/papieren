// The shipped Pack files (packs design, task 6.1): every file valid with no
// Tell lost as a duplicate, the schema's enums the validator's, the example
// using every kind of Tell, and each Built_in_Pack hiding its invented bait
// while showing its plain Posts (test/fixtures/packs/<id>.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../src/lib/packs.js');
const { walkTimeline } = require('../src/lib/x-parse.js');
const packsSignal = require('../src/signals/packs.js');
const { evaluate } = require('../src/lib/rules.js');

const DIR = path.join(__dirname, '..', 'packs');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'pack.schema.json');
const BUILTIN = FILES.filter((f) => f !== 'example.json').map((f) => f.slice(0, -'.json'.length));
const allTells = (p) => [...(p.tells ?? []), ...Object.values(p.languages ?? {}).flat()];

test('every Pack file passes validate under its own file name, with no Tell dropped as a duplicate', () => {
  assert.deepEqual(BUILTIN.sort(), ['aggregator', 'ai-tone', 'engagement-bait', 'ragebait']);
  for (const f of FILES) {
    const r = lib.validate(read(f), { builtin: f !== 'example.json' });
    assert.ok(r.ok, `${f}: ${r.reason}`);
    assert.equal(`${r.pack.id}.json`, f);
    assert.equal(allTells(r.pack).length, allTells(JSON.parse(read(f))).length, `${f}: a Phrase repeated`);
  }
});

test('pack.schema.json: its enums are the validator\'s', () => {
  const s = JSON.parse(read('pack.schema.json'));
  assert.deepEqual(s.properties.kind.enum, lib.KINDS);
  assert.deepEqual(s.$defs.shapeTell.properties.measure.enum, lib.MEASURES);
  assert.deepEqual(s.$defs.mediaTell.properties.has.enum, lib.MEDIA);
  assert.deepEqual(s.$defs.contextTell.properties.is.enum, lib.CONTEXTS);
});

test('example.json uses every kind of Tell, every measure, a negative weight and two languages', () => {
  const { pack } = lib.validate(read('example.json'));
  const tells = allTells(pack);
  const kind = (t) => `${t.on}:${['phrase', 'pattern', 'measure', 'has', 'domain', 'is'].find((k) => k in t)}`;
  assert.deepEqual(new Set(tells.map(kind)), new Set([
    'text:phrase', 'text:pattern', 'name:phrase', 'name:pattern', 'bio:phrase', 'bio:pattern',
    'shape:measure', 'media:has', 'media:domain', 'context:is',
  ]));
  assert.deepEqual(new Set(tells.filter((t) => t.on === 'shape').map((t) => t.measure)), new Set(lib.MEASURES));
  assert.ok(tells.some((t) => t.w < 0));
  assert.ok(Object.keys(pack.languages).length >= 2);
});

// ---- each Built_in_Pack against its fixtures ----

// A fixture Post as X sends it: text HTML-escaped with its display range,
// hashtags and links as entities, name and bio where the user result has them.
let n = 0;
function record(p) {
  const id = String((n += 1));
  const full = p.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const legacy = {
    full_text: full, display_text_range: [0, [...full].length], lang: p.lang ?? 'en',
    entities: {
      hashtags: (p.text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map(() => ({})),
      urls: (p.urls ?? []).map((u, i) => ({ url: `https://t.co/${i}`, expanded_url: u })),
    },
  };
  if (p.media) legacy.extended_entities = { media: p.media.map((type) => ({ type })) };
  if (p.reply) legacy.in_reply_to_status_id_str = '1';
  if (p.quote) legacy.is_quote_status = true;
  const user = { __typename: 'User', rest_id: `u${id}`, core: { screen_name: 'someone', name: p.name ?? 'Someone' } };
  if (p.bio) user.profile_bio = { description: p.bio };
  const tweet = { __typename: 'Tweet', rest_id: id, core: { user_results: { result: user } }, legacy };
  return walkTimeline(JSON.stringify({ list: [tweet] })).tweets.get(id);
}

packsSignal.stored('packs:builtin', BUILTIN.map((id) => JSON.parse(read(`${id}.json`))));
packsSignal.stored('packs:user', []);

for (const id of BUILTIN) {
  test(`${id}: hides its bait and shows its plain Posts`, () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'packs', `${id}.json`), 'utf8'));
    const pack = lib.validate(read(`${id}.json`), { builtin: true }).pack;
    const settings = { mode: 'block', countries: [], paused: false, packs: { mode: 'block', on: [id] } };
    const ctx = { settings, filteredPage: true, isFocal: false, viewerId: 'v', lookupsStopped: false };
    const judged = (p) => {
      const r = record(p);
      const verdict = evaluate({ author: { ...r.author, country: null }, facts: r.facts }, ctx);
      const score = lib.score(lib.compile([pack]), { ...r.facts.sig.packs, repost: false }, [r.author.sig?.packs]).get(id);
      return { verdict, why: `score ${score} of ${pack.threshold}: ${p.text}` };
    };
    assert.ok(fx.hide.length >= 5 && fx.show.length >= 5);
    for (const p of fx.hide) {
      const { verdict, why } = judged(p);
      assert.equal(verdict.rule, `pack:${id}`, why);
      assert.equal(verdict.label, pack.name);
    }
    for (const p of fx.show) {
      const { verdict, why } = judged(p);
      assert.deepEqual(verdict, { hide: false }, why);
    }
  });
}

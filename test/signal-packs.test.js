const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib/packs.js');
const { walkTimeline } = require('../src/lib/x-parse.js');
const packsSignal = require('../src/signals/packs.js');
const { evaluate } = require('../src/lib/rules.js');

// Synthetic payload shapes as recorded in the captured payloads (design.md, Risks).
const user = (id, handle, extra = {}) => ({ __typename: 'User', rest_id: id, core: { screen_name: handle }, ...extra });
const tweet = (id, u, legacy = {}, extra = {}) => ({ __typename: 'Tweet', rest_id: id, core: { user_results: { result: u } }, legacy, ...extra });
const walk = (...tweets) => walkTimeline(JSON.stringify({ list: tweets })).tweets;
const factsOf = (t) => walk(t).get(t.rest_id).facts.sig.packs;

const pack = (over = {}) => ({
  papierenPack: 1, id: 'bait', name: 'Bait', kind: 'junk', description: 'Asks for likes.',
  version: 1, threshold: 3, tells: [], languages: {}, ...over,
});
const agree = (w = 3) => ({ en: [{ w, on: 'text', phrase: 'like if you agree' }] });
const settings = (on, mode = 'block') => ({ mode: 'block', countries: [], paused: false, packs: { mode, on } });
const ctx = (s, over = {}) => ({ settings: s, filteredPage: true, isFocal: false, viewerId: 'v1', lookupsStopped: false, ...over });
const load = (builtin = [], user = []) => {
  packsSignal.stored('packs:builtin', builtin);
  packsSignal.stored('packs:user', user);
};
// A judged post as content.js builds it, the Authors as AuthorStates.
const post = (text, over = {}) => ({
  author: { id: '1', handle: 'bob', country: null },
  facts: { sig: { packs: { text, lang: 'en', shape: { emoji: 0, length: 20 }, media: [], domains: [], reply: false, quote: false } } },
  ...over,
});

// ---- fromTweet, fromUser ----

test('fromTweet: display_text_range is cut by code points of the escaped text, then unescaped and folded', () => {
  // '@bob ' is 5 code points; 'Tom &amp; Jerry 🎉' is 17 escaped; the media link trails.
  const f = factsOf(tweet('1', user('2', 'amy'), {
    full_text: '@bob Tom &amp; JERRY 🎉 https://t.co/m', display_text_range: [5, 22], lang: 'en', entities: {},
  }));
  assert.equal(f.text, 'tom & jerry 🎉');
  assert.equal(f.lang, 'en');
  assert.deepEqual(f.shape, { emoji: 1, length: 13, hashtags: 0, lines: 1 });
});

test('fromTweet: a long post reads the whole note_tweet; hashtags absent, present, and no entities', () => {
  const long = `${'Word '.repeat(150)}end`;
  const f = factsOf(tweet('1', user('2', 'amy'), { full_text: 'Word Word…', entities: { hashtags: [{}, {}] } },
    { note_tweet: { note_tweet_results: { result: { text: long } } } }));
  assert.equal([...f.text].length, 500);
  assert.ok(f.text.startsWith('word word'));
  assert.equal(f.shape.length, [...long].length);
  assert.equal(f.shape.hashtags, 2);
  assert.equal(factsOf(tweet('3', user('2', 'amy'), { full_text: 'hi' })).shape.hashtags, undefined);
});

test('fromTweet: media types photo, video, animated_gif; a poll card; a card with no legacy', () => {
  const media = [{ type: 'photo' }, { type: 'video' }, { type: 'animated_gif' }, { type: 'photo' }];
  assert.deepEqual(factsOf(tweet('1', user('2', 'amy'), { full_text: 'x', extended_entities: { media } })).media, ['image', 'video', 'gif']);
  assert.deepEqual(factsOf(tweet('3', user('2', 'amy'), { full_text: 'x', entities: { media: [{ type: 'photo' }] } })).media, ['image']);
  assert.deepEqual(factsOf(tweet('4', user('2', 'amy'), { full_text: 'x' }, { card: { rest_id: 'c' } })).media, []);
  assert.deepEqual(factsOf(tweet('5', user('2', 'amy'), { full_text: 'x' }, { card: { legacy: { name: 'poll2choice_text_only' } } })).media, ['poll']);
  assert.deepEqual(factsOf(tweet('6', user('2', 'amy'), { full_text: 'x' }, { card: { legacy: { name: 'summary_large_image' } } })).media, []);
});

test('fromTweet: links give hosts, lowercased, www. dropped; a quote\'s own permalink is no link (Req 1.5)', () => {
  const perm = { url: 'https://t.co/q', expanded: 'https://twitter.com/amy/status/9', display: 'x.com/amy/status/9' };
  const urls = [
    { url: 'https://t.co/q', expanded_url: 'https://twitter.com/amy/status/9' },
    { url: 'https://t.co/a', expanded_url: 'https://WWW.Example.com/a' },
    { url: 'https://t.co/b', expanded_url: 'https://news.example.com/b' },
    { url: 'https://t.co/c', expanded_url: 'https://example.com/c' },
  ];
  const f = factsOf(tweet('1', user('2', 'amy'), { full_text: 'x', is_quote_status: true, quoted_status_permalink: perm, entities: { urls } }));
  assert.deepEqual(f.domains, ['example.com', 'news.example.com']);
  assert.deepEqual(f.media, ['link']);
  assert.equal(f.quote, true);
  const only = factsOf(tweet('3', user('2', 'amy'), { full_text: 'x', is_quote_status: true, quoted_status_permalink: perm, entities: { urls: urls.slice(0, 1) } }));
  assert.deepEqual([only.media, only.domains], [[], []]);
});

test('fromTweet: reply and quote flags; a repost carries the original\'s facts', () => {
  const r = factsOf(tweet('1', user('2', 'amy'), { full_text: 'x', in_reply_to_status_id_str: '7' }));
  assert.deepEqual([r.reply, r.quote], [true, false]);
  const original = tweet('5', user('6', 'bob'), { full_text: 'Like if you agree' });
  const pair = walk(tweet('4', user('2', 'amy'), { full_text: 'RT @bob: Like if…', retweeted_status_result: { result: original } })).get('4');
  assert.equal(pair.facts.sig.packs.text, 'like if you agree');
  assert.equal(pair.reposter.handle, 'amy');
});

test('fromUser: name from core.name and bio from profile_bio, folded, bio cut to 300; legacy as fallback', () => {
  const t = tweet('1', user('2', 'amy', { core: { screen_name: 'amy', name: '𝐂𝐑𝐘𝐏𝐓𝐎 Amy' }, profile_bio: { description: `Follow BACK ${'x'.repeat(400)}` } }), { full_text: 'x' });
  const a = walk(t).get('1').author;
  assert.equal(a.sig.packs.name, 'crypto amy');
  assert.equal([...a.sig.packs.bio].length, 300);
  assert.ok(a.sig.packs.bio.startsWith('follow back'));
  // userRef reads its bio from the same place.
  assert.ok(a.bio.startsWith('Follow BACK'));
  const old = walk(tweet('3', user('4', 'old', { legacy: { name: 'Old Name', description: 'Old bio' } }), { full_text: 'x' })).get('3').author;
  assert.deepEqual(old.sig.packs, { name: 'old name', bio: 'old bio' });
  assert.equal(walk(tweet('5', user('6', 'none'), { full_text: 'x' })).get('5').author.sig, undefined);
});

// ---- stored, active, rules ----

test('stored Packs: an invalid one and a user Pack taking a built-in id are left out of matching', () => {
  load([pack(), pack({ id: 'broken', threshold: 0 })], [pack({ name: 'Mine' }), pack({ id: 'mine', name: 'Mine' })]);
  assert.deepEqual(packsSignal.rules(settings(['bait', 'broken', 'mine'])), ['pack:bait', 'pack:mine']);
  assert.equal(packsSignal.active(settings(['broken'])), false);
  assert.equal(packsSignal.active(settings([])), false);
  assert.deepEqual(packsSignal.rules(settings(['bait'], 'allbut')), ['pack:bait', 'packs:outside']);
  load(undefined, 'not a list');
  assert.equal(packsSignal.active(settings(['bait'])), false);
});

// ---- judge ----

test('Blocklist: the Pack exceeding its Threshold by the most; a tie goes to the earlier in the list (Req 2.1, 7.2)', () => {
  const s = settings(['first', 'second']);
  load([pack({ id: 'first', name: 'First', languages: agree(3) }), pack({ id: 'second', name: 'Second', languages: agree(3) })]);
  assert.deepEqual(evaluate(post('like if you agree'), ctx(s)),
    { hide: true, why: 'match', handle: 'bob', rule: 'pack:first', label: 'First' });
  load([pack({ id: 'first', name: 'First', languages: agree(3) }), pack({ id: 'second', name: 'Second', languages: agree(5) })]);
  assert.equal(evaluate(post('like if you agree'), ctx(s)).rule, 'pack:second');
  assert.deepEqual(evaluate(post('nothing to see'), ctx(s)), { hide: false });
});

test('All_But: a post no Pack matches hides as outside your packs; no Pack facts, never hidden (Req 2.2, 2.6)', () => {
  const s = settings(['bait'], 'allbut');
  load([pack({ languages: agree() })]);
  assert.deepEqual(evaluate(post('a plain post'), ctx(s)),
    { hide: true, why: 'match', handle: 'bob', rule: 'packs:outside', label: 'outside your packs' });
  assert.deepEqual(evaluate(post('like if you agree'), ctx(s)), { hide: false });
  assert.deepEqual(evaluate({ author: { handle: 'bob', country: null } }, ctx(s)), { hide: false });
  assert.deepEqual(evaluate({ author: { handle: 'bob', country: null }, facts: { conv: 'c' } }, ctx(s)), { hide: false });
});

test('a repost names the reposted Post\'s Author; the reposter\'s bio adds to the Score (Req 1.4)', () => {
  load([pack({ tells: [{ w: 3, on: 'bio', phrase: 'follow back' }] })]);
  const p = () => post('hello', { reposter: { id: '9', handle: 'amy', country: null, sig: { packs: { bio: 'follow back always' } } } });
  assert.deepEqual(evaluate(p(), ctx(settings(['bait']))), { hide: true, why: 'match', handle: 'bob', rule: 'pack:bait', label: 'Bait' });
  // The viewer as reposter is no Author: their bio never counts.
  assert.deepEqual(evaluate(p(), ctx(settings(['bait']), { viewerId: '9' })), { hide: false });
});

test('prepare scores at intake; judge reads the memo, and scores again once after a Pack change', (t) => {
  const s = settings(['bait']);
  load([pack({ languages: agree() })]);
  const calls = t.mock.method(lib, 'score');
  const found = walk(
    tweet('1', user('2', 'amy'), { full_text: 'Like if you agree', lang: 'en' }),
    tweet('3', user('2', 'amy'), { full_text: 'Plain', lang: 'en' }),
  );
  const records = [found.get('1'), found.get('3')];
  packsSignal.prepare(records, { settings: s });
  assert.equal(calls.mock.callCount(), 2);
  const judged = (r) => evaluate({ author: { ...r.author, country: null }, facts: r.facts }, ctx(s));
  assert.equal(judged(records[0]).rule, 'pack:bait');
  assert.equal(judged(records[1]).hide, false);
  assert.equal(calls.mock.callCount(), 2);

  load([pack({ threshold: 4, languages: agree() })]);
  assert.equal(judged(records[0]).hide, false);
  assert.equal(judged(records[0]).hide, false);
  assert.equal(calls.mock.callCount(), 3);
});

test('prepare leaves the viewer out of the Score, as evaluate does', () => {
  const s = settings(['bait']);
  load([pack({ tells: [{ w: 3, on: 'bio', phrase: 'follow back' }] })]);
  const me = user('42', 'me', { profile_bio: { description: 'follow back' } });
  const [r] = walk(tweet('1', me, { retweeted_status_result: { result: tweet('5', user('6', 'bob'), { full_text: 'hi' }) } })).values();
  packsSignal.prepare([r], { settings: s, viewerId: '42' });
  const states = { author: { ...r.author, country: null }, reposter: { ...r.reposter, country: null }, facts: r.facts };
  assert.deepEqual(evaluate(states, ctx(s, { viewerId: '42' })), { hide: false });
});

// ---- account Tells ----

test('fromUser: checkmarks from verification, is_blue_verified and an affiliate label', () => {
  const badges = (extra) => walk(tweet('9', user('1', 'org', extra), { full_text: 'x' })).get('9').author.sig?.packs?.badges;
  assert.deepEqual(badges({ verification: { verified_type: 'Business' }, is_blue_verified: true }), ['gold']);
  assert.deepEqual(badges({ verification: { verified_type: 'Government' }, is_blue_verified: false }), ['grey']);
  assert.deepEqual(badges({ verification: { verified: false }, is_blue_verified: true }), ['blue']);
  const label = { label: { userLabelType: 'BusinessLabel', badge: { url: 'https://example.com/b.png' } } };
  assert.deepEqual(badges({ verification: { verified_type: 'Business' }, affiliates_highlighted_label: label }), ['gold', 'affiliate']);
  assert.equal(badges({ is_blue_verified: false, affiliates_highlighted_label: {} }), undefined);
});

test('judge: account Tells add at judge time, so behaviour that moves after intake re-judges without a re-score', () => {
  const p = pack({ threshold: 4, tells: [{ w: 2, on: 'account', is: 'everywhere' }, { w: -3, on: 'account', is: 'gold' }], languages: agree(3) });
  load([], [p]);
  const s = settings(['bait']);
  const a = post('like if you agree');
  packsSignal.prepare([{ author: a.author, facts: a.facts }], { settings: s });
  assert.deepEqual(evaluate(a, ctx(s)), { hide: false });
  a.author.acct = { is: new Set(['everywhere']), hidden: new Set() };
  assert.equal(evaluate(a, ctx(s)).rule, 'pack:bait');
  a.author.sig = { packs: { badges: ['gold'] } };
  assert.deepEqual(evaluate(a, ctx(s)), { hide: false });
});

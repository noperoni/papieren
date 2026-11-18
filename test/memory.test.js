const test = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../src/lib/memory.js');

const { normalize, fingerprint, createIndex, emptyFlags, observe, merge, judge, label } = memory;

const NOW = Date.UTC(2026, 10, 14, 12);
const HOUR = 60 * 60 * 1000;
const ALL_ON = { copy: true, everywhere: true, media: true, offender: true };
const ctx = (over = {}) => ({ on: ALL_ON, now: NOW, viewerId: 'v1', ...over });
const user = (id, extra = {}) => ({ id, handle: `user${id}`, ...extra });
const reply = (over = {}) => ({ author: user('1'), tweetId: '500', conv: 'c1', ...over });

// --- normalize and fingerprint (Req 3.6) ---

test('normalize: NFKC, lowercase, mentions and URLs out, whitespace collapsed', () => {
  assert.equal(normalize('@alice @bob_2  Buy NOW\n\thttps://t.co/AbC123 today'), 'buy now today');
  assert.equal(normalize('𝓒𝓻𝔂𝓹𝓽𝓸 is ＦＵＮ'), 'crypto is fun');
  assert.equal(normalize('mail me at ann@example.com'), 'mail me at ann@example.com');
  assert.equal(normalize('see http://x.com/@someone/status/1 ok'), 'see ok');
  assert.equal(normalize(undefined), '');
});

test('fingerprint: undefined under 20 characters, 16 hex characters from 20', async () => {
  assert.equal(await fingerprint('@who 1234567890123456789'), undefined); // 19 after normalize
  const fp = await fingerprint('12345678901234567890');
  assert.match(fp, /^[0-9a-f]{16}$/);
});

test('fingerprint: the same after normalising, different on one changed word', async () => {
  const a = await fingerprint('@one Great thread, thanks for sharing https://t.co/a');
  const b = await fingerprint('@two @three great   thread, THANKS for sharing https://t.co/b');
  const c = await fingerprint('@one Great thread, thanks for posting');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('fingerprint: no crypto.subtle means no fingerprint, not a throw', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    assert.equal(await fingerprint('a long enough text to be fingerprinted'), undefined);
  } finally {
    Object.defineProperty(globalThis, 'crypto', saved);
  }
});

// --- copy-paste (Req 3.1) ---

test('copy: the same Author twice counts once; 2 Authors no, 3 yes', () => {
  const index = createIndex();
  const see = (author) => observe(index, { kind: 'copy', key: 'f1', author, t: NOW });
  const post = reply({ fp: 'f1' });
  see('2'); see('2'); see('3');
  assert.equal(judge(post, emptyFlags(), index, ctx()), null);
  see('4');
  assert.deepEqual(judge(post, emptyFlags(), index, ctx()), { rule: 'bm:copy', handle: 'user1', n: 3 });
});

test('copy: the worker count and the tab count are never added, the larger wins', () => {
  const index = createIndex();
  observe(index, { kind: 'copy', key: 'f1', author: '2', t: NOW });
  const flags = emptyFlags();
  flags.copy.f1 = 2;
  assert.equal(judge(reply({ fp: 'f1' }), flags, index, ctx()), null);
  flags.copy.f1 = 4;
  assert.equal(judge(reply({ fp: 'f1' }), flags, index, ctx()).n, 4);
});

test('copy and everywhere: a post that is not a Reply is never hit', () => {
  const flags = emptyFlags();
  flags.copy.f1 = 9;
  flags.everywhere['1'] = 9;
  assert.equal(judge({ author: user('1'), tweetId: '500', fp: 'f1' }, flags, createIndex(), ctx()), null);
});

// --- reply-everywhere (Req 3.2) ---

test('everywhere: 4 conversations no, 5 yes, and only within 24 h', () => {
  const index = createIndex();
  const see = (conv, ago) => observe(index, { kind: 'conv', key: conv, author: '1', t: NOW - ago });
  see('c1', 0); see('c2', HOUR); see('c3', 2 * HOUR); see('c3', 3 * HOUR); see('c4', 23 * HOUR);
  see('c5', 24 * HOUR + 1);
  assert.equal(judge(reply(), emptyFlags(), index, ctx()), null);
  see('c6', 24 * HOUR);
  assert.deepEqual(judge(reply(), emptyFlags(), index, ctx()), { rule: 'bm:everywhere', handle: 'user1', n: 5 });
});

// --- recycled media (Req 3.3) ---

test('media: 3 Authors hide every post but the earliest seen with it', () => {
  const index = createIndex();
  const see = (author, tweet) => observe(index, { kind: 'media', key: 'm1', author, tweet, t: NOW });
  see('2', '1000'); see('3', '999'); see('1', '10001');
  const post = (tweetId, id) => ({ author: user(id), tweetId, media: ['m1'] });
  assert.equal(judge(post('999', '3'), emptyFlags(), index, ctx()), null);
  assert.deepEqual(judge(post('1000', '2'), emptyFlags(), index, ctx()), { rule: 'bm:media', handle: 'user2', n: 3 });
  assert.equal(judge(post('10001', '1'), emptyFlags(), index, ctx()).rule, 'bm:media');
});

test('media: the earliest is the smaller of the worker and tab tweet ids', () => {
  const index = createIndex();
  observe(index, { kind: 'media', key: 'm1', author: '2', tweet: '700', t: NOW });
  const flags = emptyFlags();
  flags.media.m1 = { n: 3, first: '650' };
  const post = (tweetId) => ({ author: user('1'), tweetId, media: ['m1'] });
  assert.equal(judge(post('650'), flags, index, ctx()), null);
  assert.equal(judge(post('700'), flags, index, ctx()).rule, 'bm:media');
});

test('media: 2 Authors is not enough', () => {
  const index = createIndex();
  observe(index, { kind: 'media', key: 'm1', author: '2', tweet: '1', t: NOW });
  observe(index, { kind: 'media', key: 'm1', author: '1', tweet: '2', t: NOW });
  assert.equal(judge({ author: user('1'), tweetId: '2', media: ['m1'] }, emptyFlags(), index, ctx()), null);
});

// --- repeat offender (Req 3.4) ---

test('offender: 4 hidden posts no, 5 yes; the reposter is judged too', () => {
  const index = createIndex();
  for (const tweet of ['1', '2', '3', '4', '4']) observe(index, { kind: 'offence', key: tweet, author: '9', t: NOW });
  const repost = { author: user('1'), reposter: user('9'), tweetId: '500' };
  assert.equal(judge(repost, emptyFlags(), index, ctx()), null);
  observe(index, { kind: 'offence', key: '5', author: '9', t: NOW });
  assert.deepEqual(judge(repost, emptyFlags(), index, ctx()), { rule: 'bm:offender', handle: 'user9', n: 5 });
});

test('offender: the worker\'s { n, first } and an older bare n both count', () => {
  const flags = emptyFlags();
  flags.offender[9] = { n: 5, first: { 'bm:copy': '1' } };
  flags.offender[8] = 5;
  assert.equal(judge({ author: user('9'), tweetId: '500' }, flags, createIndex(), ctx()).n, 5);
  assert.equal(judge({ author: user('8'), tweetId: '500' }, flags, createIndex(), ctx()).n, 5);
});

// --- account Tells' behaviour facts (packs design, account Tells) ---

const account = (u, flags, index, tweetId = '500') => memory.account(u, flags, index, { now: NOW, viewerId: 'v1', tweetId });

test('account: Reply_Everywhere from 5 conversations in 24 h, from the worker or the tab', () => {
  const index = createIndex();
  for (const c of ['c1', 'c2', 'c3', 'c4']) observe(index, { kind: 'conv', key: c, author: '1', t: NOW - HOUR });
  assert.deepEqual([...account(user('1'), emptyFlags(), index).is], []);
  observe(index, { kind: 'conv', key: 'c5', author: '1', t: NOW - HOUR });
  assert.deepEqual([...account(user('1'), emptyFlags(), index).is], ['everywhere']);
  const flags = emptyFlags();
  flags.everywhere[2] = 5;
  assert.deepEqual([...account(user('2'), flags, createIndex()).is], ['everywhere']);
});

test('account: offences from 2 detections, with no upper bound', () => {
  const index = createIndex();
  observe(index, { kind: 'offence', key: '100', author: '1', rule: 'bm:everywhere', t: NOW });
  assert.equal(account(user('1'), emptyFlags(), index).is.has('offences'), false);
  observe(index, { kind: 'offence', key: '101', author: '1', rule: 'bm:everywhere', t: NOW });
  assert.equal(account(user('1'), emptyFlags(), index).is.has('offences'), true);
  const flags = emptyFlags();
  flags.offender[1] = { n: 9, first: {} };
  assert.equal(account(user('1'), flags, createIndex()).is.has('offences'), true);
});

test('account: copy, recycled and hidden-before only from an older Post, never the Post itself', () => {
  const index = createIndex();
  observe(index, { kind: 'offence', key: '400', author: '1', rule: 'bm:copy', t: NOW });
  observe(index, { kind: 'pack', key: '400', author: '1', rule: 'pack:ragebait', t: NOW });
  const flags = emptyFlags();
  flags.offender[1] = { n: 1, first: { 'bm:media': '450' } };
  flags.packs[1] = { n: 1, first: { 'pack:bait': '600' } };
  const later = account(user('1'), flags, index, '500');
  assert.deepEqual([...later.is].sort(), ['copy', 'recycled']);
  assert.deepEqual([...later.hidden], ['ragebait']);
  const itself = account(user('1'), flags, index, '400');
  assert.deepEqual([[...itself.is], [...itself.hidden]], [[], []]);
  // A shorter id is older whatever its digits: '99' before '400'.
  observe(index, { kind: 'pack', key: '99', author: '1', rule: 'pack:bait', t: NOW });
  assert.deepEqual([...account(user('1'), flags, index, '400').hidden], ['bait']);
});

test('account: none for the viewer, a followed Author or one without an id (Req 3.8)', () => {
  const flags = emptyFlags();
  flags.everywhere.v1 = 9;
  flags.everywhere[3] = 9;
  assert.equal(account(user('v1'), flags, createIndex()), undefined);
  assert.equal(account(user('3', { followed: true }), flags, createIndex()), undefined);
  assert.equal(account({ handle: 'nobody' }, flags, createIndex()), undefined);
});

// --- order, switches, exemptions (Req 3.5, 3.8) ---

test('judge order: copy, then everywhere, then media, then offender', () => {
  const flags = emptyFlags();
  flags.copy.f1 = 3;
  flags.everywhere['1'] = 5;
  flags.media.m1 = { n: 3, first: '1' };
  flags.offender['1'] = 5;
  const post = reply({ fp: 'f1', media: ['m1'] });
  const rule = (on) => judge(post, flags, createIndex(), ctx({ on }))?.rule;
  assert.equal(rule(ALL_ON), 'bm:copy');
  assert.equal(rule({ ...ALL_ON, copy: false }), 'bm:everywhere');
  assert.equal(rule({ ...ALL_ON, copy: false, everywhere: false }), 'bm:media');
  assert.equal(rule({ offender: true }), 'bm:offender');
  assert.equal(rule({}), undefined);
});

test('a followed Author, the viewer and an Author without id are never judged', () => {
  const flags = emptyFlags();
  flags.copy.f1 = 9;
  flags.offender['1'] = 9;
  flags.offender.v1 = 9;
  const index = createIndex();
  assert.equal(judge(reply({ fp: 'f1', author: user('1', { followed: true }) }), flags, index, ctx()), null);
  assert.equal(judge(reply({ fp: 'f1', author: user('v1') }), flags, index, ctx()), null);
  assert.equal(judge(reply({ fp: 'f1', author: { handle: 'dom_only' } }), flags, index, ctx()), null);
  const repost = { author: user('2'), reposter: user('1', { followed: true }), tweetId: '5' };
  assert.equal(judge(repost, flags, index, ctx()), null);
});

// --- index caps and merge (Req 7.4) ---

test('the index keeps its newest 5,000 keys per map', () => {
  const index = createIndex();
  for (let i = 0; i <= 5000; i += 1) observe(index, { kind: 'copy', key: `f${i}`, author: '1', t: NOW });
  assert.equal(index.copy.size, 5000);
  assert.equal(index.copy.has('f0'), false);
  assert.equal(index.copy.has('f5000'), true);
});

test('the index caps each map at 5,000 entries, inner ones included: the least recently touched key goes', () => {
  const index = createIndex();
  const offence = (author, tweet) => observe(index, { kind: 'offence', key: tweet, author, rule: 'bm:copy', t: NOW });
  offence('a', '1');
  for (let i = 0; i < 4999; i += 1) offence('b', `${100 + i}`);
  assert.equal(index.n.offence, 5000);
  offence('a', '2'); // a moves to the newest end, so b is the oldest
  assert.deepEqual([...index.offence.keys()], ['a']);
  assert.equal(index.n.offence, 2);
  for (let i = 0; i < 5001; i += 1) offence('c', `${i}`); // one key over the cap on its own goes too
  assert.equal(index.offence.size, 0);
  assert.equal(index.n.offence, 0);
});

test('everywhere: a conversation past 24 h leaves the index at the Author\'s next sighting', () => {
  const index = createIndex();
  const conv = (key, t) => observe(index, { kind: 'conv', key, author: '1', t });
  conv('c1', NOW - 25 * HOUR);
  conv('c2', NOW - 24 * HOUR);
  conv('c3', NOW);
  assert.deepEqual([...index.conv.get('1').keys()], ['c2', 'c3']);
  assert.equal(index.n.conv, 2);
});

test('merge: counts replace, zero and null drop the key', () => {
  const flags = emptyFlags();
  flags.copy.a = 3;
  flags.media.m = { n: 3, first: '1' };
  merge(flags, { copy: { a: 0, b: 4 }, media: { m: { n: 0 } }, offender: { x: 5 }, everywhere: { y: null } });
  assert.deepEqual(flags, { copy: { b: 4 }, everywhere: {}, media: {}, offender: { x: 5 }, packs: {} });
  merge(flags, undefined);
  assert.deepEqual(flags.copy, { b: 4 });
});

// --- labels (Req 6.1) ---

test('labels name the handle, the detection and its count', () => {
  assert.equal(label({ rule: 'bm:copy', handle: 'bot', n: 4 }), 'Hidden: @bot · copy-paste reply, 4 accounts (click to show)');
  assert.equal(label({ rule: 'bm:everywhere', handle: 'bot', n: 6 }), 'Hidden: @bot · replies everywhere, 6 conversations in 24 h (click to show)');
  assert.equal(label({ rule: 'bm:media', handle: 'bot', n: 3 }), 'Hidden: @bot · recycled media, 3 accounts (click to show)');
  assert.equal(label({ rule: 'bm:offender', handle: 'bot', n: 7 }), 'Hidden: @bot · repeat offender, 7 detections (click to show)');
});

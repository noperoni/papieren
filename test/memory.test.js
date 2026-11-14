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

test('merge: counts replace, zero and null drop the key', () => {
  const flags = emptyFlags();
  flags.copy.a = 3;
  flags.media.m = { n: 3, first: '1' };
  merge(flags, { copy: { a: 0, b: 4 }, media: { m: { n: 0 } }, offender: { x: 5 }, everywhere: { y: null } });
  assert.deepEqual(flags, { copy: { b: 4 }, everywhere: {}, media: {}, offender: { x: 5 } });
  merge(flags, undefined);
  assert.deepEqual(flags.copy, { b: 4 });
});

// --- labels (Req 6.1) ---

test('labels name the handle, the detection and its count', () => {
  assert.equal(label({ rule: 'bm:copy', handle: 'bot', n: 4 }), 'Hidden: @bot · copy-paste reply, 4 accounts (click to show)');
  assert.equal(label({ rule: 'bm:everywhere', handle: 'bot', n: 6 }), 'Hidden: @bot · replies everywhere, 6 conversations in 24 h (click to show)');
  assert.equal(label({ rule: 'bm:media', handle: 'bot', n: 3 }), 'Hidden: @bot · recycled media, 3 accounts (click to show)');
  assert.equal(label({ rule: 'bm:offender', handle: 'bot', n: 7 }), 'Hidden: @bot · repeat offender, hidden 7 times (click to show)');
});

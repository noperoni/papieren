const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../src/lib/feed.js');
const { parseAbout } = require('../src/lib/x-parse.js');

const ABOUT = fs.readFileSync(path.join(__dirname, 'fixtures', 'about-legacy.json'), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const RL = { remaining: 40, reset: 1_800_000_000 };

test('fresh: an entry answers for 30 days (Req 3.3)', () => {
  assert.equal(feed.fresh({ t: NOW - 30 * DAY + 1 }, NOW), true);
  assert.equal(feed.fresh({ t: NOW - 30 * DAY }, NOW), false);
  assert.equal(feed.fresh(undefined, NOW), false);
});

test('authorState: cached country, stale still decides, none is pending', () => {
  const none = { id: undefined, handle: undefined };
  assert.deepEqual(feed.authorState({ id: '1', handle: 'ivan' }, { c: 'Russia', t: 0 }, none), { id: '1', handle: 'ivan', country: 'Russia' });
  assert.deepEqual(feed.authorState({ handle: 'ivan' }, { c: null, t: 0 }, none), { handle: 'ivan', country: null });
  assert.deepEqual(feed.authorState({ handle: 'ivan' }, undefined, none), { handle: 'ivan', country: 'pending' });
});

test('authorState: a DOM-only author is the viewer when the handle matches, case aside (Req 2.4)', () => {
  const viewer = { id: '42', handle: 'Me_Myself' };
  assert.equal(feed.authorState({ handle: 'me_myself' }, undefined, viewer).id, '42');
  assert.equal(feed.authorState({ handle: 'ivan' }, undefined, viewer).id, undefined);
  assert.equal(feed.authorState({ id: '7', handle: 'me_myself' }, undefined, viewer).id, '7');
});

test('entryOf: every Req 8.1 field from a lookup, and a gone account as no country', () => {
  assert.deepEqual(feed.entryOf(parseAbout(ABOUT, 'Ivan_Example'), NOW), { c: 'Russia', a: true, k: 'confirmed', s: 'Russia', id: '1001', t: NOW });
  assert.deepEqual(feed.entryOf({ ok: false, error: 'gone', code: 63 }, NOW), { c: null, a: true, k: 'unverified', t: NOW });
});

test('label: one line with handle, country and only a real confidence mark (Req 5.1, 8.4)', () => {
  const v = { hide: true, why: 'match', handle: 'ivan', country: 'Russia' };
  assert.equal(feed.label(v, { k: 'confirmed' }), 'Hidden: @ivan · Russia · confirmed (click to show)');
  assert.equal(feed.label(v, { k: 'flagged' }), 'Hidden: @ivan · Russia · flagged (click to show)');
  assert.equal(feed.label(v, { k: 'unverified' }), 'Hidden: @ivan · Russia (click to show)');
  assert.equal(feed.label({ ...v, country: 'Unknown' }, { k: 'unverified', c: null }), 'Hidden: @ivan · Unknown (click to show)');
  assert.equal(feed.label({ hide: true, why: 'checking', handle: 'olga', country: 'pending' }), "Checking @olga's country (click to show)");
});

test('outcome: a good answer is cached and reported as a success', () => {
  const out = feed.outcome('Ivan_Example', { status: 200, rateLimit: RL, body: ABOUT }, false, NOW, parseAbout);
  assert.deepEqual(out.report, { ok: true, status: 200, rateLimit: RL });
  assert.equal(out.entry.c, 'Russia');
});

test('outcome: a gone account is cached as Unknown with no failure', () => {
  const out = feed.outcome('ghost', { status: 200, rateLimit: RL, body: '{"errors":[{"code":63}]}' }, false, NOW, parseAbout);
  assert.equal(out.report.ok, true);
  assert.equal(out.entry.c, null);
});

test('outcome: a 429 reports the rate limit, caches nothing (Req 3.4)', () => {
  assert.deepEqual(feed.outcome('ivan', { status: 429, rateLimit: { reset: 5 }, body: '' }, false, NOW, parseAbout),
    { report: { ok: false, status: 429, rateLimit: { reset: 5 } } });
});

test('outcome: a 404 on a sniffed query id drops it unreported; on the fallback it counts', () => {
  assert.deepEqual(feed.outcome('ivan', { status: 404, body: '' }, false, NOW, parseAbout), { dropQid: true });
  assert.deepEqual(feed.outcome('ivan', { status: 404, body: '' }, true, NOW, parseAbout),
    { report: { ok: false, status: 404, rateLimit: {} } });
});

test('outcome: refused, auth, mismatch and shape failures count and cache nothing', () => {
  for (const res of [{ status: 0 }, { status: 403, body: '' }, { status: 200, body: ABOUT }, { status: 200, body: '{}' }]) {
    const out = feed.outcome('someone_else', res, true, NOW, parseAbout);
    assert.equal(out.report.ok, false);
    assert.equal(out.entry, undefined);
  }
});

test('enqueue: newest on top, a repeat moves up, capped at 25 with the oldest dropped', () => {
  const q = [];
  for (let i = 0; i < 26; i++) feed.enqueue(q, `u${i}`);
  assert.equal(q.length, 25);
  assert.equal(q[0], 'u1');
  feed.enqueue(q, 'u5');
  assert.equal(q.at(-1), 'u5');
  assert.equal(q.filter((h) => h === 'u5').length, 1);
});

test('remember: capped at 5,000, oldest out, a repost pair survives a standalone sighting', () => {
  const map = new Map();
  feed.remember(map, new Map(Array.from({ length: 5001 }, (_, i) => [String(i), { author: { id: 'a', handle: 'a' } }])));
  assert.equal(map.size, 5000);
  assert.ok(!map.has('0') && map.has('5000'));

  const pair = { author: { id: '1', handle: 'orig' }, reposter: { id: '2', handle: 'rt' } };
  feed.remember(map, new Map([['9', pair]]));
  feed.remember(map, new Map([['9', { author: pair.author }]]));
  assert.equal(map.get('9').reposter.handle, 'rt');
});

test('viewerIdFrom reads twid and nothing else', () => {
  assert.equal(feed.viewerIdFrom('guest_id=1; twid=u%3D42; ct0=x'), '42');
  assert.equal(feed.viewerIdFrom('xtwid=u%3D42'), undefined);
  assert.equal(feed.viewerIdFrom(undefined), undefined);
});

test('stats: hidden posts by country with confidence counts (Req 5.4, 8.4)', () => {
  const hidden = [{ country: 'Russia', k: 'confirmed' }, { country: 'Russia', k: 'flagged' }, { country: 'Unknown', k: 'unverified' }];
  assert.deepEqual(feed.stats(hidden), {
    Russia: { n: 2, confirmed: 1, flagged: 1 },
    Unknown: { n: 1, confirmed: 0, flagged: 0 },
  });
});

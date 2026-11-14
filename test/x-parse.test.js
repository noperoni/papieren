const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseAbout, walkTimeline } = require('../src/lib/x-parse.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const aboutWith = (profile, handle = 'someone') => JSON.stringify({
  data: { user_result_by_screen_name: { result: { rest_id: '9', core: { screen_name: handle }, about_profile: profile } } },
});

test('parseAbout: legacy answer, App Store source confirms the country', () => {
  assert.deepEqual(parseAbout(fixture('about-legacy.json'), 'ivan_example'), {
    ok: true, country: 'Russia', accurate: true, via: 'Russia', confidence: 'confirmed', id: '1001',
  });
});

test('parseAbout: rebuilt answer (provisional: same path until a later spike), Web gives no via', () => {
  assert.deepEqual(parseAbout(fixture('about-rebuilt.json'), 'EU_Example'), {
    ok: true, country: 'Europe', accurate: true, confidence: 'unverified', id: '1002',
  });
});

test('parseAbout: location_accurate false flags the region even when via agrees', () => {
  assert.deepEqual(parseAbout(fixture('about-inaccurate.json'), 'region_example'), {
    ok: true, country: 'South Asia', accurate: false, via: 'South Asia', confidence: 'flagged', id: '1003',
  });
});

test('parseAbout: confidence from via and created country (Req 8.2, 8.3)', () => {
  const k = (profile) => parseAbout(aboutWith(profile), 'someone').confidence;
  const base = { account_based_in: 'France', location_accurate: true };
  assert.equal(k({ ...base, source: 'Germany App Store' }), 'flagged');
  assert.equal(k({ ...base, source: 'Germany App Store', created_country: 'France' }), 'confirmed');
  assert.equal(k({ ...base, source: 'Web', created_country: 'France' }), 'confirmed');
  assert.equal(k({ ...base, created_country: 'Spain' }), 'flagged');
  assert.equal(k({ ...base, source: 'Android App' }), 'unverified');
  assert.equal(k({ ...base }), 'unverified');
});

test('parseAbout: missing location_accurate counts as accurate', () => {
  const r = parseAbout(aboutWith({ account_based_in: 'France', source: 'France App Store' }), 'someone');
  assert.equal(r.accurate, true);
  assert.equal(r.confidence, 'confirmed');
});

test('parseAbout: no account_based_in means country null', () => {
  const r = parseAbout(aboutWith({ location_accurate: true }), 'someone');
  assert.equal(r.ok, true);
  assert.equal(r.country, null);
});

test('parseAbout: errors 50 and 63 mean the account is gone', () => {
  for (const code of [50, 63]) {
    const body = JSON.stringify({ errors: [{ code, message: 'x' }], data: {} });
    assert.deepEqual(parseAbout(body, 'someone'), { ok: false, error: 'gone', code });
  }
});

test('parseAbout: other GraphQL errors without data are api errors', () => {
  const body = JSON.stringify({ errors: [{ code: 200, message: 'x' }] });
  assert.deepEqual(parseAbout(body, 'someone'), { ok: false, error: 'api', code: 200 });
});

test('parseAbout: a different returned handle is a mismatch, case aside', () => {
  assert.deepEqual(parseAbout(fixture('about-legacy.json'), 'someone_else'), { ok: false, error: 'mismatch' });
  assert.equal(parseAbout(fixture('about-legacy.json'), 'IVAN_EXAMPLE').ok, true);
});

test('parseAbout: anything off the expected path is a shape error', () => {
  for (const body of ['not json', 'null', '{}', '{"data":{}}', aboutWith('nope'), aboutWith({}, '')]) {
    assert.deepEqual(parseAbout(body, 'someone'), { ok: false, error: 'shape' }, body);
  }
});

test('walkTimeline: plain, visibility-wrapped and repost entries', () => {
  const { tweets } = walkTimeline(fixture('timeline-home.json'));
  assert.deepEqual(tweets.get('2001'), { author: { id: '1001', handle: 'ivan_example', bio: 'plain tweet author' } });
  assert.deepEqual(tweets.get('2002'), { author: { id: '1002', handle: 'marie_example' } });
  const pair = { author: { id: '1004', handle: 'nadia_example' }, reposter: { id: '1003', handle: 'joe_example' } };
  assert.deepEqual(tweets.get('2003'), pair);
  assert.deepEqual(tweets.get('2004'), pair, 'the repost cell permalink carries the original id');
  assert.equal(tweets.size, 4, 'tombstones are skipped');
});

test('walkTimeline: the reposter survives the original appearing on its own', () => {
  const user = (id, handle) => ({ core: { user_results: { result: { rest_id: id, core: { screen_name: handle } } } } });
  const original = { __typename: 'Tweet', rest_id: '20', ...user('2', 'orig') };
  const repost = { __typename: 'Tweet', rest_id: '30', ...user('3', 'rt'), legacy: { retweeted_status_result: { result: original } } };
  for (const entries of [[original, repost], [repost, original]]) {
    const { tweets } = walkTimeline(JSON.stringify({ entries }));
    assert.equal(tweets.get('20').reposter?.handle, 'rt');
  }
});

test('walkTimeline: bios are cut to 300 characters', () => {
  const body = JSON.stringify({ __typename: 'Tweet', rest_id: '1',
    core: { user_results: { result: { rest_id: '2', core: { screen_name: 'long' }, legacy: { description: 'b'.repeat(500) } } } } });
  assert.equal(walkTimeline(body).tweets.get('1').author.bio.length, 300);
});

test('walkTimeline: a payload that does not parse yields an empty map', () => {
  assert.equal(walkTimeline('<html>').tweets.size, 0);
  assert.equal(walkTimeline('').tweets.size, 0);
});

test('walkTimeline: legacy.screen_name is read when core has none', () => {
  const body = JSON.stringify({ __typename: 'Tweet', rest_id: '1',
    core: { user_results: { result: { rest_id: '2', legacy: { screen_name: 'old_shape' } } } } });
  assert.equal(walkTimeline(body).tweets.get('1').author.handle, 'old_shape');
});

// --- Facts for behaviour memory (database Req 3.1 to 3.3, 3.8) ---

const userOf = (id, handle, extra = {}) => ({ user_results: { result: { rest_id: id, core: { screen_name: handle }, ...extra } } });
const tweetOf = (id, legacy, extra = {}) => ({ __typename: 'Tweet', rest_id: id, core: userOf('9', 'someone'), legacy, ...extra });
const walk = (node) => walkTimeline(JSON.stringify({ entries: [node] })).tweets;

test('walkTimeline facts: a Reply carries its conversation and text', () => {
  const t = walk(tweetOf('1', { conversation_id_str: '100', in_reply_to_status_id_str: '100', full_text: '@a so true' }));
  assert.deepEqual(t.get('1').facts, { conv: '100', text: '@a so true' });
});

test('walkTimeline facts: a long post reads note_tweet before full_text', () => {
  const note = { note_tweet: { note_tweet_results: { result: { text: 'the whole long text' } } } };
  const t = walk(tweetOf('1', { conversation_id_str: '100', in_reply_to_status_id_str: '5', full_text: 'the whole…' }, note));
  assert.equal(t.get('1').facts.text, 'the whole long text');
});

test('walkTimeline facts: a post that is not a Reply has no conv and no text', () => {
  const t = walk(tweetOf('1', { conversation_id_str: '1', full_text: 'top-level post' }));
  assert.equal(t.get('1').facts, undefined);
});

test('walkTimeline facts: media ids from extended_entities, deduplicated, else entities', () => {
  const m = (...ids) => ids.map((id_str) => ({ id_str }));
  let t = walk(tweetOf('1', { extended_entities: { media: m('7', '8', '7') }, entities: { media: m('7') } }));
  assert.deepEqual(t.get('1').facts, { media: ['7', '8'] });
  t = walk(tweetOf('1', { entities: { media: m('6') } }));
  assert.deepEqual(t.get('1').facts, { media: ['6'] });
});

test('walkTimeline facts: a repost takes the original\'s facts, never the wrapper\'s', () => {
  const original = tweetOf('20', { extended_entities: { media: [{ id_str: 'm1' }] } });
  const wrapper = { __typename: 'Tweet', rest_id: '30', core: userOf('3', 'rt'),
    legacy: { extended_entities: { media: [{ id_str: 'wrapper' }] }, retweeted_status_result: { result: original } } };
  for (const entries of [[original, wrapper], [wrapper, original]]) {
    const { tweets } = walkTimeline(JSON.stringify({ entries }));
    assert.deepEqual(tweets.get('30').facts, { media: ['m1'] });
    assert.deepEqual(tweets.get('20').facts, { media: ['m1'] });
  }
});

test('walkTimeline: followed only when X says the viewer follows', () => {
  const by = (extra) => walk({ __typename: 'Tweet', rest_id: '1', core: userOf('2', 'x', extra) }).get('1').author.followed;
  assert.equal(by({ relationship_perspectives: { following: true } }), true);
  assert.equal(by({ legacy: { following: true } }), true);
  assert.equal(by({ legacy: { following: 'true' } }), undefined);
  assert.equal(by({ relationship_perspectives: { following: false } }), undefined);
  assert.equal(by({}), undefined);
});

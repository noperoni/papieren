const test = require('node:test');
const assert = require('node:assert/strict');
const { legacy, rebuilt, detect, parsePermalink, isFilteredPage, focalId } = require('../src/lib/variants.js');

test('legacy lookup URL: fixed host, URL-encoded variables (Req 4.2)', () => {
  const url = new URL(legacy.lookupUrl('XRqGa7EeokUU5kppkh13EA', 'ivan_example'));
  assert.equal(url.origin, 'https://x.com');
  assert.equal(url.pathname, '/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery');
  assert.deepEqual(JSON.parse(url.searchParams.get('variables')), { screenName: 'ivan_example' });
  assert.equal(legacy.lookupUrl('q', 'a').includes('{'), false);
});

test('legacy lookup URL: a hostile query id cannot leave the endpoint', () => {
  const url = new URL(legacy.lookupUrl('../../1.1/blocks/create?x=', 'a'));
  assert.equal(url.origin, 'https://x.com');
  assert.match(url.pathname, /^\/i\/api\/graphql\/[^/]+\/AboutAccountQuery$/);
});

test('permalinks: relative and absolute, extra segments, query strings', () => {
  assert.deepEqual(parsePermalink('/ivan_example/status/123'), { handle: 'ivan_example', tweetId: '123' });
  assert.deepEqual(parsePermalink('https://x.com/Ivan/status/456/photo/1'), { handle: 'Ivan', tweetId: '456' });
  assert.deepEqual(parsePermalink('/joe/status/789?s=20'), { handle: 'joe', tweetId: '789' });
});

test('permalinks: mobile hosts, as Firefox for Android renders them', () => {
  assert.deepEqual(parsePermalink('https://m.x.com/Ivan/status/456'), { handle: 'Ivan', tweetId: '456' });
  assert.deepEqual(parsePermalink('https://mobile.twitter.com/joe/status/789?s=20'), { handle: 'joe', tweetId: '789' });
});

test('permalinks: anything else is null (Req 7.5 leaves the post visible)', () => {
  for (const href of [undefined, null, '', '/home', '/ivan', '/ivan/status/', '/ivan/status/12a',
    '/ivan/status/123abc', 'https://evil.com/ivan/status/1', '/a_handle_far_too_long/status/1',
    'https://evil.m.x.com/ivan/status/1', 'https://m.x.com.evil.com/ivan/status/1', 'https://www.x.com/ivan/status/1']) {
    assert.equal(parsePermalink(href), null, String(href));
  }
});

test('filtered pages: home, conversations and search only (Req 1.5)', () => {
  for (const p of ['/home', '/ivan/status/123', '/ivan/status/123/photo/1', '/search', '/search?q=x']) {
    assert.equal(isFilteredPage(p), true, p);
  }
  for (const p of ['/', '/home/', '/notifications', '/ivan', '/ivan/with_replies', '/i/lists/1', '/explore']) {
    assert.equal(isFilteredPage(p), false, p);
  }
});

test('focal id comes from the status path only', () => {
  assert.equal(focalId('/ivan/status/123'), '123');
  assert.equal(focalId('/ivan/status/123/photo/1'), '123');
  assert.equal(focalId('/home'), undefined);
});

// Shapes seen in spike T0 (2026-11-13, logged out). Selectors are checked
// live in the browser: node has no DOM.
const fakeDoc = ({ appVersion = false, reactRoot = false }) => ({
  documentElement: { hasAttribute: (n) => appVersion && n === 'data-app-version' },
  getElementById: (id) => (reactRoot && id === 'react-root' ? {} : null),
});

test('detect: <html data-app-version> is the rebuilt app, #react-root without it is legacy, neither is unknown', () => {
  assert.equal(detect(fakeDoc({ appVersion: true })), rebuilt);
  assert.equal(detect(fakeDoc({ appVersion: true, reactRoot: true })), rebuilt);
  assert.equal(detect(fakeDoc({ reactRoot: true })), legacy);
  assert.equal(detect(fakeDoc({})), null);
});

test('rebuilt lookup URL: api.x.com, Relay variables, hostile query id stays put (Req 4.2)', () => {
  const url = new URL(rebuilt.lookupUrl('3M2SBIjPPDiTvMXkIWTx_w', 'ivan_example'));
  assert.equal(url.origin, 'https://api.x.com');
  assert.equal(url.pathname, '/graphql/3M2SBIjPPDiTvMXkIWTx_w/AboutAccountQuery');
  assert.deepEqual(JSON.parse(url.searchParams.get('variables')),
    { screenName: 'ivan_example', __relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider: true });
  const evil = new URL(rebuilt.lookupUrl('../../1.1/blocks/create?x=', 'a'));
  assert.equal(evil.origin, 'https://api.x.com');
  assert.match(evil.pathname, /^\/graphql\/[^/]+\/AboutAccountQuery$/);
});

test('rebuilt readPost: author and id from the frame\'s data-href; no frame (focal post) or no permalink is null', () => {
  const cell = (href) => ({ querySelector: () => (href === undefined ? null : { getAttribute: () => href }) });
  assert.deepEqual(rebuilt.readPost(cell('/Ivan_Example/status/2120962835547033790')),
    { handle: 'Ivan_Example', tweetId: '2120962835547033790' });
  assert.equal(rebuilt.readPost(cell(undefined)), null);
  assert.equal(rebuilt.readPost(cell('/Ivan_Example')), null);
});

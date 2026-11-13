const test = require('node:test');
const assert = require('node:assert/strict');
const { legacy, parsePermalink, isFilteredPage, focalId } = require('../src/lib/variants.js');

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

test('permalinks: anything else is null (Req 7.5 leaves the post visible)', () => {
  for (const href of [undefined, null, '', '/home', '/ivan', '/ivan/status/', '/ivan/status/12a',
    '/ivan/status/123abc', 'https://evil.com/ivan/status/1', '/a_handle_far_too_long/status/1']) {
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

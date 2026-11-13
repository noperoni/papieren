// Runs src/page-hook.js in a sandbox with a fake window, XHR and fetch, to
// pin the account-safety boundary: one GET shape, whitelisted headers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'page-hook.js'), 'utf8');
const LOOKUP = 'https://x.com/i/api/graphql/QID/AboutAccountQuery?variables=%7B%22screenName%22%3A%22ivan%22%7D';
const flush = () => new Promise((r) => setTimeout(r, 0));

function loadHook({ cookie = 'guest_id=1; ct0=csrf123; twid=u%3D1' } = {}) {
  const document = new EventTarget();
  document.cookie = cookie;
  const events = [];
  document.addEventListener('papieren:from-page', (e) => events.push(JSON.parse(e.detail)));

  const network = [];
  const fetch = async (url, init) => {
    network.push({ url: String(url), init });
    return new Response('{"answer":1}', {
      status: 200,
      headers: { 'x-rate-limit-limit': '50', 'x-rate-limit-remaining': '42', 'x-rate-limit-reset': '1800000000' },
    });
  };
  class XMLHttpRequest extends EventTarget {
    open() {}
    setRequestHeader() {}
    send() {}
  }
  const window = { fetch };
  vm.runInContext(SOURCE, vm.createContext({
    window, document, XMLHttpRequest, location: { href: 'https://x.com/home' },
    URL, Headers, Request, Response, CustomEvent,
  }));

  const rawToPage = (detail) => document.dispatchEvent(new CustomEvent('papieren:to-page', { detail }));
  const toPage = (msg) => rawToPage(JSON.stringify(msg));
  const xFetch = (url, init) => window.fetch(url, init); // X's own call through the wrapper
  return { window, events, network, toPage, rawToPage, xFetch, XMLHttpRequest };
}

async function withBearer(opts) {
  const hook = loadHook(opts);
  await hook.xFetch('https://x.com/i/api/graphql/HQ/HomeTimeline?v=1', { headers: { authorization: 'Bearer TOKEN' } });
  await flush();
  hook.network.length = 0;
  hook.events.length = 0;
  return hook;
}

test('leaves no globals behind', () => {
  const ctx = { window: { fetch() {} }, document: new EventTarget(), XMLHttpRequest: class {}, location: { href: 'https://x.com/' },
    URL, Headers, Request, Response, CustomEvent };
  vm.runInContext(SOURCE, vm.createContext(ctx));
  assert.deepEqual(Object.keys(ctx).sort(), ['CustomEvent', 'Headers', 'Request', 'Response', 'URL', 'XMLHttpRequest', 'document', 'location', 'window']);
});

test('fetch: bearer capture emits ready once, timeline answers are forwarded', async () => {
  const hook = loadHook();
  const res = await hook.xFetch('https://x.com/i/api/graphql/HQ/HomeTimeline?v=1', { headers: { authorization: 'Bearer TOKEN' } });
  assert.equal(await res.text(), '{"answer":1}', "X still reads its own response");
  await hook.xFetch('https://x.com/i/api/graphql/HQ/HomeLatestTimeline', { headers: { authorization: 'Bearer TOKEN' } });
  await flush();
  assert.deepEqual(hook.events, [
    { kind: 'ready' },
    { kind: 'payload', op: 'HomeTimeline', body: '{"answer":1}' },
    { kind: 'payload', op: 'HomeLatestTimeline', body: '{"answer":1}' },
  ]);
});

test('a bearer on a non-X host is never captured', async () => {
  const hook = loadHook();
  await hook.xFetch('https://evil.example/graphql/Q/HomeTimeline', { headers: { authorization: 'Bearer STOLEN' } });
  await flush();
  assert.deepEqual(hook.events, []);
});

test('XHR: bearer, qid sniffing and passive About capture (Req 3.8)', () => {
  const hook = loadHook();
  const xhr = new hook.XMLHttpRequest();
  xhr.open('GET', '/i/api/graphql/ABOUTQ/AboutAccountQuery?variables=%7B%22screenName%22%3A%22Marie%22%7D');
  xhr.setRequestHeader('Authorization', 'Bearer TOKEN');
  xhr.send();
  Object.assign(xhr, { status: 200, responseType: '', responseText: '{"data":1}' });
  xhr.dispatchEvent(new Event('load'));
  assert.deepEqual(hook.events, [
    { kind: 'qid', variant: 'legacy', qid: 'ABOUTQ' },
    { kind: 'ready' },
    { kind: 'about', handle: 'Marie', body: '{"data":1}' },
  ]);
});

test('XHR: failed answers and unrelated ops are not forwarded', () => {
  const hook = loadHook();
  for (const [url, status] of [['/i/api/graphql/Q/HomeTimeline', 500], ['/i/api/graphql/Q/CreateTweet', 200]]) {
    const xhr = new hook.XMLHttpRequest();
    xhr.open('POST', url);
    xhr.send();
    Object.assign(xhr, { status, responseType: '', responseText: '{}' });
    xhr.dispatchEvent(new Event('load'));
  }
  assert.deepEqual(hook.events, []);
});

test('lookup: one GET, whitelisted headers, live ct0, rate-limit headers returned', async () => {
  const hook = await withBearer();
  hook.toPage({ kind: 'lookup', reqId: 7, url: LOOKUP });
  await flush();
  assert.equal(hook.network.length, 1);
  const { url, init } = hook.network[0];
  assert.equal(url, LOOKUP);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'include');
  assert.equal('body' in init, false);
  assert.deepEqual({ ...init.headers }, { // spread: the object comes from the sandbox realm
    authorization: 'Bearer TOKEN',
    'x-csrf-token': 'csrf123',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'accept-language': 'en-US',
  });
  assert.deepEqual(hook.events, [{
    kind: 'lookup-result', reqId: 7, status: 200,
    rateLimit: { limit: 50, remaining: 42, reset: 1800000000 }, body: '{"answer":1}',
  }]);
});

test('lookup: the rebuilt host is allowed on its own path', async () => {
  const hook = await withBearer();
  hook.toPage({ kind: 'lookup', reqId: 1, url: 'https://api.x.com/graphql/Q/AboutAccountQuery?variables=%7B%7D' });
  await flush();
  assert.equal(hook.network.length, 1);
});

test('lookup: everything else is refused before the network (Req 4.1, 4.2)', async () => {
  const hook = await withBearer();
  const refused = [
    'https://x.com/i/api/graphql/Q/CreateTweet',
    'https://x.com/i/api/1.1/blocks/create.json?screen_name=ivan',
    'https://x.com/i/api/graphql/Q/AboutAccountQuery/../../1.1/mutes/users/create.json',
    'https://x.com/i/api/graphql/Q/AboutAccountQueryX',
    'http://x.com/i/api/graphql/Q/AboutAccountQuery',
    'https://x.com:8443/i/api/graphql/Q/AboutAccountQuery',
    'https://user:pw@x.com/i/api/graphql/Q/AboutAccountQuery',
    'https://x.com.evil.example/i/api/graphql/Q/AboutAccountQuery',
    'https://evil.example/i/api/graphql/Q/AboutAccountQuery',
    'https://api.x.com/i/api/graphql/Q/AboutAccountQuery',
    'https://x.com/graphql/Q/AboutAccountQuery',
    'not a url',
    undefined,
  ];
  refused.forEach((url, i) => hook.toPage({ kind: 'lookup', reqId: i, url }));
  await flush();
  assert.deepEqual(hook.network, []);
  assert.equal(hook.events.length, refused.length);
  for (const e of hook.events) assert.deepEqual({ ...e, reqId: 0 }, { kind: 'lookup-result', reqId: 0, status: 0, rateLimit: {}, body: '' });
});

test('lookup: refused without a bearer or without ct0', async () => {
  const noBearer = loadHook();
  noBearer.toPage({ kind: 'lookup', reqId: 1, url: LOOKUP });
  const noCsrf = await withBearer({ cookie: 'twid=u%3D1' });
  noCsrf.toPage({ kind: 'lookup', reqId: 2, url: LOOKUP });
  await flush();
  assert.equal(noBearer.network.length + noCsrf.network.length, 0);
  assert.equal(noBearer.events.at(-1).status, 0);
  assert.equal(noCsrf.events.at(-1).status, 0);
});

test('hello is answered with ready only once a bearer exists', async () => {
  const hook = loadHook();
  hook.toPage({ kind: 'hello' });
  assert.deepEqual(hook.events, []);
  const ready = await withBearer();
  ready.toPage({ kind: 'hello' });
  assert.deepEqual(ready.events, [{ kind: 'ready' }]);
});

test('malformed messages are ignored', async () => {
  const hook = await withBearer();
  const lookup = { kind: 'lookup', reqId: 7, url: LOOKUP };
  for (const detail of ['not json', JSON.stringify({ ...lookup, reqId: '7' }), '{"kind":"mute"}', lookup, null]) {
    hook.rawToPage(detail);
  }
  await flush();
  assert.deepEqual(hook.network, []);
  assert.deepEqual(hook.events, []);
});

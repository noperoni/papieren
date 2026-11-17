// The feed rows of the packs P table (packs task 10) against fakex.js, so
// nothing reaches X. Each check gets a fresh profile, the built-ins copied
// in by the install. Inside b.sw(() => ...) the function runs in the worker,
// where t is the helper set from harness.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './harness.js';
import { fakeX, post, cellState } from './fakex.js';

async function until(fn, what, ms = 12_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const hidden = (page, id, label) => until(async () => {
  const s = await cellState(page, id);
  return s?.mark === 'hidden' && label.test(s.label) && s;
}, `post ${id} hidden as ${label}`);
const shown = (page, id) => until(async () => {
  const s = await cellState(page, id);
  return s && s.mark !== 'hidden' && s.mark !== 'checking';
}, `post ${id} shown`);

// Scored 8 by Engagement bait against its Threshold of 6 (the built-in phrases).
const BAIT = 'Like if you agree. Follow for more!';
const HOME = [post(1, 'baiter', { text: BAIT }), post(2, 'plain', { text: 'The bridge reopens on Monday.' }), post(3, 'francais', { lang: 'fr', text: BAIT })];

async function setup(tc, packs) {
  const b = await launch();
  tc.after(() => b.close());
  await until(() => b.sw(() => t.peek('packs:builtin').then((l) => l?.length === 4)), 'built-ins copied');
  await b.sw((p) => t.set({ packs: p }), packs);
  const x = await fakeX(b.ctx);
  x.set('/home', HOME);
  return { b, x, page: await x.open('/home') };
}

test('P2.1, P3.1, P7.1 Blocklist: the bait post hidden under the Pack name, other languages and plain posts shown', async (tc) => {
  const { b, x, page } = await setup(tc, { mode: 'block', on: ['engagement-bait'] });
  await hidden(page, '1', /^Hidden: @baiter · Engagement bait \(click to show\)$/);
  await shown(page, '2');
  await shown(page, '3');

  await tc.test('P7.4 the popup counts the hide under the Pack', async () => {
    const p = await b.popup({ tabOf: page });
    const rows = await p.locator('#counts tbody tr').allTextContents();
    assert.deepEqual(rows, ['Engagement bait1']);
  });

  await tc.test('P2.1 a Pack switched off shows its posts without a reload', async () => {
    await b.sw(() => t.set({ packs: { mode: 'block', on: [] } }));
    await shown(page, '1');
    await b.sw(() => t.set({ packs: { mode: 'block', on: ['engagement-bait'] } }));
    await hidden(page, '1', /Engagement bait/);
  });

  await tc.test('P6.5 and P8.1 no request goes anywhere but the fake x.com and the extension', () => {
    const odd = x.requests.filter((u) => !(
      u.startsWith(`chrome-extension://${b.id}/`)
      || /^https:\/\/x\.com\/(home|favicon\.ico)$/.test(u)
      || /^https:\/\/x\.com\/i\/api\/graphql\/fakeQid0+\/HomeTimeline\?variables=/.test(u)));
    assert.deepEqual(odd, []);
  });
});

test('P2.2, P7.3 All_But: what no Pack matches is hidden as outside your packs; P2.3 with none on, nothing', async (tc) => {
  const { b, page } = await setup(tc, { mode: 'allbut', on: ['engagement-bait'] });
  await shown(page, '1');
  await hidden(page, '2', /^Hidden: @plain · outside your packs \(click to show\)$/);
  await hidden(page, '3', /outside your packs/);
  const p = await b.popup({ tabOf: page });
  assert.deepEqual(await p.locator('#counts tbody tr').allTextContents(), ['Outside your packs2']);

  await b.sw(() => t.set({ packs: { mode: 'allbut', on: [] } }));
  for (const id of ['1', '2', '3']) await shown(page, id);
});

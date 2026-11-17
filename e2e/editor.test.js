// The editor tab's rows of the packs P table (packs tasks 9 and 10): the
// popup/packs.html page and the worker only, so nothing here touches X. Each
// check gets a fresh profile, the built-ins copied in by the install.
// Inside b.sw(() => ...) the function runs in the worker, where t is the
// helper set from harness.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, download } from './harness.js';

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function fresh(tc) {
  const b = await launch();
  tc.after(() => b.close());
  await until(() => b.sw(() => t.peek('packs:builtin').then((l) => l?.length === 4)), 'built-ins copied');
  return b;
}

async function editor(b) {
  const page = await b.ctx.newPage();
  await page.goto(`chrome-extension://${b.id}/popup/packs.html`);
  await page.locator('#list button').first().waitFor();
  return page;
}

const user = (b) => b.sw(() => t.peek('packs:user').then((l) => l ?? []));
const on = (b) => b.sw(() => t.peek('settings').then((s) => s?.packs?.on ?? []));
const noted = (p, want) => until(async () => {
  const text = await p.locator('#note').textContent();
  return want instanceof RegExp ? want.test(text) : text === want;
}, `note ${want}`);
const pick = (p, name) => p.locator('#list button', { hasText: name }).first().click();

test('P5.1 a built-in is read-only; Edit a copy records it and takes its place in packs.on', async (tc) => {
  const b = await fresh(tc);
  await b.sw(() => t.set({ packs: { mode: 'block', on: ['ragebait', 'engagement-bait'] } }));
  const p = await editor(b);
  assert.equal(await p.locator('#list button[aria-current]').textContent(), 'Engagement bait');
  assert.ok(await p.locator('#name').evaluate((x) => x.readOnly));
  assert.ok(await p.locator('#kind').isDisabled());
  assert.equal(await p.locator('#save').isHidden(), true);
  assert.equal(await p.locator('#delete').isHidden(), true);

  await p.locator('#copy').click();
  await noted(p, 'Made Engagement bait (copy), switched on in place of the built-in.');
  const [copy] = await user(b);
  assert.equal(copy.id, 'engagement-bait-copy');
  assert.deepEqual(copy.from, { id: 'engagement-bait', version: 1 });
  assert.deepEqual(await on(b), ['ragebait', 'engagement-bait-copy']);
  assert.equal(await p.locator('#list button[aria-current]').textContent(), 'Engagement bait (copy)');
  assert.equal(await p.locator('#name').evaluate((x) => x.readOnly), false);
  assert.equal(await p.locator('#about').textContent(), 'A copy of Engagement bait v1.');

  // A copy of a built-in that was off stays off.
  await pick(p, 'AI-tone');
  await p.locator('#copy').click();
  await noted(p, /^Made .+ \(copy\)\.$/);
  assert.deepEqual(await on(b), ['ragebait', 'engagement-bait-copy']);
});

test('P5.4 a bad Pattern is refused with its line and reason and saves nothing; a good edit bumps the version', async (tc) => {
  const b = await fresh(tc);
  const p = await editor(b);
  await p.locator('#copy').click();
  await noted(p, /^Made /);
  const before = (await user(b))[0];

  const en = p.locator('textarea[data-lang="en"]');
  await en.fill(`${await en.inputValue()}\n2 /(a+)+$/`);
  await p.locator('#save').click();
  const lines = (await en.inputValue()).split('\n').length;
  await noted(p, new RegExp(`^Not saved: Language en, line ${lines}: `));
  assert.deepEqual((await user(b))[0], before, 'nothing saved');

  await en.fill((await en.inputValue()).split('\n').slice(0, -1).join('\n'));
  await p.locator('#threshold').fill('5');
  await p.locator('#save').click();
  await noted(p, 'Saved, version 2.');
  const after = (await user(b))[0];
  assert.deepEqual([after.version, after.threshold], [2, 5]);
  await p.locator('#save').click();
  await noted(p, 'Nothing to save.');
});

test('P6.1 to P6.3 export then import round trip; an invalid file is refused whole', async (tc) => {
  const b = await fresh(tc);
  const p = await editor(b);
  await pick(p, 'Ragebait');
  const file = await download(p, () => p.locator('#export').click());
  assert.equal(file.name, 'papieren-pack-ragebait.json');

  const put = (name, text) => p.locator('#import').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  const bad = JSON.parse(file.text);
  bad.languages.en.push({ w: 1, on: 'text', pattern: '(a+)+' });
  await put('bad.json', JSON.stringify(bad));
  await noted(p, /^Not imported: languages\.en/);
  assert.deepEqual(await user(b), [], 'nothing added');

  await put(file.name, file.text);
  await noted(p, 'Imported Ragebait as "ragebait-2", switched off.');
  const [added] = await user(b);
  assert.deepEqual(added, { ...JSON.parse(file.text), id: 'ragebait-2' });
  assert.deepEqual(await on(b), [], 'added switched off');
});

test('P5.3 and P5.5 New pack from the template, Delete asks twice, the 101st pack refused', async (tc) => {
  const b = await fresh(tc);
  const p = await editor(b);
  await p.locator('#new').click();
  await noted(p, /^Made My pack:/);
  assert.match(await p.locator('#any').inputValue(), /^# One tell per line/);
  assert.match(await p.locator('textarea[data-lang="en"]').inputValue(), /^# Phrases/);
  assert.equal((await user(b))[0].id, 'my-pack');

  await p.locator('#delete').click();
  assert.equal(await p.locator('#delete').textContent(), 'Click again to delete');
  await p.locator('#name').focus();
  assert.equal(await p.locator('#delete').textContent(), 'Delete', 'focus away disarms');
  await p.locator('#delete').click();
  await p.locator('#delete').click();
  await noted(p, 'Deleted My pack.');
  assert.deepEqual(await user(b), []);

  await b.sw(() => chrome.storage.local.set({ 'packs:user': Array.from({ length: 96 }, (_, i) => ({
    papierenPack: 1, id: `p${i}`, name: `P${i}`, kind: 'topic', description: 'Filler.', version: 1, threshold: 1, tells: [], languages: {},
  })) }));
  await until(async () => (await p.locator('#list li').count()) === 100, 'the list follows storage');
  await p.locator('#new').click();
  await noted(p, 'Not made: Papieren holds at most 100 packs: delete one first.');
  assert.equal((await user(b)).length, 96);
});

test('invalid stored pack marked with its reason; a full storage keeps the old pack (Error Handling)', async (tc) => {
  const b = await fresh(tc);
  await b.sw(() => chrome.storage.local.set({ 'packs:user': [
    { papierenPack: 1, id: 'hand-edited', name: 'Hand edited', kind: 'junk', description: 'x', version: 1, threshold: 0, tells: [], languages: {} },
    { papierenPack: 1, id: 'fine', name: 'Fine', kind: 'junk', description: 'x', version: 1, threshold: 2, tells: [], languages: {} },
  ] }));
  const p = await editor(b);
  await pick(p, 'Hand edited');
  assert.equal(await p.locator('#about').textContent(),
    'Invalid: threshold must be a whole number from 1 to 100. It is left out of filtering. Delete it, or fix its file and import it again.');
  assert.ok(await p.locator('#form').isHidden());

  await pick(p, 'Fine');
  await p.evaluate(() => {
    chrome.storage.local.set = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
  });
  await p.locator('#threshold').fill('3');
  await p.locator('#save').click();
  await noted(p, 'Not saved: QUOTA_BYTES quota exceeded.');
  assert.equal((await user(b))[1].threshold, 2, 'the old pack stays');
});

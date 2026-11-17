# Live runs on real x.com

## Read this first

X's Terms of Service, section 4, allow access only through X's "published interfaces" and forbid scraping. X's Automation rules say "scripting the X website ... may result in the permanent suspension of your account".

A live run drives a real, logged-in x.com in a browser, which is scripting the X website. This page describes how the live run is built and gives a template, for educational purposes: how a browser extension can be checked against the real site, and where a fake one stops being enough. The scripts the maintainer runs (`live.js`, `login.js` and the live half of `footprint.js`) are not in the public repository.

If you build one from the template, run it on a secondary account you can afford to lose, never your main one, and expect that X may suspend it.

## Why a live run exists

`npm test` in this directory checks Papieren against `fakex.js`, a routed x.com that answers every request itself. Its payloads are shaped like X's, and it is only as true to X as those shapes. A live run catches what the fake cannot: a renamed field, a changed timeline, markup the adapters in `src/lib/variants.js` no longer recognise.

## How it is built

- **A profile of its own.** A plain Chromium, not a Playwright one, opens x.com's login page on a dedicated profile directory under `e2e/.profiles/` (gitignored). You log in by hand and close the window; the session stays in the profile. A browser Playwright launched gets a login page whose button does nothing, so the login is plain.
- **A real window.** `launch({ headless: false, userDataDir })` in `harness.js` starts that Chromium with the unpacked extension and `--remote-debugging-port=0`, then attaches Playwright over CDP with `noDefaults`. Headless Chromium announces itself to X, and Playwright's own launch keeps every tab visible, so the hidden-tab checks could never run.
- **A clean extension.** Before and after the run, the extension's `storage.local`, `storage.session` and IndexedDB database are wiped, keeping only the built-in Packs, so the profile keeps nothing but the X session.
- **Lookups off.** Country lookups stay off for the whole run: every country comes from a cache entry seeded through the worker, as in the manual rows of `TESTING.md`.
- **The checks.** One `test` per `TESTING.md` row it covers, in the order a person would run them: a seeded country hides its posts, Hidden_History and Rule_Statistics rows reach the database, a placeholder reveals on click, recycled media is detected, accounts you follow never reach behaviour memory, flushes keep their 5 s spacing and stop while the tab is hidden, and a built-in Pack hides posts on a live search.
- **A leak check.** A `request` listener on the browser context records every request the extension's own pages or worker send. The run fails if any of them goes anywhere but the extension itself.
- **Footprint.** A separate script scrolls a timeline for 30 minutes twice, without and with Papieren, and compares the tab's memory after a full garbage collection (row D7.4). Its fake-X half is the same measurement without the network.

## Template

Log the profile in once. `--password-store=basic` must match what `harness.js` launches with, or the run cannot decrypt the saved cookies.

```sh
chromium --user-data-dir=e2e/.profiles/secondary --password-store=basic https://x.com/login
```

Then a run, headed, one row at a time. The worker helpers (`t.seed`, `t.set`, `t.rows`, `t.watch`) are the ones `harness.js` installs, and the same ones `TESTING.md` pastes into the worker console.

```js
// live.js: node --test --test-concurrency=1 live.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './harness.js';

const PROFILE = new URL('./.profiles/secondary', import.meta.url).pathname;

// Storage, session and database wiped: a fresh install that keeps the X session.
const reset = (b) => b.sw(async () => {
  const builtin = (await chrome.storage.local.get('packs:builtin'))['packs:builtin'] ?? [];
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ 'packs:builtin': builtin });
  await chrome.storage.session.clear();
  await new Promise((done) => {
    const r = indexedDB.deleteDatabase('papieren');
    r.onsuccess = r.onblocked = r.onerror = done;
  });
});

test('live rows on a secondary account', { timeout: 15 * 60_000 }, async (tc) => {
  const b = await launch({ headless: false, userDataDir: PROFILE });
  tc.after(async () => {
    await reset(b).catch(() => {});
    await b.close();
  });

  const ext = `chrome-extension://${b.id}/`;
  const leaks = [];
  b.ctx.on('request', (r) => {
    let from = '';
    try {
      from = r.serviceWorker()?.url() ?? r.frame().url();
    } catch { /* a request with no frame left */ }
    if (from.startsWith(ext) && !r.url().startsWith(ext) && !r.url().startsWith('blob:')) leaks.push(r.url());
  });

  await reset(b);
  const page = b.ctx.pages()[0] ?? await b.ctx.newPage();
  await page.goto('https://x.com/home');
  // TODO: fail here if X shows its login flow: the profile needs logging in again.

  await tc.test('1.1: a seeded country hides its posts', async () => {
    // TODO: read a handle off the timeline, then
    //   await b.sw((h) => t.seed(h, 'France'), handle);
    //   await b.sw(() => t.set({ countries: ['France'] }));
    // and wait for that post's placeholder.
  });

  // TODO: one tc.test per TESTING.md row you want checked on real X.

  await tc.test('no request leaves the extension', () => assert.deepEqual(leaks, []));
});
```

// Browser harness for papieren/TESTING.md: a fresh Chromium profile with the
// unpacked extension loaded, the worker console's helpers, and the popup.
// Lives in its own package so papieren/package.json stays dependency-free.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const EXT = resolve(import.meta.dirname, '..');
const BROWSER = process.env.PAPIEREN_CHROMIUM ?? '/usr/bin/chromium';

// The helpers TESTING.md has pasted into the worker console, installed as
// globalThis.t so a check reads like the manual row it replaces. Installed
// once per worker life, so watch()'s record survives between calls.
function installHelpers() {
  if (globalThis.t) return;
  const { db, settings } = globalThis.Papieren;
  globalThis.t = {
    seed: (handle, c, more = {}) =>
      chrome.storage.local.set({ ['c:' + handle.toLowerCase()]: { c, a: true, k: 'unverified', t: Date.now(), ...more } }),
    peek: async (key) => (await chrome.storage.local.get(key))[key],
    cacheCount: async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('c:')).length,
    rows: async (store) => {
      const out = [];
      await db.tx([store], 'readonly', (tx) => db.each(tx, store, null, null, (v) => { out.push(v); }));
      return out;
    },
    put: (store, ...list) => db.tx([store], 'readwrite', (tx) => Promise.all(list.map((r) => db.put(tx, store, r)))),
    ago: (days) => Date.now() - days * 864e5,
    dbExists: async () => (await indexedDB.databases()).some((d) => d.name === 'papieren'),
    // Merges into the saved settings, db one level deep, as the popup's save does.
    set: async (patch) => {
      const s = settings.normalize((await chrome.storage.local.get('settings')).settings);
      await chrome.storage.local.set({ settings: settings.normalize({ ...s, ...patch, db: { ...s.db, ...patch.db } }) });
    },
    // TESTING.md's watch(), keeping the flushes instead of logging them.
    watch: () => {
      t.flushes = [];
      chrome.runtime.onMessage.addListener((m, s) => {
        if (m?.type === 'db-flush') t.flushes.push({ at: Date.now(), tab: s.tab?.id, memory: m.memory.length, history: m.history.length });
      });
    },
    flushes: null,
  };
}

// headless: false shows the window, for watching a check or a logged-in run.
// userDataDir '' gives a temporary profile that Playwright deletes on close.
export async function launch({ headless = true, userDataDir = '' } = {}) {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: BROWSER,
    headless,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const first = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 10_000 });
  const id = new URL(first.url()).host;
  const worker = async () => {
    // A worker the browser stopped for idleness comes back on the next event;
    // Playwright then reports it as a new one, so look it up each time.
    const live = ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`))
      ?? await ctx.waitForEvent('serviceworker', { timeout: 10_000 });
    await live.evaluate(installHelpers);
    return live;
  };
  // sw(fn, arg) runs fn(arg) in the worker, where the helpers are the global t.
  const sw = async (fn, arg) => (await worker()).evaluate(fn, arg);

  // The popup as a tab. It is ready once the country list has rendered.
  // Opened as a tab it is itself the active tab, so for the counts of an
  // x.com page, tabOf names that page and chrome.tabs.query answers with it.
  async function popup({ tabOf } = {}) {
    const page = await ctx.newPage();
    if (tabOf) {
      const tabId = await sw((url) => chrome.tabs.query({}).then((all) => all.find((x) => x.url === url)?.id), tabOf.url());
      await page.addInitScript((tid) => {
        const query = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (info) => (info?.active ? Promise.resolve([{ id: tid }]) : query(info));
      }, tabId);
    }
    await page.goto(`chrome-extension://${id}/popup/popup.html`);
    await page.locator('#countries input').first().waitFor();
    return page;
  }

  return { ctx, id, sw, popup, close: () => ctx.close() };
}

// Saves the download a click starts and returns its name and text.
export async function download(page, click) {
  const [d] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: d.suggestedFilename(), text: await readFile(await d.path(), 'utf8') };
}

// Enough RFC 4180 for the exports: quoted fields, doubled quotes, commas and
// newlines inside quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

# Papieren manual checks

One check per acceptance criterion of `specs/papieren-country-filter/requirements.md`, then the D rows for `specs/papieren-database/requirements.md` and the P rows for `specs/papieren-packs/requirements.md`, run by hand in Brave with Papieren loaded unpacked. The unit tests (`npm test`) cover the logic; these checks cover what only a real x.com tab can show.

## Where a check runs

The **Run** column says where each check can be done:

- **L**: the legacy app, on the main account, with country lookups **off**. Never switch lookups on here.
- **R**: the rebuilt app, logged out, in a private window (turn on Allow in Private for Papieren in `brave://extensions` first, and off again afterwards). Only what X shows logged out is reachable, which in practice means conversation pages and profiles.
- **B**: the burner-account trial, the only place lookups are ever on. It also carries the rebuilt app's logged-in checks: repost markup, timeline payloads and lookups on `api.x.com`.
- **Unit**: no safe way to provoke it by hand; the named unit test covers it.

## Setup

1. `brave://extensions`, Developer mode on, Load unpacked, pick `papieren/`. After any code change, reload the Papieren card, then F5 every x.com tab: a content script orphaned by the reload stops filtering until F5.
2. Open the service worker console: Papieren card, "service worker" link, Console tab. Keep it open while testing, which also keeps the worker awake, and paste the helpers below. Commands in the checks run there.

```js
const seed = (handle, c, more = {}) =>
  chrome.storage.local.set({ ['c:' + handle.toLowerCase()]: { c, a: true, k: 'unverified', t: Date.now(), ...more } });
const unseed = (handle) => chrome.storage.local.remove('c:' + handle.toLowerCase());
const peek = async (key) => (await chrome.storage.local.get(key))[key];
```

3. `seed` stands in for a lookup: it writes a cache entry exactly as a lookup would, and the open x.com tabs react at once. `@A`, `@B`, `@D` below are any authors visible in the feed; `<you>` is your own handle.
4. **Clean up after every session**: `unseed` each seeded handle. A seeded entry stays fresh for 30 days and would block that author's real lookup.
5. The source checks, run from the repository root (they work in fish and bash alike):

```sh
# S1 (4.1): the requests Papieren itself sends
grep -rnE "nativeFetch\(|sendBeacon|WebSocket|EventSource|\.send\(" papieren/src papieren/popup
# S2 (4.2): every host named in the code
grep -rnoE "https?://[a-z.]+" papieren/src papieren/popup papieren/manifest.json
# S3 (4.4, D7.1): storage other than chrome.storage.local, bar the database's own wrapper
grep -rnE "localStorage|sessionStorage|indexedDB|storage\.sync" papieren/src papieren/popup | grep -v '^papieren/src/lib/db.js:'
# S4 (9.4): filters, transitions, animations, inline styles
grep -nE "^\s*(filter|backdrop-filter|transition|animation)[a-z-]*\s*:" papieren/src/content.css papieren/popup/popup.css
grep -rn "\.style\." papieren/src papieren/popup
```
6. Telling requests apart: Papieren's lookups and X's own "About this account" fetch are both `AboutAccountQuery`. Open no About this account panel during a B check, and every `AboutAccountQuery` in the Network panel is Papieren's.

## Requirement 1: Blocklist filtering

Mode "Hide the ticked countries".

| # | Run | Do | Pass when |
|---|---|---|---|
| 1.1 | L R | Open `/search?q=from:A&f=live` (a profile page is not filtered, see 1.5). Tick France. `seed('A', 'France')`. | Every @A post turns into `Hidden: @A · France (click to show)`. |
| 1.2 | L R | France ticked. Pick a visible @B for whom `await peek('c:b')` is `undefined`. | @B's posts stay as they are. |
| 1.3 | L R | France ticked, @A visible and not seeded. Without touching the tab, `seed('A', 'France')`. On L, also repeat with `unseed('A')`, ticking @A's real country, then opening @A's About this account in a second tab (X's own request, see 3.8). | @A's posts collapse within a second, without a reload. |
| 1.4 | L R | `seed('A', 'Europe')`, reopen the popup, tick Europe (listed because the cache now holds it). | @A hidden, the line ending `· Europe`. |
| 1.5 | L R | With @A hidden, open @A's profile, then (L) Notifications and a List. Then a conversation with @A replying, and (L) `/search?q=from:A`. | @A shown on the profile, notifications and the list; hidden in the conversation replies and the search. The focal post (the one in the URL) is always shown. |
| 1.6 | L, B | Following timeline, a repost by @R of a post by @O. `seed('R', 'France')`, @O not seeded, France ticked. Then `unseed('R')`, `seed('O', 'France')`. If a repost of yours shows on a filtered page: `seed('<you>', 'France')`, @O unseeded. | Hidden in the first two cases, your own repost shown in the last (you are never judged as the reposter). Rebuilt app: no reposter in the DOM yet, so it fails open; check logged in on B. |

## Requirement 2: Allowlist filtering

Mode "Show only the ticked countries".

| # | Run | Do | Pass when |
|---|---|---|---|
| 2.1 | L R | Tick Germany only. `seed('A', 'France')`. | @A hidden, the line ending `· France`. |
| 2.2 | B | Lookups on, scroll to an author not yet cached. | Their post shows `Checking @B's country (click to show)` until the lookup returns. |
| 2.3 | L R, B | L R: Germany ticked, `seed('A', 'France')` (hidden), then `seed('A', 'Germany')`. B: a Checking line from 2.2 whose author resolves to a ticked country. | The post comes back in place, scroll position unchanged, without a reload. |
| 2.4 | L | Germany ticked, `seed('<you>', 'France')`. Open a conversation you replied in, or `/search?q=from:<you>`. | Your own posts are shown. |

## Requirement 3: Safe country lookups

| # | Run | Do | Pass when |
|---|---|---|---|
| 3.1 | L, B | L: type 46 in "Lookups per 15 minutes", close and reopen the popup; then type 0 and do the same. B: lookups on, scroll for 15 minutes, Network panel filtered on `AboutAccountQuery`. | L: the field reads 45, then 1. B: no 15-minute stretch holds more lookups than the budget. |
| 3.2 | B | Leave the page still for 2 minutes once the authors on screen are cached; then scroll by one screen. | No lookup while the page is still. Each new lookup's `screenName` (in the request's `variables`) is an author within about one screen of the view. |
| 3.3 | B | After @B has been looked up, F5 and scroll back to @B. | No second lookup for @B, and `(await peek('c:b')).t` is unchanged. |
| 3.4 | Unit, B | Not safely provokable: `test/budget.test.js` covers the 429, the `reset` time, the 15-minute default and `remaining <= 5`. If X does answer 429 during the trial, open the popup. | The popup reads `X rate limit: lookups resume at HH:MM.`, and no lookup is sent before then. |
| 3.5 | B | Network panel during a burst of new authors, sorted by start time. | Consecutive lookups start at least 2 seconds apart. |
| 3.6 | L | In a spare Brave profile (or Export, Remove the extension, Load unpacked again: the cache is lost), open the popup. `await peek('settings')`. | "Look up the country of unknown authors" unticked, settings absent or `lookups: false`. The other defaults: hide mode, nothing ticked, one line, budget 40. |
| 3.7 | L, B | Tick the lookups box, read the panel, then Cancel. On B only: tick again and press "I accept the risk". **Never press Accept on the main account.** | The panel quotes X's Terms of Service section 4 and the Automation rules' "scripting the X website" line; `await peek('settings')` still shows lookups off while it is open; Cancel closes it and unticks the box. On B, lookups are on only after Accept. |
| 3.8 | L, B | Lookups off. Open @C's About this account from their profile. `await peek('c:c')`. | The entry exists, `c` matches X's "Account based in", and `t` is from the last minute. |
| 3.9 | L | Lookups off, Germany ticked in allow mode, @B visible and not cached. | @B shown normally, no `Checking` line anywhere, and the popup reads `Lookups off: filtering uses countries already cached.` |

## Requirement 4: Hide-only, no account actions

| # | Run | Do | Pass when |
|---|---|---|---|
| 4.1 | L, B | S1. B: Network panel with the Method column, while scrolling. | One hit, the `nativeFetch(` in `page-hook.js` with `method: 'GET'` just below it (the XHR and fetch wrappers only read X's own requests and pass them on). B: every lookup is a GET. |
| 4.2 | L | S2. Keep the service worker's Network tab and the popup's (right-click the popup, Inspect, Network) open through a session of checks. | Only `x.com` and `api.x.com` appear. The worker and popup Network tabs list nothing beyond the extension's own files. |
| 4.3 | L | The 4.2 results, plus the `permissions` line of `papieren/manifest.json`. | `permissions` is `["storage"]` alone, and no request goes to a third host from the worker, the popup or the tab. |
| 4.4 | L | `await chrome.storage.sync.get(null)` and `await chrome.storage.local.get(null)`. x.com DevTools, Application: Local storage, Session storage, IndexedDB. S3. | sync is `{}`; local holds only `settings`, `c:*` and `qid:*` keys; no Papieren key in x.com's own storage; S3 prints nothing. (`chrome.storage.session` holds the lookup budget's state, which clears with the browser.) |

## Requirement 5: Hidden-post presentation

| # | Run | Do | Pass when |
|---|---|---|---|
| 5.1 | L R | Any post hidden by 1.1. | One line: `Hidden: @A · France (click to show)`. |
| 5.2 | L R | Click the line; scroll it off screen and back; then open another page and come back. | The post is shown after the click and still shown after the scroll; hidden again after the navigation. |
| 5.3 | L R | Display, "Remove completely"; then back to "One line naming the author". | Hidden posts vanish with no line, then return as lines, without a reload. On B, Checking lines stay visible in both styles. |
| 5.4 | L R | Three @A posts hidden (`seed('A', 'France')`) and one @D post (`seed('D', 'Brazil')`, Brazil ticked). Open the popup. | "Hidden on this page" lists France 3 and Brazil 1. |

## Requirement 6: Settings

| # | Run | Do | Pass when |
|---|---|---|---|
| 6.1 | L | After 1.4, open the popup and search "rus", "united", "eur"; clear the search and scroll to the end of the list. | Russia, United States and India are listed, so is the seeded Europe, and Unknown comes last; the search narrows the list; both mode buttons are there. |
| 6.2 | L R | With the popup open over an x.com tab, tick and untick France, switch mode, switch the Display style. Then switch to a second x.com tab. | The page under the popup follows each change within a second, the second tab is already up to date, and nothing reloads. |
| 6.3 | L R, B | Tick Pause; then untick it. | Every hidden post is shown and the popup reads `Paused: every post is shown and no lookups run.`; unticking brings the filtering back without a reload. B: no lookup while paused. |
| 6.4 | L | Export settings. Change the mode, Import settings… the exported file. Then import a file holding only `{`, a copy with `"mode": "x"`, and a copy with `"lookups": true`. | The export is `papieren-settings-<day>.json`, the note reads `Exported papieren-settings-<day>.json.`, and the file is JSON with `v`, `mode`, `countries`, `placeholder`, `paused`, `lookups`, `budget`, `db`. Importing it restores the mode and reads `Imported: hide N countries.` (or `show only`) and `Lookups stay as they were.` The bad files read `Not imported: The file is not valid JSON.` and `Not imported: mode must be "block" or "allow".` with the settings unchanged. The `"lookups": true` copy imports, but lookups stay off. |

## Requirement 7: Failure behaviour

| # | Run | Do | Pass when |
|---|---|---|---|
| 7.1 | B | x.com DevTools, Network request blocking, add `*AboutAccountQuery*`, scroll to new authors. Afterwards remove the pattern, then Pause and unpause. | After the third blocked lookup: a red `!` badge, the popup reads `Lookups stopped after 3 failed attempts. Pause and unpause to retry.`, and no lookup follows. Pause and unpause clears it. |
| 7.2 | L, B | L: 1.1 with lookups off, which counts as stopped (3.9). B: the stopped state of 7.1. | Cached authors stay hidden. |
| 7.3 | L, B | Allow mode, @B visible and not cached. L: lookups off. B: Checking lines on screen when 7.1's stop happens. | @B shown. On B the Checking lines turn back into posts once lookups stop. |
| 7.4 | L R | `seed('A', null)`. Block mode: tick Unknown, then untick it. | `Hidden: @A · Unknown (click to show)` while ticked, shown once unticked. |
| 7.5 | L | Open `https://x.com/robots.txt`, an x.com page that is not the app. The post-level case, a cell whose author cannot be read, is covered in `test/content.test.js`. | An amber `?` badge on that tab only, and the popup reads `X layout not recognised on this tab: nothing is filtered here.` |

## Requirement 8: Location confidence indicator

| # | Run | Do | Pass when |
|---|---|---|---|
| 8.1 | L, B | After 3.8, or after a lookup on B, `await peek('c:c')`. | The entry has `a` and `k`, plus `s` when the About page shows "Connected via" with a country. `cc` appears only if X ever sends a creation country (none seen so far). |
| 8.2 | L, B | Capture, as in 3.8, an author whose About page shows the same country under "Account based in" and "Connected via", with no accuracy note. Hide that country. | `k` is `confirmed`, and the placeholder ends `· confirmed`. |
| 8.3 | L, B | The same with an author whose two countries differ, or whose About page says the location may not be accurate. | `k` is `flagged`, and the placeholder ends `· flagged`. |
| 8.4 | L R | `seed('A', 'France', { s: 'France', k: 'confirmed' })`, `seed('D', 'France', { a: false, k: 'flagged' })`, France ticked. Open the popup. | The lines end `· France · confirmed` and `· France · flagged`, and the popup's Marks column reads `1 confirmed, 1 flagged`. |
| 8.5 | L R | With 8.4's entries, untick France, then tick it again. | Both authors are shown together and hidden together: the mark never changes the verdict. |

## Requirement 9: Resource footprint

| # | Run | Do | Pass when |
|---|---|---|---|
| 9.1 | L | Brave Task Manager (Shift+Esc), Memory footprint of the x.com tab. Run A: Papieren disabled, a fresh tab, 30 minutes of scrolling `/home`. Run B: the same with Papieren enabled and some countries ticked. | B minus A is at most 50 MB. The figure is noisy: repeat both runs when the gap is within 10 MB of the limit. A D7.4 pass stands in for this row: its run B is this B with the database added. |
| 9.2 | L | x.com DevTools, Performance, no CPU throttling, record 20 seconds of fast scrolling on `/home`. Event log, filtered on Papieren's extension id. | No single Papieren mutation-observer callback or animation-frame task takes more than 8 ms. |
| 9.3 | L, B | Record 60 seconds in the Performance panel: 10 s on the x.com tab, 40 s on another tab, 10 s back. | No task starts in `content.js` during the hidden 40 s (no timer, no animation frame). `page-hook.js` may appear only inside X's own network callbacks, since it reads X's responses. B: no lookup while hidden. |
| 9.4 | L | S4. | Both commands print nothing. |
| 9.5 | L | Close every x.com tab, the popup and the service worker console, and wait a minute. | The Papieren card in `brave://extensions` reads "service worker (Inactive)", and Task Manager has no Papieren service worker row. |

## Database (`specs/papieren-database`)

Every D row runs on **L**. The database lives in the extension's own origin: its IndexedDB is under the worker console's Application tab (or the popup's: right-click it, Inspect), never under x.com's.

**Automated (2026-11-15).** Every D row but D7.4, and row 6.4, also runs headless in `papieren/e2e/`, its own package so `papieren/package.json` stays dependency-free: `cd papieren/e2e; npm install; npm test` (about 80 s). `popup.test.js` covers the rows that need only the popup and the worker; `feed.test.js` runs the feed rows against `fakex.js`, a routed x.com that answers every request itself, so nothing reaches X. The fake is only as true to X as the unit-test payloads are; a private ticket checked their field names against real captures. Headless Chromium never hides a tab, so the second half of D7.3 runs only with `env PAPIEREN_HEADED=1 npm test`, which opens a window. Every headed run is a plain Chromium attached over CDP, because Playwright's own launch keeps every page visible behind any other tab. D7.4 has its own script, see its row. A green run stands in for the L rows it covers. What it cannot show is real X drift, which is the live run's job: `npm run login` once, then `npm run live`, headed on the burner profile `e2e/.profiles/burner` (never the main account), lookups off, storage wiped before and after. It runs 1.1, D3.3, D3.5, D3.7, D3.8, D4.1 to D4.3, D6.2 and D7.1 to D7.3 on real x.com in about 90 s, and saves X's first timeline and conversation answers to `~/papieren-capture/`, outside the repo.

Database helpers, pasted into the worker console after the Setup ones. Seeded rows are invented: clean up with the popup's "Delete all" for the kind seeded.

```js
const { db } = Papieren;
const rows = async (store) => { const out = []; await db.tx([store], 'readonly', (t) => db.each(t, store, null, null, (v) => { out.push(v); })); return out; };
const put = (store, ...list) => db.tx([store], 'readwrite', (t) => Promise.all(list.map((r) => db.put(t, store, r))));
const ago = (days) => Date.now() - days * 864e5;
const watch = () => chrome.runtime.onMessage.addListener((m, s) => {
  if (m?.type === 'db-flush') console.log(new Date().toLocaleTimeString(), 'flush, tab', s.tab?.id, m.memory.length, 'memory', m.history.length, 'history');
});
```

| # | Run | Do | Pass when |
|---|---|---|---|
| D1.1 | | Removed 2026-11-17: the database is a required part of papieren. | |
| D1.2 | | Removed 2026-11-17: the database is a required part of papieren. | |
| D1.3 | L | `seed('Z', 'France', { t: ago(31) })` and count `Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('c:')).length`. Close and reopen the popup, count again. Amended 2026-11-17: no switch to tick first. | `await peek('c:z')` is `undefined` (past the 30-day Retention) and the count is one less: every other entry stayed. |
| D1.4 | | Removed 2026-11-17: the database is a required part of papieren. | |
| D2.1 | L | Retention, hidden history: type 400 and Tab, then empty the field and Tab, then 2.5 and Tab, then 14 and Tab. Reopen the popup. | The first three snap back to the saved value; 14 stays, and `(await peek('settings')).db.keep.history` is 14. |
| D2.3 | L | Hidden history Retention 1. `await put('history', { day: '2026-01-01', tweet: '1', handle: 'seeded', page: 'home', rule: 'country', revealed: false, t: ago(2) })`. Close and reopen the popup. | `(await rows('history')).filter((r) => r.handle === 'seeded')` is `[]`: the popup-open sweep removed it. |
| D2.4 | L | "Delete all" beside Hidden history: click once and Tab away; then click twice. | One click reads "Click again to delete" and deletes nothing; Tab restores "Delete all"; two clicks read `Deleted the whole hidden history.` and `(await rows('history')).length` is 0. |
| D2.5 | Unit | 100 MB is not reachable by hand: `test/records.test.js` covers the share, the headless run of task 4 the sweep's cap path. | |
| D3.1 | L | Copy-paste replies on. A conversation where several accounts post the same reply (giveaway and crypto threads), wait 5 s. | Once a third author posts it, every copy reads `Hidden: @x · copy-paste reply, N accounts (click to show)`. `(await rows('memory')).some((r) => 'text' in r)` is `false`, and every `copy` row's key is 16 hex characters. If no such thread turns up, `test/content.test.js` covers it. |
| D3.2 | Unit | Replies everywhere: 5 conversations in 24 h is impractical to stage; `test/memory.test.js` and `test/content.test.js` cover it. | |
| D3.3 | L | Recycled media on. Scroll a feed with images, wait 5 s. Pick a row of `(await rows('memory')).filter((r) => r.kind === 'media')` whose @handle is on screen as `m`. `await put('memory', ...['901', '902'].map((a, i) => ({ kind: 'media', key: m.key, author: a, handle: 'seeded' + i, tweet: String(i + 1), t: Date.now() })))`, `await put('flags', { kind: 'media', key: m.key, n: 3, first: '1', t: Date.now() })`. F5. | The picked post reads `Hidden: @handle · recycled media, 3 accounts (click to show)`: the seeded tweets 1 and 2 are older, so it is not the earliest. |
| D3.4 | Unit | Repeat offender needs 5 detections by the other detections, recorded whatever their toggles; `test/memory.test.js` and `test/content.test.js` cover it. | |
| D3.5 | L | With D3.3's post hidden, untick Recycled media; tick it again. | The post comes back and hides again, without a reload. |
| D3.7 | L | S1 and S2 after D3.3. | Unchanged: no image download, no new host. |
| D3.8 | L | All four detections on. Scroll the Following timeline and a conversation where accounts you follow reply, wait 5 s. `new Set((await rows('memory')).map((r) => r.handle))`. | No handle of an account you follow. One there means the follow flag is read from the wrong field. |
| D4.1 | L | 1.1's France hide on `/home`, wait 5 s, `(await rows('history')).length`. F5 without scrolling, wait 5 s, count again. | The same count; every row's `page` is `home`, `status` or `search`, and its `rule` is `country` or `bm:<detection>`. |
| D4.2 | L | After D4.1, `await rows('stats')`. | Today's `country` row with `judged` at least `hid`, and `hid` above 0. |
| D4.3 | L | Click one of D4.1's placeholders, wait 5 s. | That tweet's history row has `revealed: true`. |
| D5.1 | L | Export JSON. Open it in a text editor. | `papieren` (the version), `exported` (an ISO time), `retention`, and the `cache`, `memory`, `history` and `stats` arrays. |
| D5.2 | L | Export CSV for each of the four kinds. Open each in LibreOffice Calc. | One column per header field, no cell read as a formula, and the last three columns `exported`, `version`, `retention_days`. |
| D6.2 | L | With D3.3's post hidden, open the popup. | "Hidden on this page" lists `Recycled media 1` under the country rows, first column headed Reason. |
| D7.1 | L | S1, S2 and S3; the worker's and popup's Network tabs through D4 and D5. | S1 and S2 as in 4.1 and 4.2, S3 prints nothing, and no request leaves the extension. |
| D7.2 | L | D3.3's post hidden. `await chrome.storage.session.set({ dbError: 'test' })`, F5 the x.com tab, open the popup. Then tick and untick Pause. | The popup reads `Database unavailable (test): running without it.`, the behaviour hide is gone and country hides stay. After Pause on and off the line is gone and the post hides again, without a reload. |
| D7.3 | L | `watch()`, scroll `/home` for a minute; switch to another tab for 30 s; come back. | Flushes from one tab are at least 5 s apart; at most one flush as the tab is hidden, none while it stays hidden. |
| D7.4 | L | 9.1 with all four detections on, as two headless pairs in `e2e/footprint.js`. `npm run footprint` (about 4 minutes): a fake x.com feeds A and B the same 8,000 posts, past every 5,000-key cap of the tab's maps, 60 cells left in the DOM as X recycles them; nothing reaches X. `npm run footprint:live` (about an hour, burner only, lookups off): 30 minutes of For you per run. X serves each run different posts, and run A alone has measured 305 to 548 MB, so the live pair judges the page's JS heap after a full GC, where the content script and page hook live. | Fake: B minus A footprint at most 50 MB, and in B every rule hid at least one post (else the run is invalid, exit 2). Live: B minus A JS heap after GC at most 50 MB, neither run stalled. |

## Packs (`specs/papieren-packs`)

Packs judge what X already sends, so no P row needs lookups. The editor is the popup's "Edit packs…" tab.

**Automated (2026-11-17).** In `papieren/e2e/`, `pack-feed.test.js` runs the feed rows against `fakex.js`, whose posts carry text and a language; `editor.test.js` runs the editor rows and `popup.test.js` the popup's Packs section. A green `npm test` stands in for the L rows marked Auto. Rows marked Unit name the `papieren/test/` check that covers them.

| # | Run | Do | Pass when |
|---|---|---|---|
| P1.1 | L, Auto | Popup: hide mode, Engagement bait ticked. Search X for "follow for more". | A post scoring 6 or more reads `Hidden: @handle · Engagement bait (click to show)`; a post with one stray phrase shows. |
| P1.2 | Unit | `packs.test.js` "a Phrase met twice counts once; whitespace runs match; overlapping Phrases all count". | Passes. |
| P1.3 | Unit | `signal-packs.test.js` "fromTweet: reply and quote flags; a repost carries the original…" and "a repost names the reposted Post…". | Pass. |
| P1.4 | Unit | `packs.test.js` "a repost judges name and bio on either Author (Req 1.4)" and "accountScore: badges or behaviour of either Author, each Tell once, hidden-before per Pack". | Pass. |
| P1.5 | Unit | `packs.test.js` "a quote is judged on its own text only (Req 1.5)"; `signal-packs.test.js` "fromTweet: links give hosts…; a quote…". | Pass. |
| P1.6 | Unit | `packs.test.js` "a Tell whose input is missing is not met (Req 1.6)". | Passes. |
| P2.1 | L, Auto | P1.1's post hidden. Untick Engagement bait in the popup, then tick it again, without F5. | The post shows, then hides again, with no reload. |
| P2.2 | L, Auto | Popup: "Show only posts my packs match", Engagement bait ticked. | A plain post reads `Hidden: @handle · outside your packs (click to show)`; a bait post shows. |
| P2.3 | L, Auto | P2.2 with every Pack unticked. | Nothing is hidden on Packs. |
| P2.4 | Unit | `rules.test.js` "packs: viewer, focal post, pause and an unfiltered page are never hidden on a Pack (Req 2.4, 2.5)"; `signal-packs.test.js` "prepare leaves the viewer out of the Score, as evaluate does". | Pass. |
| P2.5 | L | P1.1's post hidden; tick Pause, then untick it. | Every post shows while paused; the post hides again after. Unit: as P2.4. |
| P2.6 | Unit | `signal-packs.test.js` "All_But: a post no Pack matches hides as outside your packs; no Pack facts, never hidden (Req 2.2, 2.6)". | Passes. |
| P3.1 | L, Auto | P1.1 with a French post carrying the same English phrases. | It shows: Engagement bait has English entries only. |
| P3.2 | Unit | `packs.test.js` "text Tells only for the Post_Language; the rest whatever the language (Req 3.1 to 3.3)". | Passes. |
| P3.3 | L, Auto | As P3.1. | As P3.1. |
| P3.4 | Unit | `builtin.test.js` "example.json uses every kind of Tell, every measure, a negative weight and two languages"; `editor.test.js` "formOf and fromForm…" saves a second language. | Pass. |
| P4.1 | L, Auto | Open the popup. | Packs lists Engagement bait, Ragebait, AI-tone writing and Aggregator style, each with English entries in the editor. |
| P4.2 | L, Auto | A fresh install, then the popup. | Every Pack is unticked. |
| P4.3 | L, Auto | The popup's Pack rows, after P5.1. | Each row shows Kind, description, threshold and tell count; the copy adds "copy of Engagement bait v1". |
| P4.4 | Unit | `background.test.js` "update: built-ins replaced, user Packs untouched, packs.on keeps only ids that still exist (Req 4.4)". | Passes. |
| P4.5 | Unit | `builtin.test.js` "example.json uses every kind of Tell…": a topic Pack through the validator and scorer the junk built-ins use. | Passes. |
| P5.1 | L, Auto | Engagement bait ticked. Editor: select it, Edit a copy. | "Engagement bait (copy)" appears, reads "A copy of Engagement bait v1.", and is ticked in the popup where the built-in was. |
| P5.2 | L, Auto | In the copy: change the threshold, add a line, delete a line, Save. | "Saved, version 2."; the popup row shows the new threshold and tell count. |
| P5.3 | L, Auto | Editor: New pack. | "My pack" opens with commented example lines in Any language and English. |
| P5.4 | L, Auto | In the copy, add `2 /(a+)+$/` to English and Save; then a 201-character pattern; then `1 /(unclosed/`. | Each reads "Not saved: Language en, line N: …" with the reason, and the stored pack is unchanged. Unit: `editor.test.js` "fromForm: a refusal names the box, the line and the reason, and saves nothing (Req 5.4)". |
| P5.5 | L, Auto | Hold 100 packs, then New pack. | "Not made: Papieren holds at most 100 packs: delete one first." Unit: `packs.test.js` "validate: at most 300 Tells over tells and every language (Req 5.5)". |
| P6.1 | L, Auto | Editor: select Ragebait, Export. | `papieren-pack-ragebait.json` is saved in the Pack_Template format. |
| P6.2 | L, Auto | Import that file with one pattern changed to `(a+)+`. | "Not imported: languages.en…" names the reason, and nothing is added. |
| P6.3 | L, Auto | Import P6.1's file unchanged. | "Imported Ragebait as "ragebait-2", switched off.", and it is unticked in the popup. |
| P6.4 | Unit | `builtin.test.js` "pack.schema.json: its enums are the validator's…" and "example.json uses every kind of Tell…". | Pass. |
| P6.5 | L, Auto | The worker's, the popup's and the editor's Network tabs through P4 to P6. | No request leaves the extension; the built-ins come from its own package (Unit: `background.test.js` "install: every built-in read from the package…"). |
| P7.1 | L, Auto | As P1.1. | As P1.1. |
| P7.2 | Unit | `signal-packs.test.js` "Blocklist: the Pack exceeding its Threshold by the most; a tie goes to the earlier in the list (Req 2.1, 7.2)". | Passes. |
| P7.3 | L, Auto | As P2.2. | As P2.2. |
| P7.4 | L, Auto | The popup on P1.1's tab, then on P2.2's. | "Hidden on this page" has a row "Engagement bait 1", then "Outside your packs" with the count. |
| P8.1 | L, Auto; B | The x.com tab's Network panel with Packs on, lookups off; on the burner with lookups on (task 11). | No request from Papieren but lookups. |
| P8.2 | Unit | `builtin.test.js` "every Pack file passes validate under its own file name…"; adding a built-in is one line in `background.js` `BUILTIN` and its file. | Passes. |
| P8.3 | Unit; B | `bench-packs.test.js` "Req 8.3: the batch reads the memo inside 8 ms for 100 Posts…"; one DevTools performance look on the burner at intake (task 11). | Passes; no long task at intake on the burner. |

## Beyond the criteria

| Check | Run | Do | Pass when |
|---|---|---|---|
| Orphan teardown | L | With posts hidden, reload the Papieren card, then return to the x.com tab without F5. Then F5. | The placeholders vanish and the posts show unfiltered; F5 brings the placeholders back. |

## Known gaps

- Rebuilt app, logged in: repost markup, timeline payloads and lookups are unverified until the burner trial.
- A reposted original seen on its own may be hidden for the reposter's country (an earlier decision).
- The GraphQL "query not found" form of OpNotFound is not handled (`ponytail:` in the code).
- Rule_Statistics count once per tweet per day per tab, so each F5 of a page counts its posts again; the Hidden_History rows do not double.
- The QuotaExceeded sweep-and-retry of `db-flush` is tested with an injected error (`e2e/popup.test.js`): Chromium's DevTools quota override does not bind IndexedDB, and the real quota is a share of the disk, so a real one has never been provoked.
- Fake X posts carry text and a language only: name, bio, checkmarks, media, links and quotes reach Packs in the unit tests, on captured payload shapes, and on real X only in task 11's live run.
- D7.4's fake cells are a fraction of X's markup, and the live pair judges only the JS heap, where DOM nodes do not live: what Papieren's placeholders and data attributes cost on real X cells is measured by neither verdict. Both are bounded by the cells X keeps in the DOM.

## Run log

| Date | App | Account | Checks run | Failures |
|---|---|---|---|---|
| 2026-11-13 | legacy | main | 1.1, 1.2, 1.3, 1.4, 1.5 (profile half), 5.1, 5.2, 5.3, 5.4, 7.4, 7.5, 8.4, 8.5; S1 to S4 from the shell | none |
| 2026-11-15 | legacy | main | D1.2; before the D rows were written, the popup with the switch on: a detection ticked, Export JSON and one CSV, a Retention change, "Delete all" on two clicks, then D1.4's switch-off with the database gone | none |
| 2026-11-15 | legacy | burner | `papieren/e2e`: `npm test` (23 pass, D7.3's hidden half skipped headless) and that half headed; `npm run live`, 6 of 6, follow flag seen 299 times in `relationship_perspectives`, never in `legacy` | none in Papieren; the live script's first contact needed fixes (Following holds only followed accounts, x.com's own service worker, focus emulation, popup tab in front) |
| 2026-11-15 | fake, legacy | none, burner | D7.4: `npm run footprint` twice, B minus A 7.5 and 8.7 MB (after GC 3.7 and 4.9, JS heap 2.3 both times), every rule hiding in B; a 3-minute live trial on the burner, JS heap after GC A 76.4, B 76.5 MB. The 30-minute `npm run footprint:live` not yet run | none |
| 2026-11-17 | fake | none | `papieren/e2e`: `npm test`, 36 pass and D7.3's hidden half skipped, twice; the P rows marked Auto among them. The L, B and Unit-only P rows by hand: not yet run | none |
| 2026-11-17 | fake, legacy | none, burner | `papieren`: `npm test`, 285 pass. `papieren/e2e`: `npm test`, 36 pass and D7.3's hidden half skipped; `npm run live`, 7 of 7 with Engagement bait on for the new Packs row (P1.1 and P2.5 on a live search, then the D3.7/D7.1 leak check as P8.1's lookups-off half): country judged 29, hid 26, 14 history rows; Engagement bait judged 25, hid 23; follow flag 274 times in `relationship_perspectives`, never in `legacy`. The DevTools look at intake (P8.3, B) and P8.1 with lookups on: not yet run | none in Papieren; an earlier live run that day failed 5 of 7 with no database write from the tab and no `dbError`, which did not reproduce once the window was parked off the focused monitor (cause unproven); the run's reset had wiped the built-in Packs (fixed) |
| 2026-11-17 | legacy | burner | P8.3, B: DevTools Performance, Record and reload on the home timeline, which made one intake per load. Engagement bait alone: `intake` 13.5 ms (Pack scoring 10.4, RegExp compile 1.6). All four built-ins on: `intake` 29.7 ms (`prepare` 28.9, scoring 25.5, compile 2.8). Both ran in the microtasks of X's own XHR load task, which Papieren lengthens by that much. No scroll-loaded intake was recorded: later ones skip the compile, so the first is the bound | none |

// Isolated world, document_start, loaded after src/lib/*.js. Owns the DOM:
// reads each post cell, decides with rules.evaluate(), marks the cell for
// content.css, and runs this tab's lookup queue. Talks to the page hook in
// JSON strings over DOM events, and to the worker for permits.
(() => {
  const { settings: Settings, rules, xParse, variants, feed, memory } = globalThis.Papieren;
  const TO_PAGE = 'papieren:to-page';
  const FROM_PAGE = 'papieren:from-page';
  const VARIANTS = new Set(['legacy', 'rebuilt']);
  const FLUSH_MS = 5000;          // db-flush spacing (database design, content.js)
  const BUFFER_MAX = 2000;        // rows waiting for the worker, oldest dropped (Req 7.3, 7.4)
  const SEEN_MAX = 5000;          // tweet ids per once-per-day set
  const DETECTIONS = ['copy', 'everywhere', 'media', 'offender'];
  const FIELD = { copy: 'fp', conv: 'conv', media: 'media', offence: 'tweet' }; // a sighting's key in the flush

  let settings = Settings.normalize();
  const cache = new Map();        // lowercased handle -> CacheEntry
  const tweets = new Map();       // tweetId -> { author, reposter? }, see feed.remember
  const qids = {};                // variant -> AboutAccountQuery id X itself used
  const viewer = { id: feed.viewerIdFrom(document.cookie), handle: undefined };
  let adapter = null;
  let ready = false;              // the hook holds X's bearer (HookNotReady until then)
  let stopped = false;            // the last permit or report said stopped or disabled
  const off = new AbortController(); // removes the DOM listeners, see orphaned()

  const message = async (msg) => {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return undefined; // extension reloaded or worker unreachable
    }
  };

  // --- Database (database design, content.js): dormant while settings.db.on is false ---

  let flags = memory.emptyFlags();   // the worker's counts, merged from every answer
  let index = memory.createIndex();  // this tab's own sightings
  let buffer = [];                   // [list, row] for the next db-flush, oldest first
  let counts = {};                   // rule -> { judged, hid } since the last flush
  let dbFailed = false;              // an { error } answer: run as switched off (Req 7.2)
  let flushTimer = 0;
  let lastFlush = 0;
  let today = '';
  const judgedToday = new Set();
  const hidToday = new Set();

  const dbLive = () => settings.db.on && !dbFailed;

  const once = (set, id) => {
    if (set.has(id)) return false;
    set.add(id);
    if (set.size > SEEN_MAX) set.delete(set.values().next().value);
    return true;
  };

  function push(list, row) {
    buffer.push([list, row]);
    if (buffer.length > BUFFER_MAX) buffer.shift();
    queueFlush();
  }

  function addCounts(into, from) {
    for (const [rule, c] of Object.entries(from)) {
      const n = (into[rule] ??= { judged: 0, hid: 0 });
      n.judged += c.judged;
      n.hid += c.hid;
    }
  }

  function bump(rule, field) {
    addCounts(counts, { [rule]: { judged: 0, hid: 0, [field]: 1 } });
    queueFlush();
  }

  // One sighting into the tab's index and the buffer, keyed as the flush names it.
  function sight(s) {
    memory.observe(index, s);
    const { key, ...row } = s;
    push('memory', { ...row, [FIELD[s.kind]]: key });
  }

  // What one payload tweet adds to behaviour memory, for the detections
  // switched on. Neither the viewer nor a followed Author is observed (Req 3.8).
  function sightings(v, id, db, now) {
    const a = v.author;
    const f = v.facts;
    if (!f || !a?.id || a.followed || a.id === viewer.id) return [];
    const base = { author: a.id, handle: a.handle, t: now };
    const out = [];
    if (f.conv !== undefined) {
      if (db.copy && f.fp) out.push({ kind: 'copy', key: f.fp, ...base });
      if (db.everywhere) out.push({ kind: 'conv', key: f.conv, ...base });
    }
    if (db.media) for (const m of f.media ?? []) out.push({ kind: 'media', key: m, tweet: id, ...base });
    return out;
  }

  const activeRules = () => [
    ...(settings.mode === 'allow' || settings.countries.length > 0 ? ['country'] : []),
    ...DETECTIONS.filter((d) => settings.db[d]).map((d) => `bm:${d}`),
  ];

  // Rule_Statistics and Hidden_History from one verdict: judged once per tweet
  // per day, hidden once per tweet per day by the rule that hid it (Req 4.1, 4.2).
  function record(id, refs, verdict, hit, now) {
    const day = memory.dayOf(now);
    if (day !== today) {
      today = day;
      judgedToday.clear();
      hidToday.clear();
    }
    if (once(judgedToday, id)) for (const rule of activeRules()) bump(rule, 'judged');
    const rule = verdict.why === 'match' ? 'country' : hit?.rule;
    if (!rule || !once(hidToday, id)) return;
    bump(rule, 'hid');
    const handle = rule === 'country' ? verdict.handle : hit.handle;
    push('history', { tweet: id, handle, page: feed.pageKind(location.pathname), rule, t: now });
    // A Repeat_Offender counts neither country hides nor its own (Glossary).
    if (rule !== 'country' && rule !== 'bm:offender' && settings.db.offender) {
      sight({ kind: 'offence', key: id, author: refs.author.id, handle: refs.author.handle, rule, t: now });
    }
  }

  // One timer for the 5 s spacing, none while the tab is hidden (Req 7.3).
  function queueFlush() {
    if (flushTimer || document.hidden || !dbLive()) return;
    flushTimer = setTimeout(sendFlush, Math.max(0, lastFlush + FLUSH_MS - Date.now()));
  }

  async function sendFlush() {
    flushTimer = 0;
    if (orphaned() || !dbLive() || (!buffer.length && !Object.keys(counts).length)) return;
    const rows = buffer;
    const sentCounts = counts;
    buffer = [];
    counts = {};
    const msg = { type: 'db-flush', day: memory.dayOf(Date.now()), memory: [], history: [], revealed: [], stats: sentCounts };
    for (const [list, row] of rows) msg[list].push(row);
    lastFlush = Date.now();
    const r = await message(msg);
    if (r === undefined) { // worker unreachable: the rows wait for the next flush
      buffer = [...rows, ...buffer].slice(-BUFFER_MAX);
      addCounts(counts, sentCounts);
    } else answer(r);
    queueFlush();
  }

  // A worker answer: its flags merged and every cell judged again, or the
  // database failed and the tab runs as switched off until settings change (Req 7.2).
  function answer(r) {
    if (!r || !settings.db.on) return;
    if (r.error) {
      dbFailed = true;
      buffer = [];
      counts = {};
      clearTimeout(flushTimer);
      flushTimer = 0;
    } else memory.merge(flags, r.flags);
    markAll();
  }

  const loadFlags = () => message({ type: 'db-flags' }).then(answer);

  // Switched off: the flags, the index and the buffer go.
  function dbReset() {
    flags = memory.emptyFlags();
    index = memory.createIndex();
    buffer = [];
    counts = {};
    clearTimeout(flushTimer);
    flushTimer = 0;
  }

  // --- Bridge to the page hook ---

  const toPage = (msg) => document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));
  const answers = new Map(); // reqId -> resolve
  let nextReq = 1;

  function askPage(url) {
    const reqId = nextReq++;
    return new Promise((resolve) => {
      answers.set(reqId, resolve);
      toPage({ kind: 'lookup', reqId, url });
    });
  }

  // Payloads: tweet -> author map; the viewer's handle is learnt on the way,
  // for posts the map has not seen (Req 2.4). With the database on, each
  // tweet new to this tab is observed for the detections switched on.
  async function intake(body) {
    const { tweets: found } = xParse.walkTimeline(body);
    const own = new Map(); // record -> its own id: a repost pair is filed under both, the original's is the smaller
    for (const [id, v] of found) {
      for (const u of [v.author, v.reposter]) if (viewer.id && u?.id === viewer.id) viewer.handle = u.handle;
      if (memory.earlier(id, own.get(v))) own.set(v, id);
    }
    // A Reply's text is read only for copy-paste, and never kept: only its
    // Fingerprint reaches the identity map or the buffer (Req 3.6).
    const db = dbLive() ? settings.db : null;
    const texts = [];
    for (const v of own.keys()) {
      if (v.facts?.text === undefined) continue;
      if (db?.copy) texts.push([v, v.facts.text]);
      delete v.facts.text;
    }
    if (texts.length) {
      await Promise.all(texts.map(async ([v, text]) => {
        const fp = await memory.fingerprint(text);
        if (fp) v.facts.fp = fp;
      }));
    }
    if (db && dbLive()) {
      const now = Date.now();
      for (const [v, id] of own) if (!tweets.has(id)) sightings(v, id, settings.db, now).forEach(sight);
    }
    feed.remember(tweets, found);
    markAll();
  }

  async function writeEntry(handle, entry) {
    cache.set(handle.toLowerCase(), entry);
    const item = { [feed.cacheKey(handle)]: entry };
    try {
      await chrome.storage.local.set(item);
    } catch {
      // QuotaExceeded: the worker drops the oldest 20%, then one retry.
      await message({ type: 'prune' });
      await chrome.storage.local.set(item).catch(() => {});
    }
  }

  document.addEventListener(FROM_PAGE, (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    const text = typeof msg?.body === 'string';
    if (msg?.kind === 'ready') {
      ready = true;
      pump();
    } else if (msg?.kind === 'payload' && text) {
      intake(msg.body);
    } else if (msg?.kind === 'about' && text && typeof msg.handle === 'string') {
      // X's own About fetch: free data, kept even with lookups off (Req 3.8).
      const parsed = xParse.parseAbout(msg.body, msg.handle);
      if (parsed.ok || parsed.error === 'gone') writeEntry(msg.handle, feed.entryOf(parsed, Date.now()));
    } else if (msg?.kind === 'qid' && VARIANTS.has(msg.variant) && typeof msg.qid === 'string' && qids[msg.variant] !== msg.qid) {
      qids[msg.variant] = msg.qid;
      chrome.storage.local.set({ [`qid:${msg.variant}`]: msg.qid }).catch(() => {});
    } else if (msg?.kind === 'lookup-result' && answers.has(msg.reqId)) {
      answers.get(msg.reqId)(msg);
      answers.delete(msg.reqId);
    }
  }, { signal: off.signal });

  // --- Cells ---

  const dirty = new Set();          // changed nodes, resolved to cells once per frame
  const visible = new WeakSet();    // cells within one screen height (Req 3.2)
  const wanting = new WeakMap();    // cell -> handles it needs looked up
  const revealed = new Set();       // tweet ids the user clicked open (Req 5.2)
  const hiddenHere = new Map();     // tweetId -> { country, k } for the popup's stats
  let path = location.pathname;
  let frame = 0;

  const schedule = () => { frame ||= requestAnimationFrame(flush); };

  function markAll() {
    if (!adapter || !document.body) return;
    dirty.add(document.body);
    schedule();
  }

  function flush() {
    frame = 0;
    if (orphaned()) return;
    if (location.pathname !== path) { // navigation clears reveals, no listener needed
      path = location.pathname;
      revealed.clear();
      hiddenHere.clear();
    }
    const cells = new Set();
    for (const node of dirty) {
      if (!node.isConnected) continue;
      for (const c of adapter.findCells(node)) cells.add(c);
      const own = adapter.cellOf(node);
      if (own) cells.add(own);
    }
    dirty.clear();
    for (const cell of cells) judge(cell);
  }

  function clear(cell) {
    delete cell.dataset.papieren;
    delete cell.dataset.papierenLabel;
    delete cell.dataset.papierenId;
  }

  function judge(cell) {
    const post = adapter.readPost(cell);
    if (!post) return clear(cell); // no readable author: stays visible (Req 7.5)

    // The payload's reposter wins: socialContext also carries "liked".
    const refs = tweets.get(post.tweetId)
      ?? { author: { handle: post.handle }, reposter: post.reposterHandle ? { handle: post.reposterHandle } : undefined };
    const entryOf = (ref) => cache.get(ref.handle.toLowerCase());
    const state = (ref) => ref && feed.authorState(ref, entryOf(ref), viewer);
    const ctx = {
      settings,
      filteredPage: variants.isFilteredPage(location.pathname),
      isFocal: post.tweetId === variants.focalId(location.pathname),
      viewerId: viewer.id,
      lookupsStopped: stopped || !settings.lookups,
    };
    const verdict = rules.evaluate({ author: state(refs.author), reposter: state(refs.reposter) }, ctx);

    // Spend lookups only where an answer can change what is shown.
    const useful = ctx.filteredPage && !ctx.isFocal && !settings.paused
      && (settings.mode === 'allow' || settings.countries.length > 0);
    const now = Date.now();
    const isViewer = (r) => viewer.id !== undefined && state(r).id === viewer.id;
    const need = useful ? [refs.author, refs.reposter].filter((r) => r && !isViewer(r) && !feed.fresh(entryOf(r), now)) : [];
    wanting.set(cell, need.map((r) => r.handle));
    io.observe(cell);
    if (visible.has(cell)) want(wanting.get(cell));

    // Behaviour memory, with the country filter's exemptions: a country match
    // wins, a behaviour hit beats "checking" (database design, content.js).
    const live = dbLive() && ctx.filteredPage && !ctx.isFocal && !settings.paused && !(refs.author && isViewer(refs.author));
    const f = refs.facts ?? {};
    const hit = live && verdict.why !== 'match'
      ? memory.judge({ author: refs.author, reposter: refs.reposter, tweetId: post.tweetId, fp: f.fp, conv: f.conv, media: f.media },
        flags, index, { on: settings.db, now, viewerId: viewer.id })
      : null;
    if (live) record(post.tweetId, refs, verdict, hit, now);

    if (!verdict.hide && !hit) {
      hiddenHere.delete(post.tweetId);
      return clear(cell);
    }
    const entry = verdict.hide ? cache.get(verdict.handle.toLowerCase()) : undefined;
    if (verdict.why === 'match') hiddenHere.set(post.tweetId, { rule: 'country', country: verdict.country, k: entry?.k });
    else if (hit) hiddenHere.set(post.tweetId, { rule: hit.rule });
    else hiddenHere.delete(post.tweetId);
    const mark = revealed.has(post.tweetId) ? 'revealed' : !hit && verdict.why === 'checking' ? 'checking' : 'hidden';
    const text = hit ? memory.label(hit) : feed.label(verdict, entry);
    if (cell.dataset.papieren !== mark) cell.dataset.papieren = mark;
    if (cell.dataset.papierenLabel !== text) cell.dataset.papierenLabel = text;
    cell.dataset.papierenId = post.tweetId;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        visible.add(e.target);
        want(wanting.get(e.target) ?? []);
      } else {
        visible.delete(e.target);
        if (!e.target.isConnected) io.unobserve(e.target);
      }
    }
  }, { rootMargin: '100% 0px' });

  // A capturing click on a placeholder opens that one post, and keeps X from
  // treating the click as a click on the post.
  document.addEventListener('click', (e) => {
    const cell = e.target?.closest?.('[data-papieren="hidden"], [data-papieren="checking"]');
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    revealed.add(cell.dataset.papierenId);
    cell.dataset.papieren = 'revealed';
    if (dbLive()) push('revealed', cell.dataset.papierenId); // Req 4.3
  }, { capture: true, signal: off.signal });

  // --- Lookup queue: one in flight per tab, the worker decides when ---

  const queue = [];
  let busy = false;
  let timer = 0;

  function want(handles) {
    if (!handles.length) return;
    for (const h of handles) feed.enqueue(queue, h);
    pump();
  }

  function stop() {
    stopped = true;
    queue.length = 0;
    clearTimeout(timer);
    markAll(); // allowlist "checking" fails open (Req 7.3)
  }

  // One wake-up at the time the worker named; never while the tab is hidden.
  function wakeAt(at) {
    clearTimeout(timer);
    timer = setTimeout(pump, Math.max(0, at - Date.now()));
  }

  // Returns whether the queue may go straight on; after a refusal it waits.
  async function lookupOne(handle) {
    const permit = await message({ type: 'permit', handle });
    if (!permit?.grant) {
      if (!permit || permit.reason === 'stopped' || permit.reason === 'disabled') stop();
      else if (permit.retryAt != null) { // paused has none: a settings change restarts the queue
        feed.enqueue(queue, handle);
        wakeAt(permit.retryAt);
      }
      return false;
    }
    const usedFallback = !qids[adapter.id] || qids[adapter.id] === adapter.fallbackQid;
    const res = await askPage(adapter.lookupUrl(qids[adapter.id] ?? adapter.fallbackQid, handle));
    const out = feed.outcome(handle, res, usedFallback, Date.now(), xParse.parseAbout);
    if (out.entry) writeEntry(handle, out.entry);
    if (out.dropQid) { // retried once with the fallback; a second 404 counts
      delete qids[adapter.id];
      chrome.storage.local.remove(`qid:${adapter.id}`).catch(() => {});
      feed.enqueue(queue, handle);
    }
    if (out.report && (await message({ type: 'report', result: out.report }))?.stopped) stop();
    return true;
  }

  async function pump() {
    if (busy || !ready || !adapter || stopped || !settings.lookups || settings.paused || document.hidden) return;
    const handle = queue.pop();
    if (handle === undefined) return;
    // Queued before a payload showed the handle is the viewer's, or answered since.
    const mine = viewer.handle?.toLowerCase() === handle.toLowerCase();
    if (mine || feed.fresh(cache.get(handle.toLowerCase()), Date.now())) return pump();
    busy = true;
    let more = false;
    try {
      more = await lookupOne(handle);
    } finally {
      busy = false;
    }
    if (more) pump();
  }

  document.addEventListener('visibilitychange', () => {
    if (orphaned()) return;
    if (document.hidden) {
      clearTimeout(timer);
      clearTimeout(flushTimer);
      sendFlush(); // one last flush, then none until the tab is visible again
    } else {
      pump();
      queueFlush();
    }
  }, { signal: off.signal });

  // --- Settings and cache, live from every tab (Req 6.2, 1.3, 2.3) ---

  const placeholder = () => { document.documentElement.dataset.papierenPlaceholder = settings.placeholder; };

  chrome.storage.local.onChanged.addListener((changes) => {
    let touched = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === 'settings') {
        const was = dbLive();
        settings = Settings.normalize(newValue);
        dbFailed = false; // the next answer says again (Req 7.2)
        if (!settings.db.on) dbReset();
        else if (!was) loadFlags();
        stopped = false; // the next permit says again if the worker is still stopped
        placeholder();
        touched = true;
      } else if (key.startsWith('c:')) {
        if (newValue) cache.set(key.slice(2), newValue);
        else cache.delete(key.slice(2));
        touched = true;
      } else if (key === 'dbEpoch' && dbLive()) {
        // The worker deleted behaviour rows ("Delete all", a sweep): the
        // tab's flags and sightings may still count them. The buffer stays,
        // it is not yet stored; the answer re-judges every cell.
        flags = memory.emptyFlags();
        index = memory.createIndex();
        loadFlags();
      }
    }
    if (touched) {
      markAll();
      pump();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'stats') return false;
    sendResponse({ layout: adapter?.id ?? null, byCountry: feed.stats(hiddenHere.values()), byDetection: feed.byDetection(hiddenHere.values()) });
    return false;
  });

  // --- Orphan ---

  // An extension reload leaves this script running in the tab, cut off from
  // storage events and the worker, so its settings go stale. It hands the feed
  // back to X instead; the tab's next load runs the new script.
  let mo = null;
  function orphaned() {
    if (chrome.runtime?.id) return false;
    if (!off.signal.aborted) {
      off.abort();
      mo?.disconnect();
      io.disconnect();
      clearTimeout(timer);
      clearTimeout(flushTimer);
      stopped = true;
      queue.length = 0;
      for (const cell of document.querySelectorAll('[data-papieren]')) clear(cell);
      delete document.documentElement.dataset.papierenPlaceholder;
    }
    return true;
  }

  // --- Boot ---

  async function boot() {
    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('c:') && !cache.has(k.slice(2))) cache.set(k.slice(2), v);
      else if (k.startsWith('qid:')) qids[k.slice(4)] ??= v;
    }
    settings = Settings.normalize(all.settings);
    placeholder();
    if (settings.db.on) loadFlags();
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    adapter = variants.detect(document);
    message({ type: 'layout', known: !!adapter }); // "?" on this tab when unknown
    if (!adapter) return;
    mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          const el = n.nodeType === 1 ? n : n.parentElement;
          if (el) dirty.add(el);
        }
      }
      schedule();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    markAll();
    pump();
  }

  toPage({ kind: 'hello' }); // the hook may have seen X's bearer before we loaded
  boot();
})();

// Isolated world, document_start, loaded after src/lib/*.js. Owns the DOM:
// reads each post cell, decides with rules.evaluate(), marks the cell for
// content.css, and runs this tab's lookup queue. Talks to the page hook in
// JSON strings over DOM events, and to the worker for permits.
(() => {
  const { settings: Settings, rules, xParse, variants, feed } = globalThis.Papieren;
  const TO_PAGE = 'papieren:to-page';
  const FROM_PAGE = 'papieren:from-page';
  const VARIANTS = new Set(['legacy', 'rebuilt']);

  let settings = Settings.normalize();
  const cache = new Map();        // lowercased handle -> CacheEntry
  const tweets = new Map();       // tweetId -> { author, reposter? }, see feed.remember
  const qids = {};                // variant -> AboutAccountQuery id X itself used
  const viewer = { id: feed.viewerIdFrom(document.cookie), handle: undefined };
  let adapter = null;
  let ready = false;              // the hook holds X's bearer (HookNotReady until then)
  let stopped = false;            // the last permit or report said stopped or disabled

  const message = async (msg) => {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return undefined; // extension reloaded or worker unreachable
    }
  };

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
  // for posts the map has not seen (Req 2.4).
  function intake(body) {
    const { tweets: found } = xParse.walkTimeline(body);
    for (const v of found.values()) {
      for (const u of [v.author, v.reposter]) if (viewer.id && u?.id === viewer.id) viewer.handle = u.handle;
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
  });

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

    if (!verdict.hide) {
      hiddenHere.delete(post.tweetId);
      return clear(cell);
    }
    const entry = cache.get(verdict.handle.toLowerCase());
    if (verdict.why === 'match') hiddenHere.set(post.tweetId, { country: verdict.country, k: entry?.k });
    const mark = revealed.has(post.tweetId) ? 'revealed' : verdict.why === 'checking' ? 'checking' : 'hidden';
    const text = feed.label(verdict, entry);
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
  }, true);

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
    if (document.hidden) clearTimeout(timer);
    else pump();
  });

  // --- Settings and cache, live from every tab (Req 6.2, 1.3, 2.3) ---

  const placeholder = () => { document.documentElement.dataset.papierenPlaceholder = settings.placeholder; };

  chrome.storage.local.onChanged.addListener((changes) => {
    let touched = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === 'settings') {
        settings = Settings.normalize(newValue);
        stopped = false; // the next permit says again if the worker is still stopped
        placeholder();
        touched = true;
      } else if (key.startsWith('c:')) {
        if (newValue) cache.set(key.slice(2), newValue);
        else cache.delete(key.slice(2));
        touched = true;
      }
    }
    if (touched) {
      markAll();
      pump();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'stats') return false;
    sendResponse({ layout: adapter?.id ?? null, byCountry: feed.stats(hiddenHere.values()) });
    return false;
  });

  // --- Boot ---

  async function boot() {
    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('c:') && !cache.has(k.slice(2))) cache.set(k.slice(2), v);
      else if (k.startsWith('qid:')) qids[k.slice(4)] ??= v;
    }
    settings = Settings.normalize(all.settings);
    placeholder();
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    adapter = variants.detect(document);
    message({ type: 'layout', known: !!adapter }); // "?" on this tab when unknown
    if (!adapter) return;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          const el = n.nodeType === 1 ? n : n.parentElement;
          if (el) dirty.add(el);
        }
      }
      schedule();
    }).observe(document.body, { childList: true, subtree: true });
    markAll();
    pump();
  }

  toPage({ kind: 'hello' }); // the hook may have seen X's bearer before we loaded
  boot();
})();

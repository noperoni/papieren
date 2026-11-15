// The decisions content.js makes that need no DOM: author state, cache
// entries, placeholder labels, lookup outcomes, the queue and the identity
// map. Pure apart from the Maps and arrays it is handed. Shared-lib pattern,
// see rules.js.
(() => {
  const TTL_MS = 30 * 24 * 60 * 60 * 1000; // Req 3.3
  const QUEUE_MAX = 25;
  const TWEETS_MAX = 5000;

  const cacheKey = (handle) => `c:${String(handle).toLowerCase()}`;
  const fresh = (entry, now) => !!entry && now - entry.t < TTL_MS;

  // AuthorState for rules.evaluate(). A stale entry still decides the post
  // while its refresh waits in the queue; only no entry at all is pending.
  // A DOM-only author has no id, so the viewer is also matched by handle.
  function authorState(ref, entry, viewer) {
    const isViewer = viewer.handle && ref.handle.toLowerCase() === viewer.handle.toLowerCase();
    const id = ref.id ?? (isViewer ? viewer.id : undefined);
    const state = { handle: ref.handle, country: entry ? entry.c : 'pending' };
    return id === undefined ? state : { id, ...state };
  }

  // parseAbout() result -> CacheEntry. A gone account caches as no country.
  function entryOf(parsed, now) {
    if (!parsed.ok) return { c: null, a: true, k: 'unverified', t: now };
    const e = { c: parsed.country, a: parsed.accurate, k: parsed.confidence, t: now };
    if (parsed.via) e.s = parsed.via;
    if (parsed.created) e.cc = parsed.created;
    if (parsed.id) e.id = parsed.id;
    return e;
  }

  // One line naming the handle and what matched (Req 5.1, packs Req 7.1), with
  // the confidence mark only on a country match (Req 8.4).
  function label(verdict, entry) {
    if (verdict.why === 'checking') return `Checking @${verdict.handle}'s country (click to show)`;
    const k = verdict.rule === 'country' ? entry?.k : undefined;
    const mark = k === 'confirmed' || k === 'flagged' ? ` · ${k}` : '';
    return `Hidden: @${verdict.handle} · ${verdict.label}${mark} (click to show)`;
  }

  // What one lookup answer means (design: Lookup errors). res is the hook's
  // { status, rateLimit, body }. Returns any of: report for the worker, a
  // cache entry, and dropQid when X no longer knows the query id we used.
  function outcome(handle, res, usedFallback, now, parseAbout) {
    const rateLimit = res.rateLimit ?? {};
    const failed = { report: { ok: false, status: res.status, rateLimit } };
    if (res.status === 429) return failed; // the worker cools down; not a failure
    // ponytail: HTTP 404 only; add X's GraphQL "query not found" error once one is seen.
    if (res.status === 404 && !usedFallback) return { dropQid: true };
    if (res.status !== 200) return failed;
    const parsed = parseAbout(res.body, handle);
    if (parsed.ok || parsed.error === 'gone') {
      return { report: { ok: true, status: 200, rateLimit }, entry: entryOf(parsed, now) };
    }
    return failed; // mismatch, shape, api: counted, nothing cached
  }

  // LIFO capped at 25: the newest sighting goes on top, the oldest falls off,
  // and comes back if it is seen again.
  function enqueue(queue, handle) {
    const i = queue.indexOf(handle);
    if (i >= 0) queue.splice(i, 1);
    queue.push(handle);
    if (queue.length > QUEUE_MAX) queue.shift();
  }

  // Merges walkTimeline() tweets into the identity map, capped at 5,000 with
  // the oldest evicted. A known repost pair is never downgraded by a later
  // standalone sighting of the original, as within one walk.
  function remember(map, found) {
    for (const [id, v] of found) {
      const keep = map.get(id)?.reposter && !v.reposter ? map.get(id) : v;
      map.delete(id);
      map.set(id, keep);
    }
    while (map.size > TWEETS_MAX) map.delete(map.keys().next().value);
  }

  // The twid cookie is "u%3D<rest_id>".
  const viewerIdFrom = (cookie) => /(?:^|;\s*)twid=u%3D(\d+)/.exec(cookie ?? '')?.[1];

  // The page a Hidden_History row names; undefined off the filtered pages.
  const pageKind = (pathname) => (/^\/home$/.test(pathname) ? 'home'
    : /^\/[^/]+\/status\/\d+/.test(pathname) ? 'status' : /^\/search/.test(pathname) ? 'search' : undefined);

  // Hidden posts on this page by country and confidence, for the popup (Req 5.4, 8.4).
  // hidden: { rule, country?, k? }; a behaviour hide has no country.
  function stats(hidden) {
    const by = {};
    for (const { country, k } of hidden) {
      if (country === undefined) continue;
      const row = (by[country] ??= { n: 0, confirmed: 0, flagged: 0 });
      row.n += 1;
      if (k === 'confirmed' || k === 'flagged') row[k] += 1;
    }
    return by;
  }

  // Hides on this page by every rule but country, for the popup (database
  // Req 6.2, packs Req 7.4).
  function byRule(hidden) {
    const by = {};
    for (const { rule } of hidden) if (rule && rule !== 'country') by[rule] = (by[rule] ?? 0) + 1;
    return by;
  }

  const feed = { cacheKey, fresh, authorState, entryOf, label, outcome, enqueue, remember, viewerIdFrom, pageKind, stats, byRule };

  globalThis.Papieren ??= {};
  globalThis.Papieren.feed = feed;
  if (typeof module === 'object') module.exports = feed;
})();

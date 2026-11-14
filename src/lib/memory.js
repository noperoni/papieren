// Behaviour memory in the tab (database design, lib/memory.js): fingerprints,
// the tab's own sightings, and the decision whether a post shows repeated
// behaviour. Pure apart from the index it is handed and crypto.subtle.
// Shared-lib pattern, see rules.js.
(() => {
  const THRESHOLDS = Object.freeze({ copy: 3, everywhere: 5, media: 3, offender: 5 }); // Glossary
  const MIN_TEXT = 20;            // characters, after normalize()
  const EVERYWHERE_MS = 24 * 60 * 60 * 1000;
  const INDEX_MAX = 5000;         // keys per map (Req 7.4)
  const FP_BYTES = 8;             // 16 hex characters

  // URLs first: a URL may hold an @. A mention needs a non-word character
  // (or the start) before it, so an e-mail address keeps its local part.
  const URLS = /\bhttps?:\/\/\S+/giu;
  const MENTIONS = /(^|[^\p{L}\p{N}_])@\w+/gu;

  // NFKC, lowercase, mentions and URLs out, whitespace collapsed. Replies
  // differ in whom they mention and in X's per-post t.co links, never in text.
  const normalize = (text) => String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(URLS, ' ').replace(MENTIONS, '$1 ').replace(/\s+/gu, ' ').trim();

  // A one-way stand-in for the text (Req 3.6). Undefined for a short text,
  // and when crypto.subtle is missing or throws: copy-paste then never fires.
  async function fingerprint(text) {
    const norm = normalize(text);
    if ([...norm].length < MIN_TEXT) return undefined;
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
      return [...new Uint8Array(digest, 0, FP_BYTES)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return undefined;
    }
  }

  // X's ids grow with time: a shorter id is older, then by string order.
  const earlier = (a, b) => b === undefined || (a !== undefined && (a.length !== b.length ? a.length < b.length : a < b));

  // The tab's own sightings, keyed as the worker's flags are. Every map keeps
  // its newest INDEX_MAX keys.
  const createIndex = () => ({ copy: new Map(), conv: new Map(), media: new Map(), offence: new Map() });
  const emptyFlags = () => ({ copy: {}, everywhere: {}, media: {}, offender: {} });

  function touch(map, key, make) {
    let v = map.get(key);
    if (v === undefined) v = make();
    else map.delete(key);
    map.set(key, v);
    if (map.size > INDEX_MAX) map.delete(map.keys().next().value);
    return v;
  }

  // sighting: { kind: 'copy' | 'conv' | 'media' | 'offence', key, author, tweet?, t },
  // the same shape the flush sends. key: fingerprint, conversation id, media id or tweet id.
  function observe(index, s) {
    if (s.kind === 'copy') touch(index.copy, s.key, () => new Set()).add(s.author);
    else if (s.kind === 'conv') touch(index.conv, s.author, () => new Map()).set(s.key, s.t);
    else if (s.kind === 'offence') touch(index.offence, s.author, () => new Set()).add(s.key);
    else if (s.kind === 'media') {
      const m = touch(index.media, s.key, () => ({ authors: new Set(), first: s.tweet }));
      m.authors.add(s.author);
      if (earlier(s.tweet, m.first)) m.first = s.tweet;
    }
  }

  // Merges a worker answer. A zero or null count drops the key.
  function merge(flags, delta) {
    for (const kind of Object.keys(flags)) {
      for (const [key, v] of Object.entries(delta?.[kind] ?? {})) {
        if (!v || (typeof v === 'object' && !v.n)) delete flags[kind][key];
        else flags[kind][key] = v;
      }
    }
  }

  function convCount(index, author, now) {
    let n = 0;
    for (const t of index.conv.get(author)?.values() ?? []) if (now - t <= EVERYWHERE_MS) n += 1;
    return n;
  }

  const hit = (det, user, n) => ({ rule: `bm:${det}`, handle: user.handle, n });

  // post: { author: UserRef, reposter?: UserRef, tweetId, fp?, conv?, media? };
  // conv is set only on a Reply. ctx: { on: { copy, everywhere, media, offender }, now, viewerId }.
  // Neither the viewer nor a followed Author is judged (Req 3.8), nor one
  // without an id: these detections read payloads only. The worker's count
  // already holds this tab's flushed sightings, so the two are never added:
  // the larger wins.
  function judge(post, flags, index, ctx) {
    const { on, now, viewerId } = ctx;
    const judged = (u) => !!u?.id && !u.followed && u.id !== viewerId;
    const a = judged(post.author) ? post.author : undefined;

    if (a && post.conv !== undefined) {
      if (on.copy && post.fp) {
        const n = Math.max(flags.copy[post.fp] ?? 0, index.copy.get(post.fp)?.size ?? 0);
        if (n >= THRESHOLDS.copy) return hit('copy', a, n);
      }
      if (on.everywhere) {
        const n = Math.max(flags.everywhere[a.id] ?? 0, convCount(index, a.id, now));
        if (n >= THRESHOLDS.everywhere) return hit('everywhere', a, n);
      }
    }
    if (a && on.media) {
      for (const id of post.media ?? []) {
        const w = flags.media[id];
        const l = index.media.get(id);
        const n = Math.max(w?.n ?? 0, l?.authors.size ?? 0);
        const first = earlier(w?.first, l?.first) ? w?.first : l?.first;
        // The earliest post seen with the media stays (Req 3.3).
        if (n >= THRESHOLDS.media && first !== undefined && earlier(first, post.tweetId)) {
          return hit('media', a, n);
        }
      }
    }
    if (on.offender) {
      for (const u of [post.author, post.reposter]) {
        if (!judged(u)) continue;
        const n = Math.max(flags.offender[u.id] ?? 0, index.offence.get(u.id)?.size ?? 0);
        if (n >= THRESHOLDS.offender) return hit('offender', u, n);
      }
    }
    return null;
  }

  const WHY = {
    'bm:copy': (n) => `copy-paste reply, ${n} accounts`,
    'bm:everywhere': (n) => `replies everywhere, ${n} conversations in 24 h`,
    'bm:media': (n) => `recycled media, ${n} accounts`,
    'bm:offender': (n) => `repeat offender, hidden ${n} times`,
  };

  // One line naming the handle and the detection (Req 6.1).
  const label = (h) => `Hidden: @${h.handle} · ${WHY[h.rule](h.n)} (click to show)`;

  const memory = { THRESHOLDS, MIN_TEXT, EVERYWHERE_MS, normalize, fingerprint, earlier, createIndex, emptyFlags, observe, merge, judge, label };

  globalThis.Papieren ??= {};
  globalThis.Papieren.memory = memory;
  if (typeof module === 'object') module.exports = memory;
})();

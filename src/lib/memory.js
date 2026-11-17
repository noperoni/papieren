// Behaviour memory in the tab (database design, lib/memory.js): fingerprints,
// the tab's own sightings, and the decision whether a post shows repeated
// behaviour. Pure apart from the index it is handed and crypto.subtle.
// Shared-lib pattern, see rules.js.
(() => {
  const THRESHOLDS = Object.freeze({ copy: 3, everywhere: 5, media: 3, offender: 5 }); // Glossary
  // The count from which the worker keeps a flag: the detection's threshold,
  // except detections and Pack hides per Author, which account Tells read
  // from the first (packs design, account Tells).
  const FLAG_MIN = Object.freeze({ ...THRESHOLDS, offender: 1, packs: 1 });
  const OFFENCES = 2;             // the offences account Tell: 2 or more detections
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

  // Local date, YYYY-MM-DD: the day a flush, a Hidden_History row or a
  // Rule_Statistics row belongs to. Here so content.js has it; records.js re-exports it.
  const dayOf = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // X's ids grow with time: a shorter id is older, then by string order.
  const earlier = (a, b) => b === undefined || (a !== undefined && (a.length !== b.length ? a.length < b.length : a < b));

  // The tab's own sightings, keyed as the worker's flags are. Every map keeps
  // its newest INDEX_MAX keys.
  const createIndex = () => ({ copy: new Map(), conv: new Map(), media: new Map(), offence: new Map(), pack: new Map() });
  const emptyFlags = () => ({ copy: {}, everywhere: {}, media: {}, offender: {}, packs: {} });

  function touch(map, key, make) {
    let v = map.get(key);
    if (v === undefined) v = make();
    else map.delete(key);
    map.set(key, v);
    if (map.size > INDEX_MAX) map.delete(map.keys().next().value);
    return v;
  }

  // sighting: { kind: 'copy' | 'conv' | 'media' | 'offence' | 'pack', key, author, tweet?, rule?, t },
  // the same shape the flush sends. key: fingerprint, conversation id, media id or tweet id.
  // An offence is a behaviour detection, a pack row a Pack hide: both map tweet -> rule.
  function observe(index, s) {
    if (s.kind === 'copy') touch(index.copy, s.key, () => new Set()).add(s.author);
    else if (s.kind === 'conv') touch(index.conv, s.author, () => new Map()).set(s.key, s.t);
    else if (s.kind === 'offence' || s.kind === 'pack') touch(index[s.kind], s.author, () => new Map()).set(s.key, s.rule);
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

  // A worker flag ({ n, first } or, from before account Tells, a bare n) and the
  // tab's rows (tweet -> rule) as one: the larger count, never added, and
  // the earliest tweet per rule.
  function tally(flag, local) {
    const first = { ...(flag?.first ?? {}) };
    for (const [tweet, rule] of local ?? []) if (earlier(tweet, first[rule])) first[rule] = tweet;
    return { n: Math.max(typeof flag === 'number' ? flag : flag?.n ?? 0, local?.size ?? 0), first };
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
        const { n } = tally(flags.offender[u.id], index.offence.get(u.id));
        if (n >= THRESHOLDS.offender) return hit('offender', u, n);
      }
    }
    return null;
  }

  // What the account Tells read of one Author's behaviour, against the Post
  // being judged (packs design, account Tells): Reply_Everywhere, 2
  // or more behaviour detections, and the rules that caught an older Post of
  // theirs, a detection (copy, recycled) or a Pack hide (hidden: Pack ids).
  // The Post's own record never counts against it. Undefined for the viewer,
  // a followed Author and one without an id, as in judge() (Req 3.8).
  function account(u, flags, index, ctx) {
    const { now, viewerId, tweetId } = ctx;
    if (!u?.id || u.followed || u.id === viewerId) return undefined;
    const older = (first) => first !== undefined && earlier(first, tweetId);
    const is = new Set();
    if (Math.max(flags.everywhere[u.id] ?? 0, convCount(index, u.id, now)) >= THRESHOLDS.everywhere) is.add('everywhere');
    const offences = tally(flags.offender[u.id], index.offence.get(u.id));
    if (offences.n >= OFFENCES) is.add('offences');
    if (older(offences.first['bm:copy'])) is.add('copy');
    if (older(offences.first['bm:media'])) is.add('recycled');
    const hides = tally(flags.packs[u.id], index.pack.get(u.id)).first;
    const hidden = new Set(Object.keys(hides).filter((rule) => older(hides[rule])).map((rule) => rule.slice('pack:'.length)));
    return { is, hidden };
  }

  const WHY = {
    'bm:copy': (n) => `copy-paste reply, ${n} accounts`,
    'bm:everywhere': (n) => `replies everywhere, ${n} conversations in 24 h`,
    'bm:media': (n) => `recycled media, ${n} accounts`,
    'bm:offender': (n) => `repeat offender, ${n} detections`,
  };

  // One line naming the handle and the detection (Req 6.1).
  const label = (h) => `Hidden: @${h.handle} · ${WHY[h.rule](h.n)} (click to show)`;

  const memory = {
    THRESHOLDS, FLAG_MIN, OFFENCES, MIN_TEXT, EVERYWHERE_MS,
    normalize, fingerprint, dayOf, earlier, createIndex, emptyFlags, observe, merge, judge, account, label,
  };

  globalThis.Papieren ??= {};
  globalThis.Papieren.memory = memory;
  if (typeof module === 'object') module.exports = memory;
})();

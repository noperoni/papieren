// The Pack Signal (packs design, signals/packs.js): what a Pack reads from
// each payload, the Score memo filled at intake, and the judge that hides on
// the Pack exceeding its Threshold by the most. Shared-lib pattern, see lib/rules.js.
(() => {
  const signals = globalThis.Papieren?.signals ?? require('../lib/signals.js');
  const lib = globalThis.Papieren?.packs ?? require('../lib/packs.js');
  const TEXT_MAX = 500;
  const BIO_MAX = 300;
  const MEDIA = { photo: 'image', video: 'video', animated_gif: 'gif' };
  const OUTSIDE = 'packs:outside';

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const cut = (s, n) => [...s].slice(0, n).join('');

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || undefined;
    } catch {
      return undefined;
    }
  }

  // ---- facts hooks: X tweet and user results -> what a Pack reads ----

  // The visible text is full_text cut to display_text_range, or the whole
  // note_tweet. Shape from it in its original case; the text kept folded.
  // ponytail: whether note_tweet text is HTML-escaped is unverified (no '&'
  // in the 13 captured); unescaping it too costs only a typed "&amp;".
  function fromTweet(tweet) {
    const legacy = tweet?.legacy;
    if (!legacy || typeof legacy !== 'object') return undefined;
    const note = tweet.note_tweet?.note_tweet_results?.result?.text;
    const shown = typeof note === 'string' && note.trim() ? lib.visible(note) : lib.visible(legacy.full_text, legacy.display_text_range);
    const entities = legacy.entities && typeof legacy.entities === 'object' ? legacy.entities : undefined;
    // X omits an empty list, so with entities present an absent key counts 0.
    const hashtags = entities ? (Array.isArray(entities.hashtags) ? entities.hashtags.length : 0) : undefined;

    const media = new Set();
    const list = legacy.extended_entities?.media ?? entities?.media;
    for (const m of Array.isArray(list) ? list : []) if (MEDIA[m?.type]) media.add(MEDIA[m.type]);
    // ponytail: poll by card name, unverified (no poll among the captured cards).
    if (str(tweet.card?.legacy?.name)?.startsWith('poll')) media.add('poll');
    // The quoted Post's permalink is no link of this Post's own (Req 1.5).
    const perm = legacy.quoted_status_permalink;
    const urls = (Array.isArray(entities?.urls) ? entities.urls : [])
      .filter((u) => !perm || (u?.url !== perm.url && u?.expanded_url !== perm.expanded));
    if (urls.length) media.add('link');
    const domains = [...new Set(urls.map((u) => hostOf(u?.expanded_url)).filter(Boolean))];

    const facts = {
      media: [...media], domains,
      reply: str(legacy.in_reply_to_status_id_str) !== undefined, quote: legacy.is_quote_status === true,
    };
    // No text field at all is payload drift: no shape, so no shape Tell is met (Req 1.6).
    if (typeof shown === 'string') facts.shape = lib.measure(shown, hashtags);
    if (shown?.trim()) facts.text = cut(lib.fold(shown), TEXT_MAX);
    if (str(legacy.lang)) facts.lang = str(legacy.lang);
    return facts;
  }

  // The checkmarks, from the captured payloads: verification.verified_type
  // Business is gold and Government grey, whatever is_blue_verified says;
  // blue is is_blue_verified without a type; an affiliate badge is a
  // non-empty affiliates_highlighted_label.label, on any of them.
  const TYPED = { Business: 'gold', Government: 'grey' };
  function badgesOf(user) {
    const out = [];
    const typed = TYPED[user?.verification?.verified_type];
    if (typed) out.push(typed);
    else if (user?.is_blue_verified === true) out.push('blue');
    const label = user?.affiliates_highlighted_label?.label;
    if (label && typeof label === 'object' && Object.keys(label).length) out.push('affiliate');
    return out;
  }

  // Name and bio, core and profile_bio first: no captured user had the legacy pair.
  function fromUser(user) {
    const name = str(user?.core?.name) ?? str(user?.legacy?.name);
    const bio = str(user?.profile_bio?.description) ?? str(user?.legacy?.description);
    const badges = badgesOf(user);
    if (!name && !bio && !badges.length) return undefined;
    const out = {};
    if (name) out.name = lib.fold(name);
    if (bio) out.bio = cut(lib.fold(bio), BIO_MAX);
    if (badges.length) out.badges = badges;
    return out;
  }

  // ---- the Packs in storage.local, validated, and the enabled set ----

  const raw = { 'packs:builtin': undefined, 'packs:user': undefined };
  let packs = [];        // every valid Pack, built-ins first, then user Packs, in stored order
  let version = 0;
  let enabled = { key: undefined, list: [] };

  // content.js hands in each key of `keys` at boot and on every change.
  // A stored Pack that fails is left out of matching (Error Handling).
  function stored(key, value) {
    if (!(key in raw)) return;
    raw[key] = value;
    packs = lib.merge(raw['packs:builtin'], raw['packs:user']);
    version += 1;
  }

  // The enabled Packs in list order; the same array until a Pack or packs.on
  // changes, since compile() and the memo key on its identity.
  function enabledPacks(settings) {
    const on = settings.packs?.on ?? [];
    const key = `${version}\n${on.join('\n')}`;
    if (enabled.key !== key) {
      const ids = new Set(on);
      enabled = { key, list: packs.filter((p) => ids.has(p.id)) };
    }
    return enabled.list;
  }

  // ---- Score memo and judge ----

  const memo = new WeakMap();   // facts object -> { key: the compiled set, scores: Map(pack id -> Score) }

  // Of the Packs whose Score reaches their Threshold, the one exceeding it by
  // the most; ties to the earlier in the list (Req 7.2). The account Tells'
  // share is added here, at judge time: behaviour moves after intake.
  function best(compiled, scores, account) {
    let top = null;
    let margin = -1;
    for (const p of compiled) {
      const m = scores.get(p.id) + (account.get(p.id) ?? 0) - p.threshold;
      if (m > margin) {
        top = p;
        margin = m;
      }
    }
    return top;
  }

  function memoFor(facts, compiled, repost, authors) {
    let m = memo.get(facts);
    if (m?.key !== compiled) {
      m = { key: compiled, scores: lib.score(compiled, { ...facts.sig.packs, repost }, authors.map((a) => a?.sig?.packs)) };
      memo.set(facts, m);
    }
    return m;
  }

  // Intake: score each new record now, off the mutation path. The viewer
  // never adds to a Score, as rules.evaluate never judges them.
  // ponytail: one pass over the whole payload. At 20 Packs of 300 Tells that
  // is about 2.5 ms per Post, 7.5 ms on the first payload while V8 compiles
  // the RegExps (bench-packs.test.js); spread it over idle callbacks
  // if a long task shows on the burner.
  function prepare(records, ctx) {
    const list = enabledPacks(ctx.settings);
    if (!list.length) return;
    const compiled = lib.compile(list);
    const viewer = (a) => ctx.viewerId != null && a.id === ctx.viewerId;
    for (const r of records) {
      if (!r.facts?.sig?.packs) continue;
      memoFor(r.facts, compiled, r.reposter !== undefined, [r.author, r.reposter].filter((a) => a && !viewer(a)));
    }
  }

  const active = (settings) => enabledPacks(settings).length > 0;

  // What Rule_Statistics count as judged (content.js activeRules).
  const rules = (settings) => [
    ...enabledPacks(settings).map((p) => `pack:${p.id}`),
    ...(settings.packs?.mode === 'allbut' ? [OUTSIDE] : []),
  ];

  // post: { author, reposter, facts, authors }, the viewer already out of
  // authors. No Pack facts: never hidden, in either mode (Req 2.6).
  // The handle named is the Author's, for a repost the reposted Post's.
  // ponytail: naming the Author whose Tells weighed most needs per-Author scores.
  function judge(post, ctx) {
    if (!post.facts?.sig?.packs) return null;
    const compiled = lib.compile(enabledPacks(ctx.settings));
    const { scores } = memoFor(post.facts, compiled, post.reposter !== undefined, post.authors);
    const account = lib.accountScore(compiled, post.authors.map((a) => ({ badges: a?.sig?.packs?.badges, acct: a?.acct })));
    const top = best(compiled, scores, account);
    const handle = post.author?.handle ?? post.authors[0]?.handle;
    if (ctx.settings.packs?.mode === 'allbut') return top ? null : { handle, rule: OUTSIDE, label: 'outside your packs' };
    return top ? { handle, rule: `pack:${top.id}`, label: top.name } : null;
  }

  const packsSignal = { id: 'packs', rank: 20, keys: Object.keys(raw), stored, active, rules, judge, prepare, fromTweet, fromUser };
  signals.register(packsSignal);
  if (typeof module === 'object') module.exports = packsSignal;
})();

// Parsers for X's own JSON: the AboutAccountQuery answer and timeline payloads.
// Pure: text in, plain data out. Shared-lib pattern, see rules.js.
(() => {
  const GONE_CODES = new Set([50, 63]); // 50 user not found, 63 suspended
  const BIO_MAX = 300;

  function parseJson(body) {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const screenName = (user) => str(user?.core?.screen_name) ?? str(user?.legacy?.screen_name);

  // "Europe App Store" -> "Europe". "Web", and any form not seen yet, gives
  // nothing, so an unrecognised source can only leave the mark "unverified",
  // never turn it "flagged".
  // ponytail: App Store form only; add the Android form once a real response shows it.
  function viaCountry(source) {
    const m = /^(.+) App Store$/.exec(str(source) ?? '');
    return m ? m[1] : undefined;
  }

  // Req 8, display only: rules.evaluate() never reads it.
  function confidence(country, accurate, via, created) {
    if (!accurate) return 'flagged';
    if (via === undefined && created === undefined) return 'unverified';
    return via === country || created === country ? 'confirmed' : 'flagged';
  }

  const fail = (error, code) => (code === undefined ? { ok: false, error } : { ok: false, error, code });

  function parseAbout(body, requested) {
    const json = parseJson(body);
    if (!json || typeof json !== 'object') return fail('shape');

    const codes = Array.isArray(json.errors) ? json.errors.map((e) => e?.code) : [];
    const gone = codes.find((c) => GONE_CODES.has(c));
    if (gone !== undefined) return fail('gone', gone);

    const result = json.data?.user_result_by_screen_name?.result;
    const profile = result?.about_profile;
    if (!profile || typeof profile !== 'object') {
      return codes.length ? fail('api', codes[0]) : fail('shape');
    }

    const handle = screenName(result);
    if (!handle) return fail('shape');
    if (handle.toLowerCase() !== String(requested).toLowerCase()) return fail('mismatch');

    const country = str(profile.account_based_in) ?? null;
    const accurate = profile.location_accurate !== false;
    const via = viaCountry(profile.source);
    // ponytail: field name from the spec, not yet seen in a real response;
    // confirm during the burner trial and drop it if X has none.
    const created = str(profile.created_country);

    const out = { ok: true, country, accurate, confidence: confidence(country, accurate, via, created) };
    if (via) out.via = via;
    if (created) out.created = created;
    if (str(result.rest_id)) out.id = result.rest_id;
    return out;
  }

  function userRef(user) {
    const handle = screenName(user);
    if (!handle || !str(user?.rest_id)) return undefined;
    const ref = { id: user.rest_id, handle };
    const bio = str(user.legacy?.description);
    if (bio) ref.bio = bio.slice(0, BIO_MAX);
    return ref;
  }

  const unwrap = (t) => (t?.__typename === 'TweetWithVisibilityResults' ? t.tweet : t);

  function record(tweet, tweets) {
    const author = userRef(tweet.core?.user_results?.result);
    if (!author || !str(tweet.rest_id)) return;

    const original = unwrap(tweet.legacy?.retweeted_status_result?.result);
    const originalAuthor = userRef(original?.core?.user_results?.result);
    if (originalAuthor && str(original.rest_id)) {
      // A repost cell's permalink carries the original's id, so both ids map
      // to the pair. The walk reaches the original again on its own later;
      // the guard below keeps that visit from dropping the reposter.
      const pair = { author: originalAuthor, reposter: author };
      tweets.set(tweet.rest_id, pair);
      tweets.set(original.rest_id, pair);
    } else if (!tweets.has(tweet.rest_id)) {
      tweets.set(tweet.rest_id, { author });
    }
  }

  // One pass over the whole payload, so every timeline shape (home, replies,
  // search, modules, conversation threads) is covered without knowing it.
  // A payload that does not parse yields an empty map (design: PayloadParse).
  function walkTimeline(body) {
    const tweets = new Map();
    const json = parseJson(body);
    const stack = json && typeof json === 'object' ? [json] : [];
    while (stack.length) {
      const node = stack.pop();
      if (node.__typename === 'Tweet') record(node, tweets);
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
    return { tweets };
  }

  const xParse = { parseAbout, walkTimeline };

  globalThis.Papieren ??= {};
  globalThis.Papieren.xParse = xParse;
  if (typeof module === 'object') module.exports = xParse;
})();

// Parsers for X's own JSON: the AboutAccountQuery answer and timeline payloads.
// Pure: text in, plain data out. Shared-lib pattern, see rules.js.
(() => {
  const signals = globalThis.Papieren?.signals ?? require('./signals.js');
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

  // What each registered Signal keeps from an X user or tweet, by Signal id
  // (packs design, x-parse.js). A hook that throws or returns nothing
  // contributes nothing; undefined when no hook kept anything.
  function hooked(obj, hook) {
    let out;
    for (const s of signals.all()) {
      if (!s[hook]) continue;
      let v;
      try {
        v = s[hook](obj);
      } catch {
        continue;
      }
      if (v !== undefined) (out ??= {})[s.id] = v;
    }
    return out;
  }

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
    // profile_bio is where X puts it; no captured user had legacy.description.
    const bio = str(user.profile_bio?.description) ?? str(user.legacy?.description);
    if (bio) ref.bio = bio.slice(0, BIO_MAX);
    // X's own record that the viewer follows this user (database Req 3.8).
    // ponytail: both known places; keep the one a captured payload shows.
    // relationship_perspectives is where legacy X puts it (2026-11-15); legacy.following
    // was in no capture and stays for the rebuilt app's payloads until the burner trial says.
    if (user.relationship_perspectives?.following === true || user.legacy?.following === true) ref.followed = true;
    const sig = hooked(user, 'fromUser');
    if (sig) ref.sig = sig;
    return ref;
  }

  // What behaviour memory reads from a tweet (database design, x-parse):
  // conv only on a Reply, text only with it (fingerprinted, then dropped by
  // content.js), and the media ids X attached; then sig, what the Signals
  // keep (packs design). Undefined when there is none.
  function factsOf(tweet) {
    const legacy = tweet?.legacy ?? {};
    const facts = {};
    const conv = str(legacy.conversation_id_str);
    if (conv && str(legacy.in_reply_to_status_id_str)) {
      facts.conv = conv;
      const text = str(tweet.note_tweet?.note_tweet_results?.result?.text) ?? str(legacy.full_text);
      if (text) facts.text = text;
    }
    const list = legacy.extended_entities?.media ?? legacy.entities?.media;
    const media = Array.isArray(list) ? [...new Set(list.map((m) => str(m?.id_str)).filter(Boolean))] : [];
    if (media.length) facts.media = media;
    const sig = hooked(tweet, 'fromTweet');
    if (sig) facts.sig = sig;
    return Object.keys(facts).length ? facts : undefined;
  }

  // A record carries facts only when there are some, so the identity map
  // stays as small as before for everything else.
  const withFacts = (rec, tweet) => {
    const facts = factsOf(tweet);
    return facts ? { ...rec, facts } : rec;
  };

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
      // The facts are the original's: a repost wrapper has no text or media of its own.
      const pair = withFacts({ author: originalAuthor, reposter: author }, original);
      tweets.set(tweet.rest_id, pair);
      tweets.set(original.rest_id, pair);
    } else if (!tweets.has(tweet.rest_id)) {
      tweets.set(tweet.rest_id, withFacts({ author }, tweet));
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

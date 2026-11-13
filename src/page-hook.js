// MAIN world, document_start. Self-contained: shared libs never load here,
// so as little of our code as possible runs where X's scripts can see it.
// It observes X's own GraphQL traffic, forwards raw text to content.js, and
// makes the one GET it is asked for. All parsing and decisions happen in the
// isolated world. Messages cross as JSON strings, which every world can read.
(() => {
  const TO_PAGE = 'papieren:to-page';
  const FROM_PAGE = 'papieren:from-page';
  const TIMELINE_OPS = new Set(['HomeTimeline', 'HomeLatestTimeline', 'TweetDetail', 'SearchTimeline']);
  const GRAPHQL = /^(?:\/i\/api)?\/graphql\/([A-Za-z0-9_-]+)\/([A-Za-z]+)$/;
  const LOOKUP_PATH = { 'x.com': /^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/AboutAccountQuery$/, 'api.x.com': /^\/graphql\/[A-Za-z0-9_-]+\/AboutAccountQuery$/ };

  const nativeFetch = window.fetch;
  const XHR = XMLHttpRequest.prototype;
  const { open, setRequestHeader, send } = XHR;
  const requests = new WeakMap(); // xhr -> parsed op, or null
  const qids = {};
  let bearer;

  const emit = (msg) => document.dispatchEvent(new CustomEvent(FROM_PAGE, { detail: JSON.stringify(msg) }));

  function parseUrl(raw) {
    try {
      return new URL(raw, location.href);
    } catch {
      return null;
    }
  }

  const isXApi = (u) => u?.protocol === 'https:' && (u.hostname === 'x.com' || u.hostname === 'api.x.com');

  // { qid, name, variant, url } for X's GraphQL calls, else null. The qid is
  // announced as soon as X uses it, whatever the answer turns out to be.
  function graphqlOp(raw) {
    const url = parseUrl(raw);
    const m = isXApi(url) && GRAPHQL.exec(url.pathname);
    if (!m) return null;
    const op = { qid: m[1], name: m[2], variant: url.hostname === 'api.x.com' ? 'rebuilt' : 'legacy', url };
    if (op.name === 'AboutAccountQuery' && qids[op.variant] !== op.qid) {
      qids[op.variant] = op.qid;
      emit({ kind: 'qid', variant: op.variant, qid: op.qid });
    }
    return op;
  }

  // Kept here, never sent anywhere but X: follows X if it ever rotates.
  function sniffBearer(url, value) {
    if (!isXApi(url) || typeof value !== 'string' || !value.startsWith('Bearer ')) return;
    const first = bearer === undefined;
    bearer = value;
    if (first) emit({ kind: 'ready' });
  }

  function screenNameOf(url) {
    try {
      return JSON.parse(url.searchParams.get('variables'))?.screenName;
    } catch {
      return undefined;
    }
  }

  function forward(op, status, body) {
    if (status < 200 || status >= 300 || typeof body !== 'string') return;
    if (TIMELINE_OPS.has(op.name)) {
      emit({ kind: 'payload', op: op.name, body });
    } else if (op.name === 'AboutAccountQuery') {
      // Passive capture (Req 3.8): X fetched it itself, so it costs nothing.
      const handle = screenNameOf(op.url);
      if (typeof handle === 'string') emit({ kind: 'about', handle, body });
    }
  }

  const wanted = (op) => op && (TIMELINE_OPS.has(op.name) || op.name === 'AboutAccountQuery');

  XHR.open = function (method, url) {
    requests.set(this, graphqlOp(url));
    return open.apply(this, arguments);
  };

  XHR.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === 'authorization') sniffBearer(requests.get(this)?.url, value);
    return setRequestHeader.apply(this, arguments);
  };

  XHR.send = function () {
    const op = requests.get(this);
    if (wanted(op)) {
      this.addEventListener('load', () => {
        const type = this.responseType;
        const body = type === '' || type === 'text' ? this.responseText
          : type === 'json' && this.response != null ? JSON.stringify(this.response)
          : undefined;
        forward(op, this.status, body);
      });
    }
    return send.apply(this, arguments);
  };

  window.fetch = function (input, init) {
    const promise = nativeFetch.apply(this, arguments);
    try {
      const op = graphqlOp(input instanceof Request ? input.url : input);
      if (op) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        sniffBearer(op.url, headers.get('authorization'));
      }
      if (wanted(op)) {
        promise.then((res) => res.clone().text().then((body) => forward(op, res.status, body))).catch(() => {});
      }
    } catch {
      // Observation must never break X's own request.
    }
    return promise;
  };

  // --- Lookup executor (Req 3.4, 4.1, 4.2) ---

  // The only request Papieren ever makes: a GET to AboutAccountQuery on X's
  // own API hosts. Anything else is refused before it reaches the network.
  function lookupAllowed(raw) {
    const url = parseUrl(raw);
    return !!url && isXApi(url) && url.port === '' && !url.username && !url.password
      && LOOKUP_PATH[url.hostname].test(url.pathname);
  }

  function rateLimitOf(headers) {
    const rl = {};
    const fields = [['limit', 'x-rate-limit-limit'], ['remaining', 'x-rate-limit-remaining'], ['reset', 'x-rate-limit-reset']];
    for (const [key, name] of fields) {
      const n = Number(headers.get(name) ?? NaN);
      if (Number.isFinite(n)) rl[key] = n;
    }
    const retry = headers.get('retry-after');
    if (retry) {
      const n = Number(retry);
      const s = Number.isFinite(n) ? n : (Date.parse(retry) - Date.now()) / 1000;
      if (Number.isFinite(s)) rl.retryAfter = Math.max(0, s);
    }
    return rl;
  }

  async function lookup(reqId, url) {
    const reply = (status, rateLimit = {}, body = '') => emit({ kind: 'lookup-result', reqId, status, rateLimit, body });
    const ct0 = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie)?.[1];
    // status 0: refused or never sent; content.js counts it as a failure.
    if (!lookupAllowed(url) || !bearer || !ct0) return reply(0);
    try {
      const res = await nativeFetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          authorization: bearer,
          'x-csrf-token': ct0,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'en',
          'accept-language': 'en-US',
        },
      });
      reply(res.status, rateLimitOf(res.headers), await res.text());
    } catch {
      reply(0);
    }
  }

  document.addEventListener(TO_PAGE, (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (msg?.kind === 'lookup' && Number.isInteger(msg.reqId)) lookup(msg.reqId, msg.url);
    // content.js may boot after the bearer was seen: it says hello, we answer.
    else if (msg?.kind === 'hello' && bearer !== undefined) emit({ kind: 'ready' });
  });
})();

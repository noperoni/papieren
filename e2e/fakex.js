// A fake legacy x.com for the feed rows: every https://x.com request is
// answered here, so nothing reaches X. A page is a list of posts; the page
// fetches its GraphQL payload the way X does (Bearer header, so page-hook.js
// announces ready), then renders one cellInnerDiv per post.
//
// The payloads follow test/content.test.js's builders, which follow the
// shapes x-parse.js reads. They are only as true to X as those are: the capture check's
// captures are what will say so, the follow flag above all (D3.8).

const QID = 'fakeQid0000000000000000';
const OPS = { home: 'HomeTimeline', status: 'TweetDetail', search: 'SearchTimeline' };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// A post: id and handle, plus uid (author rest_id), text, a reply's conv,
// media ids, and following when the viewer follows the author.
export const post = (id, handle, more = {}) => ({ id: String(id), handle, uid: more.uid ?? `9${id}`, ...more });

function tweetJson(p) {
  const user = { rest_id: p.uid, core: { screen_name: p.handle }, legacy: { screen_name: p.handle } };
  if (p.following) user.relationship_perspectives = { following: true };
  const legacy = { full_text: p.text ?? `post ${p.id}` };
  if (p.conv) Object.assign(legacy, { conversation_id_str: p.conv, in_reply_to_status_id_str: p.conv });
  if (p.media) legacy.extended_entities = { media: p.media.map((m) => ({ id_str: String(m) })) };
  return { __typename: 'Tweet', rest_id: p.id, core: { user_results: { result: user } }, legacy };
}

const cell = (p) => `<div data-testid="cellInnerDiv"><article>
<a href="/${esc(p.handle)}">@${esc(p.handle)}</a> <a href="/${esc(p.handle)}/status/${esc(p.id)}"><time datetime="2026-11-15T00:00:00.000Z">1m</time></a>
<div>${esc(p.text ?? `post ${p.id}`)}</div></article></div>`;

function html(key, kind, posts) {
  const cells = JSON.stringify(posts.map(cell));
  return `<!doctype html><html><head><meta charset="utf-8"><title>fake X</title></head>
<body><div id="react-root"><main><div aria-label="Timeline"></div></main></div>
<script>
(async () => {
  const vars = encodeURIComponent(JSON.stringify({ page: ${JSON.stringify(key)} }));
  const r = await fetch('/i/api/graphql/${QID}/${OPS[kind]}?variables=' + vars, { headers: { authorization: 'Bearer fake' } });
  await r.text();
  const box = document.querySelector('[aria-label="Timeline"]');
  for (const c of ${cells}) box.insertAdjacentHTML('beforeend', c);
  document.title = 'fake X ready';
})();
</script></body></html>`;
}

const kindOf = (pathname) => (pathname === '/home' ? 'home' : /^\/[^/]+\/status\/\d+/.test(pathname) ? 'status'
  : pathname === '/search' ? 'search' : null);

// Installs the fake on a Playwright context. pages maps a path (with any
// query) to its posts; set() replaces one, for a check that changes the feed
// between reloads. requests lists every URL the browser asked for, from any
// page, frame or worker, extension ones included.
export async function fakeX(ctx, { viewer = { id: '42', handle: 'me' } } = {}) {
  const pages = new Map();
  const requests = [];
  ctx.on('request', (r) => requests.push(r.url()));
  await ctx.addCookies([{ name: 'twid', value: `u%3D${viewer.id}`, domain: '.x.com', path: '/', secure: true }]);
  await ctx.route(/^https:\/\/(?:[a-z0-9-]+\.)*x\.com\//, async (route) => {
    const url = new URL(route.request().url());
    const api = /^\/i\/api\/graphql\/[^/]+\/[A-Za-z]+$/.test(url.pathname);
    if (api) {
      const key = JSON.parse(url.searchParams.get('variables') ?? '{}').page;
      const posts = pages.get(key) ?? [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { list: posts.map(tweetJson) } }) });
    }
    const key = url.pathname + url.search;
    const kind = kindOf(url.pathname);
    if (url.hostname !== 'x.com' || !kind || !pages.has(key)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: html(key, kind, pages.get(key)) });
  });

  return {
    requests,
    set: (path, posts) => pages.set(path, posts),
    // Opens path in a tab and waits for the cells and Papieren's first pass.
    async open(path, page) {
      page ??= await ctx.newPage();
      await page.goto(`https://x.com${path}`);
      await page.waitForFunction(() => document.title === 'fake X ready');
      return page;
    },
    // Scrolling, as far as Papieren can tell: one more payload, then its cells.
    async append(page, posts) {
      const key = `more:${posts[0].id}`;
      pages.set(key, posts);
      await page.evaluate(async ({ key, cells, path }) => {
        const vars = encodeURIComponent(JSON.stringify({ page: key }));
        await (await fetch(path + vars, { headers: { authorization: 'Bearer fake' } })).text();
        const box = document.querySelector('[aria-label="Timeline"]');
        for (const c of cells) box.insertAdjacentHTML('beforeend', c);
      }, { key, cells: posts.map(cell), path: `/i/api/graphql/${QID}/${OPS.home}?variables=` });
    },
  };
}

// The placeholder state and label of one post's cell.
export const cellState = (page, id) => page.evaluate((tid) => {
  const a = document.querySelector(`a[href$="/status/${tid}"]`);
  const c = a?.closest('[data-testid="cellInnerDiv"]');
  return c ? { mark: c.dataset.papieren ?? null, label: c.dataset.papierenLabel ?? null } : null;
}, id);

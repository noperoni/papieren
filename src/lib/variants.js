// Everything specific to one X front-end, behind one adapter shape, plus the
// page rules that hold for both. Shared-lib pattern, see rules.js.
(() => {
  const HANDLE = '[A-Za-z0-9_]{1,15}';
  // Mobile x.com (Firefox for Android) writes absolute m.x.com links.
  const ORIGIN = '(?:https://(?:(?:m|mobile)\\.)?(?:x|twitter)\\.com)?';
  const PERMALINK = new RegExp(`^${ORIGIN}/(${HANDLE})/status/(\\d+)(?:[/?#]|$)`);
  const PROFILE = new RegExp(`^${ORIGIN}/(${HANDLE})/?$`);
  const FILTERED = [/^\/home$/, /^\/[^/]+\/status\/\d+/, /^\/search/];
  const CELL = '[data-testid="cellInnerDiv"]:has(article)';

  // "/ivan/status/123" (or the absolute form) -> { handle, tweetId }.
  function parsePermalink(href) {
    const m = PERMALINK.exec(href ?? '');
    return m ? { handle: m[1], tweetId: m[2] } : null;
  }

  const isFilteredPage = (pathname) => FILTERED.some((re) => re.test(pathname));
  const focalId = (pathname) => /^\/[^/]+\/status\/(\d+)/.exec(pathname)?.[1];

  const legacy = {
    id: 'legacy',
    fallbackQid: 'XRqGa7EeokUU5kppkh13EA',
    // The rebuilt app marks <html data-app-version>; the legacy one mounts #react-root.
    detect: (doc) => !doc.documentElement.hasAttribute('data-app-version') && !!doc.getElementById('react-root'),
    lookupUrl: (qid, handle) => `https://x.com/i/api/graphql/${encodeURIComponent(qid)}/AboutAccountQuery?variables=${
      encodeURIComponent(JSON.stringify({ screenName: handle }))}`,
    findCells(root) {
      return root.matches?.(CELL) ? [root] : [...root.querySelectorAll(CELL)];
    },
    // The cell a changed node sits in: a recycled cell changes from inside.
    cellOf: (node) => node.closest?.(CELL) ?? null,
    // Tweet id and handle from the permalink wrapping the post's <time>.
    // The reposter comes from socialContext's profile link; that slot also
    // carries other contexts ("X liked"), so content.js should prefer the
    // timeline payload's reposter where it has one.
    readPost(cell) {
      const link = [...cell.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector('time'));
      const post = parsePermalink(link?.getAttribute('href'));
      if (!post) return null;
      const context = cell.querySelector('[data-testid="socialContext"]')?.closest('a');
      const reposterHandle = PROFILE.exec(context?.getAttribute('href') ?? '')?.[1];
      return reposterHandle ? { ...post, reposterHandle } : post;
    },
  };

  // Spike T0 (2026-11-13, logged out): no data-testid and no <time>. Each post
  // is a <li> whose direct child is the post's clickable frame,
  // div[role=link][data-href="/handle/status/id"]; quoted posts nest the same
  // frame deeper, and the focal post of a conversation has none.
  const REBUILT_CELL = 'li:has(> [role="link"][data-href*="/status/"])';

  const rebuilt = {
    id: 'rebuilt',
    fallbackQid: '3M2SBIjPPDiTvMXkIWTx_w',
    detect: (doc) => doc.documentElement.hasAttribute('data-app-version'),
    // Unverified until an account of the maintainer's is on this app: the request
    // shape, and whether X demands x-client-transaction-id.
    lookupUrl: (qid, handle) => `https://api.x.com/graphql/${encodeURIComponent(qid)}/AboutAccountQuery?variables=${
      encodeURIComponent(JSON.stringify({ screenName: handle, __relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider: true }))}`,
    findCells(root) {
      return root.matches?.(REBUILT_CELL) ? [root] : [...root.querySelectorAll(REBUILT_CELL)];
    },
    cellOf: (node) => node.closest?.(REBUILT_CELL) ?? null,
    // ponytail: no reposter from the DOM, its markup needs a logged-in view.
    // A captured timeline payload still names it; the server-rendered first
    // screen is judged on the author alone, which can only show too much.
    readPost(cell) {
      return parsePermalink(cell.querySelector(':scope > [role="link"][data-href]')?.getAttribute('data-href'));
    },
  };

  const adapters = [legacy, rebuilt];
  const detect = (doc) => adapters.find((a) => a.detect(doc)) ?? null;

  const variants = { legacy, rebuilt, detect, parsePermalink, isFilteredPage, focalId };

  globalThis.Papieren ??= {};
  globalThis.Papieren.variants = variants;
  if (typeof module === 'object') module.exports = variants;
})();

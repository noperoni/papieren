// Everything specific to one X front-end, behind one adapter shape, plus the
// page rules that hold for both. Shared-lib pattern, see rules.js.
(() => {
  const HANDLE = '[A-Za-z0-9_]{1,15}';
  const PERMALINK = new RegExp(`^(?:https://(?:x|twitter)\\.com)?/(${HANDLE})/status/(\\d+)(?:[/?#]|$)`);
  const PROFILE = new RegExp(`^(?:https://(?:x|twitter)\\.com)?/(${HANDLE})/?$`);
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

  const adapters = [legacy];
  const detect = (doc) => adapters.find((a) => a.detect(doc)) ?? null;

  const variants = { legacy, detect, parsePermalink, isFilteredPage, focalId };

  globalThis.Papieren ??= {};
  globalThis.Papieren.variants = variants;
  if (typeof module === 'object') module.exports = variants;
})();

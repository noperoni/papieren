// Filter decision for one post. Pure: no DOM, no storage, no clock.
// Shared-lib pattern: loads as a classic content script, as a side-effect
// import in the module service worker, and through require() under node --test.
// The IIFE matters: classic content scripts share one global scope, so a
// top-level const in two libs would collide. Only the namespace escapes.
(() => {
  const SHOW = Object.freeze({ hide: false });
  const PENDING = 'pending';

  // AuthorState: { id?, handle, country: string | null | 'pending' }.
  // Any extra field (a confidence mark, say) is ignored: Req 8.5 keeps it
  // out of the verdict.
  function evaluate(post, ctx) {
    const { settings } = ctx;
    if (!ctx.filteredPage || ctx.isFocal || settings.paused) return SHOW;

    const isViewer = (a) => ctx.viewerId != null && a.id === ctx.viewerId;
    if (post.author && isViewer(post.author)) return SHOW;

    // The viewer as reposter is not a second author to judge: Req 2.4 would
    // otherwise depend on the viewer's own country being on an allowlist.
    const authors = [post.author, post.reposter].filter((a) => a && !isViewer(a));
    const listed = (country) => settings.countries.includes(country);
    const blocking = settings.mode === 'allow' ? (c) => !listed(c) : listed;

    let pending;
    for (const a of authors) {
      if (a.country === PENDING) {
        pending ??= a;
        continue;
      }
      const country = a.country ?? 'Unknown';
      if (blocking(country)) return { hide: true, why: 'match', handle: a.handle, country };
    }

    // Block mode shows pending authors; allow mode holds them as "checking"
    // only while lookups can still answer, and fails open once they cannot.
    if (pending && settings.mode === 'allow' && !ctx.lookupsStopped) {
      return { hide: true, why: 'checking', handle: pending.handle, country: PENDING };
    }
    return SHOW;
  }

  const rules = { evaluate };

  globalThis.Papieren ??= {};
  globalThis.Papieren.rules = rules;
  if (typeof module === 'object') module.exports = rules;
})();

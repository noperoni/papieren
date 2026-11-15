// Filter decision for one post. Pure: no DOM, no storage, no clock.
// Shared-lib pattern: loads as a classic content script, as a side-effect
// import in the module service worker, and through require() under node --test.
// The IIFE matters: classic content scripts share one global scope, so a
// top-level const in two libs would collide. Only the namespace escapes.
(() => {
  const signals = globalThis.Papieren?.signals ?? require('./signals.js');
  const SHOW = Object.freeze({ hide: false });

  // post: { author?, reposter?, facts? }, the Authors as AuthorStates (see
  // signals/country.js). The guards hold for every Signal (Req 2.4, 2.5); then
  // each active Signal judges by rank and the first Match hides. A Pending is
  // remembered and judging goes on, so a later Match beats a country still
  // being looked up; with none, the Pending holds the post as "checking".
  function evaluate(post, ctx) {
    const { settings } = ctx;
    if (!ctx.filteredPage || ctx.isFocal || settings.paused) return SHOW;

    const isViewer = (a) => ctx.viewerId != null && a.id === ctx.viewerId;
    if (post.author && isViewer(post.author)) return SHOW;

    // The viewer as reposter is not a second author to judge: Req 2.4 would
    // otherwise depend on the viewer's own country being on an allowlist.
    const judged = { ...post, authors: [post.author, post.reposter].filter((a) => a && !isViewer(a)) };

    let pending;
    for (const signal of signals.all()) {
      if (!signal.active(settings, ctx)) continue;
      const r = signal.judge(judged, ctx);
      if (!r) continue;
      if (r.pending !== undefined) pending ??= r.pending;
      else return { hide: true, why: 'match', ...r };
    }
    return pending === undefined ? SHOW : { hide: true, why: 'checking', handle: pending, country: 'pending' };
  }

  const rules = { evaluate };

  globalThis.Papieren ??= {};
  globalThis.Papieren.rules = rules;
  if (typeof module === 'object') module.exports = rules;
})();

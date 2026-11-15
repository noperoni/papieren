// The country filter as a Signal (packs design, signals/country.js): the
// Author loop rules.evaluate() used to hold, moved unchanged. The country
// comes from the cache through feed.authorState, so no facts hooks.
// Shared-lib pattern, see lib/rules.js.
(() => {
  const signals = globalThis.Papieren?.signals ?? require('../lib/signals.js');
  const PENDING = 'pending';

  // Also what content.js asks before spending lookups.
  const active = (settings) => settings.mode === 'allow' || settings.countries.length > 0;

  // post.authors: AuthorStates { id?, handle, country: string | null | 'pending' },
  // the viewer already left out. Any extra field is ignored: Req 8.5 keeps a
  // confidence mark out of the verdict.
  function judge(post, ctx) {
    const { settings } = ctx;
    const listed = (country) => settings.countries.includes(country);
    const blocking = settings.mode === 'allow' ? (c) => !listed(c) : listed;

    let pending;
    for (const a of post.authors) {
      if (a.country === PENDING) {
        pending ??= a;
        continue;
      }
      const country = a.country ?? 'Unknown';
      if (blocking(country)) return { handle: a.handle, rule: 'country', label: country, country };
    }

    // Block mode shows pending authors; allow mode holds them as "checking"
    // only while lookups can still answer, and fails open once they cannot.
    return pending && settings.mode === 'allow' && !ctx.lookupsStopped ? { pending: pending.handle } : null;
  }

  const country = { id: 'country', rank: 10, active, judge };
  signals.register(country);
  if (typeof module === 'object') module.exports = country;
})();

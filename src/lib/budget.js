// Lookup budget: one sliding 15-minute window for the whole browser.
// Pure functions over BudgetState; the caller supplies the clock and stores
// the returned state. Shared-lib pattern, see rules.js.
(() => {
  const WINDOW_MS = 15 * 60 * 1000;
  const GAP_MS = 2000;
  const INFLIGHT_MS = 30 * 1000;
  const MAX_CAP = 45;
  const LOW_REMAINING = 5;
  const MAX_FAILURES = 3;

  function initial() {
    return { grants: [], lastGrant: 0, inflight: {}, cooldownUntil: 0, failures: 0, stopped: false };
  }

  // Bad input falls to the safest cap, never above 45 (Req 3.1).
  const clampCap = (n) => Math.min(MAX_CAP, Math.max(1, Math.floor(n) || 1));

  // cfg is the Settings object (lookups, paused, budget). Returns the next
  // state and the permit. retryAt is null where no time will lift the refusal.
  function permit(state, handle, now, cfg) {
    const key = String(handle).toLowerCase();
    const s = {
      ...state,
      grants: state.grants.filter((t) => now - t < WINDOW_MS),
      inflight: Object.fromEntries(Object.entries(state.inflight).filter(([, t]) => now - t < INFLIGHT_MS)),
    };
    const refuse = (reason, retryAt = null) => ({ state: s, permit: { grant: false, reason, retryAt } });

    if (!cfg.lookups) return refuse('disabled');
    if (cfg.paused) return refuse('paused');
    if (s.stopped) return refuse('stopped');
    if (now < s.cooldownUntil) return refuse('cooldown', s.cooldownUntil);
    if (Object.hasOwn(s.inflight, key)) return refuse('inflight', s.inflight[key] + INFLIGHT_MS);
    if (now - s.lastGrant < GAP_MS) return refuse('gap', s.lastGrant + GAP_MS);
    if (s.grants.length >= clampCap(cfg.budget)) return refuse('budget', s.grants[0] + WINDOW_MS);

    s.grants.push(now);
    s.lastGrant = now;
    s.inflight[key] = now;
    return { state: s, permit: { grant: true } };
  }

  // X's reset (epoch s) wins, then retry-after (s), then 15 minutes. A time
  // already past (clock skew, stale header) falls back to 15 minutes too.
  function cooldownEnd(rl, now) {
    const at = Number.isFinite(rl.reset) ? rl.reset * 1000
      : Number.isFinite(rl.retryAfter) ? now + rl.retryAfter * 1000
      : 0;
    return at > now ? at : now + WINDOW_MS;
  }

  // result: { ok, status, rateLimit?: { remaining?, reset?, retryAfter? } }.
  // A rate limit is never a failure (Req 3.4, 7.1).
  function report(state, result, now) {
    const s = { ...state };
    const rl = result.rateLimit ?? {};
    if (result.ok) s.failures = 0;
    if (result.status === 429 || (Number.isFinite(rl.remaining) && rl.remaining <= LOW_REMAINING)) {
      s.cooldownUntil = Math.max(s.cooldownUntil, cooldownEnd(rl, now));
    } else if (!result.ok) {
      s.failures += 1;
      if (s.failures >= MAX_FAILURES) s.stopped = true;
    }
    return s;
  }

  const budget = { initial, permit, report };

  globalThis.Papieren ??= {};
  globalThis.Papieren.budget = budget;
  if (typeof module === 'object') module.exports = budget;
})();

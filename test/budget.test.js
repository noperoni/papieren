const test = require('node:test');
const assert = require('node:assert/strict');
const { initial, permit, report } = require('../src/lib/budget.js');

const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;
const ON = { lookups: true, paused: false, budget: 40 };

// Grants `n` lookups for distinct handles, `stepMs` apart, from `start`.
function grantMany(state, n, start, stepMs, cfg = ON) {
  let s = state;
  for (let i = 0; i < n; i++) {
    const r = permit(s, `user${i}`, start + i * stepMs, cfg);
    assert.equal(r.permit.grant, true, `grant ${i}`);
    s = r.state;
  }
  return s;
}

test('first lookup is granted and recorded', () => {
  const { state, permit: p } = permit(initial(), 'Ivan', T0, ON);
  assert.deepEqual(p, { grant: true });
  assert.deepEqual(state.grants, [T0]);
  assert.equal(state.lastGrant, T0);
  assert.deepEqual(state.inflight, { ivan: T0 });
});

test('the input state is never mutated', () => {
  const s0 = initial();
  const frozen = JSON.stringify(s0);
  const { state } = permit(s0, 'a', T0, ON);
  report(state, { ok: false, status: 500 }, T0);
  assert.equal(JSON.stringify(s0), frozen);
  assert.deepEqual(state.grants, [T0]);
});

test('switched off, paused and stopped refuse with no retry time (Req 3.9, 6.3, 7.1)', () => {
  assert.deepEqual(permit(initial(), 'a', T0, { ...ON, lookups: false }).permit,
    { grant: false, reason: 'disabled', retryAt: null });
  assert.deepEqual(permit(initial(), 'a', T0, { ...ON, paused: true }).permit,
    { grant: false, reason: 'paused', retryAt: null });
  assert.deepEqual(permit({ ...initial(), stopped: true }, 'a', T0, ON).permit,
    { grant: false, reason: 'stopped', retryAt: null });
});

test('consecutive grants are at least 2 s apart (Req 3.5)', () => {
  const s = permit(initial(), 'a', T0, ON).state;
  assert.deepEqual(permit(s, 'b', T0 + 1999, ON).permit, { grant: false, reason: 'gap', retryAt: T0 + 2000 });
  assert.equal(permit(s, 'b', T0 + 2000, ON).permit.grant, true);
});

test('the same handle is not granted twice within 30 s, case aside', () => {
  const s = permit(initial(), 'Ivan', T0, ON).state;
  assert.deepEqual(permit(s, 'IVAN', T0 + 29_999, ON).permit,
    { grant: false, reason: 'inflight', retryAt: T0 + 30_000 });
  assert.equal(permit(s, 'ivan', T0 + 30_000, ON).permit.grant, true);
});

test('inflight keys cannot collide with Object.prototype names', () => {
  assert.equal(permit(initial(), 'constructor', T0, ON).permit.grant, true);
});

test('the cap holds over a sliding 15-minute window (Req 3.1)', () => {
  const s = grantMany(initial(), 40, T0, 3000);
  const last = T0 + 39 * 3000;
  assert.deepEqual(permit(s, 'late', last + 3000, ON).permit,
    { grant: false, reason: 'budget', retryAt: T0 + 15 * MIN });
  // the first grant ages out at exactly 15 minutes, freeing one slot
  const { state, permit: p } = permit(s, 'late', T0 + 15 * MIN, ON);
  assert.equal(p.grant, true);
  assert.equal(state.grants.length, 40);
  assert.equal(permit(state, 'later', T0 + 15 * MIN + 2000, ON).permit.reason, 'budget');
});

test('the cap follows the setting and is clamped to 1..45', () => {
  const s3 = grantMany(initial(), 3, T0, 2000, { ...ON, budget: 3 });
  assert.equal(permit(s3, 'x', T0 + 6000, { ...ON, budget: 3 }).permit.reason, 'budget');

  const s45 = grantMany(initial(), 45, T0, 2000, { ...ON, budget: 100 });
  assert.equal(permit(s45, 'x', T0 + 90_000, { ...ON, budget: 100 }).permit.reason, 'budget');

  for (const bad of [0, -5, NaN, undefined, 'lots']) {
    const s1 = grantMany(initial(), 1, T0, 2000, { ...ON, budget: bad });
    assert.equal(permit(s1, 'x', T0 + 2000, { ...ON, budget: bad }).permit.reason, 'budget', String(bad));
  }
});

test('a 429 cools down until X reset, not counted as a failure (Req 3.4)', () => {
  const reset = (T0 + 7 * MIN) / 1000;
  const s = report({ ...initial(), failures: 2 }, { ok: false, status: 429, rateLimit: { reset } }, T0);
  assert.equal(s.cooldownUntil, T0 + 7 * MIN);
  assert.equal(s.failures, 2);
  assert.equal(s.stopped, false);
  assert.deepEqual(permit(s, 'a', T0 + 7 * MIN - 1, ON).permit,
    { grant: false, reason: 'cooldown', retryAt: T0 + 7 * MIN });
  assert.equal(permit(s, 'a', T0 + 7 * MIN, ON).permit.grant, true);
});

test('a 429 without reset uses retry-after, then the 15-minute default', () => {
  assert.equal(report(initial(), { ok: false, status: 429, rateLimit: { retryAfter: 90 } }, T0).cooldownUntil, T0 + 90_000);
  assert.equal(report(initial(), { ok: false, status: 429, rateLimit: {} }, T0).cooldownUntil, T0 + 15 * MIN);
  assert.equal(report(initial(), { ok: false, status: 429 }, T0).cooldownUntil, T0 + 15 * MIN);
  const stale = (T0 - MIN) / 1000;
  assert.equal(report(initial(), { ok: false, status: 429, rateLimit: { reset: stale } }, T0).cooldownUntil, T0 + 15 * MIN);
});

test('remaining <= 5 on a success cools down and still resets failures', () => {
  const reset = (T0 + 4 * MIN) / 1000;
  const low = report({ ...initial(), failures: 2 }, { ok: true, status: 200, rateLimit: { remaining: 5, reset } }, T0);
  assert.equal(low.cooldownUntil, T0 + 4 * MIN);
  assert.equal(low.failures, 0);
  const fine = report(initial(), { ok: true, status: 200, rateLimit: { remaining: 6, reset } }, T0);
  assert.equal(fine.cooldownUntil, 0);
});

test('a later, shorter rate limit never shortens a cooldown', () => {
  const s = report(initial(), { ok: false, status: 429 }, T0);
  const again = report(s, { ok: false, status: 429, rateLimit: { retryAfter: 10 } }, T0 + 1000);
  assert.equal(again.cooldownUntil, T0 + 15 * MIN);
});

test('3 consecutive non-rate-limit failures stop lookups (Req 7.1)', () => {
  let s = initial();
  s = report(s, { ok: false, status: 401 }, T0);
  s = report(s, { ok: false, status: 403 }, T0);
  assert.equal(s.stopped, false);
  s = report(s, { ok: false, status: 200 }, T0);
  assert.equal(s.stopped, true);
  assert.equal(permit(s, 'a', T0 + 60 * MIN, ON).permit.reason, 'stopped');
});

test('a success between failures resets the count', () => {
  let s = initial();
  s = report(s, { ok: false, status: 401 }, T0);
  s = report(s, { ok: false, status: 401 }, T0);
  s = report(s, { ok: true, status: 200 }, T0);
  s = report(s, { ok: false, status: 401 }, T0);
  s = report(s, { ok: false, status: 401 }, T0);
  assert.equal(s.failures, 2);
  assert.equal(s.stopped, false);
});

test('refusal order: disabled, paused, stopped, cooldown, inflight, gap, budget', () => {
  const busy = { grants: Array(45).fill(T0), lastGrant: T0, inflight: { a: T0 }, cooldownUntil: T0 + MIN, failures: 3, stopped: true };
  const reasons = [
    [{ ...ON, lookups: false }, busy, 'disabled'],
    [{ ...ON, paused: true }, busy, 'paused'],
    [ON, busy, 'stopped'],
    [ON, { ...busy, stopped: false }, 'cooldown'],
    [ON, { ...busy, stopped: false, cooldownUntil: 0 }, 'inflight'],
    [ON, { ...busy, stopped: false, cooldownUntil: 0, inflight: {} }, 'gap'],
  ];
  for (const [cfg, state, reason] of reasons) {
    assert.equal(permit(state, 'a', T0 + 1, cfg).permit.reason, reason);
  }
  const capped = { ...initial(), grants: Array(40).fill(T0), lastGrant: T0 };
  assert.equal(permit(capped, 'a', T0 + 2000, ON).permit.reason, 'budget');
});

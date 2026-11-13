// Settings defaults, normalisation and import validation (Req 3.1, 3.6, 6.4).
// Shared-lib pattern, see rules.js.
(() => {
  const MODES = ['block', 'allow'];
  const PLACEHOLDERS = ['line', 'remove'];
  const MAX_COUNTRIES = 300;
  const MAX_NAME = 64;
  const MAX_BUDGET = 45;

  const DEFAULTS = Object.freeze({
    v: 1, mode: 'block', countries: Object.freeze([]), placeholder: 'line',
    paused: false, lookups: false, budget: 40,
  });

  const clampBudget = (n) => (Number.isFinite(n)
    ? Math.min(MAX_BUDGET, Math.max(1, Math.floor(n)))
    : DEFAULTS.budget);

  const validName = (c) => typeof c === 'string' && c.trim().length >= 1 && c.trim().length <= MAX_NAME;
  const dedupe = (list) => [...new Set(list.map((c) => c.trim()))];

  // Lenient: whatever is stored comes back as valid settings, bad fields
  // replaced by defaults. Lookups stay off unless explicitly true (Req 3.6).
  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      v: 1,
      mode: MODES.includes(r.mode) ? r.mode : DEFAULTS.mode,
      countries: Array.isArray(r.countries) ? dedupe(r.countries.filter(validName)).slice(0, MAX_COUNTRIES) : [],
      placeholder: PLACEHOLDERS.includes(r.placeholder) ? r.placeholder : DEFAULTS.placeholder,
      paused: r.paused === true,
      lookups: r.lookups === true,
      budget: clampBudget(r.budget),
    };
  }

  // Strict: a file that fails any check is rejected whole, with the reason
  // for the popup. Out-of-range budgets are clamped and duplicates dropped,
  // since neither changes what the file meant. An import never switches
  // lookups on: that takes the popup's risk confirmation (Req 3.7).
  function parseImport(text, current) {
    const reject = (reason) => ({ ok: false, reason });
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return reject('The file is not valid JSON.');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject('The file is not a Papieren settings object.');
    if (raw.v !== 1) return reject('Unknown settings version.');
    if (!MODES.includes(raw.mode)) return reject('mode must be "block" or "allow".');
    if (!Array.isArray(raw.countries) || !raw.countries.every(validName)) {
      return reject(`countries must be a list of names, 1 to ${MAX_NAME} characters each.`);
    }
    if (dedupe(raw.countries).length > MAX_COUNTRIES) return reject(`More than ${MAX_COUNTRIES} countries.`);
    if ('placeholder' in raw && !PLACEHOLDERS.includes(raw.placeholder)) return reject('placeholder must be "line" or "remove".');
    if ('paused' in raw && typeof raw.paused !== 'boolean') return reject('paused must be true or false.');
    if ('budget' in raw && !Number.isFinite(raw.budget)) return reject('budget must be a number.');
    return { ok: true, settings: normalize({ ...raw, lookups: normalize(current).lookups }) };
  }

  const settings = { DEFAULTS, normalize, parseImport };

  globalThis.Papieren ??= {};
  globalThis.Papieren.settings = settings;
  if (typeof module === 'object') module.exports = settings;
})();

// Settings defaults, normalisation and import validation (Req 3.1, 3.6, 6.4).
// Shared-lib pattern, see rules.js.
(() => {
  const MODES = ['block', 'allow'];
  const PLACEHOLDERS = ['line', 'remove'];
  const MAX_COUNTRIES = 300;
  const MAX_NAME = 64;
  const MAX_BUDGET = 45;
  const MAX_KEEP = 365;
  const DETECTIONS = ['copy', 'everywhere', 'media', 'offender'];

  // Database block (database Req 1.1, 2.2, 3.5): everything off, Retention in days.
  const DB_DEFAULTS = Object.freeze({
    on: false, copy: false, everywhere: false, media: false, offender: false,
    keep: Object.freeze({ cache: 30, memory: 3, history: 7, stats: 90 }),
  });

  const DEFAULTS = Object.freeze({
    v: 1, mode: 'block', countries: Object.freeze([]), placeholder: 'line',
    paused: false, lookups: false, budget: 40, db: DB_DEFAULTS,
  });

  const clamp = (n, min, max, fallback) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback);
  const clampBudget = (n) => clamp(n, 1, MAX_BUDGET, DEFAULTS.budget);
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  function normalizeDb(raw) {
    const r = isObject(raw) ? raw : {};
    const k = isObject(r.keep) ? r.keep : {};
    const keep = {};
    for (const [kind, days] of Object.entries(DB_DEFAULTS.keep)) keep[kind] = clamp(k[kind], 1, MAX_KEEP, days);
    const db = { on: r.on === true };
    for (const d of DETECTIONS) db[d] = r[d] === true;
    return { ...db, keep };
  }

  // Strict check of an imported db block; null when it is acceptable.
  function dbProblem(raw) {
    if (!isObject(raw)) return 'db must be an object.';
    for (const d of ['on', ...DETECTIONS]) if (d in raw && typeof raw[d] !== 'boolean') return `db.${d} must be true or false.`;
    if (!('keep' in raw)) return null;
    if (!isObject(raw.keep)) return 'db.keep must be an object.';
    for (const kind of Object.keys(DB_DEFAULTS.keep)) {
      const n = raw.keep[kind];
      if (kind in raw.keep && !(Number.isInteger(n) && n >= 1 && n <= MAX_KEEP)) return `db.keep.${kind} must be a whole number of days, 1 to ${MAX_KEEP}.`;
    }
    return null;
  }

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
      db: normalizeDb(r.db),
    };
  }

  // Strict: a file that fails any check is rejected whole, with the reason
  // for the popup. Out-of-range budgets are clamped and duplicates dropped,
  // since neither changes what the file meant. An import never switches
  // lookups on: that takes the popup's risk confirmation (Req 3.7). Nor does
  // it touch db.on: switching the database off would delete records without
  // the export offer (database Req 1.4). A file without db keeps the current block.
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
    const problem = 'db' in raw ? dbProblem(raw.db) : null;
    if (problem) return reject(problem);
    const cur = normalize(current);
    const db = 'db' in raw ? { ...raw.db, on: cur.db.on } : cur.db;
    return { ok: true, settings: normalize({ ...raw, lookups: cur.lookups, db }) };
  }

  const settings = { DEFAULTS, DETECTIONS, normalize, parseImport };

  globalThis.Papieren ??= {};
  globalThis.Papieren.settings = settings;
  if (typeof module === 'object') module.exports = settings;
})();

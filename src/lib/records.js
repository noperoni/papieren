// The database's pure arithmetic (database design, lib/records.js): flag
// counts from stored rows, Retention cut-offs, the size-cap share, and the
// export file contents. Used by the worker and the popup. Shared-lib pattern,
// see rules.js; load memory.js first (manifest, popup and worker order).
(() => {
  const memory = globalThis.Papieren?.memory ?? require('./memory.js');

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MB = 1024 * 1024;
  const CAP = 100 * MB;           // Req 2.5
  const TARGET = 90 * MB;
  const KINDS = ['cache', 'memory', 'history', 'stats'];

  // Stored memory kind -> the detection whose flag it feeds.
  const DETECTION = { copy: 'copy', conv: 'everywhere', media: 'media', offence: 'offender' };

  // Local date, YYYY-MM-DD: the day a Hidden_History or Rule_Statistics row belongs to.
  const dayOf = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // The flag one key earns from its stored rows, or null under threshold.
  // rows: copy and media rows of one [kind, key]; conv and offence rows of one author.
  function flagFor(kind, rows, now) {
    const det = DETECTION[kind];
    const live = kind === 'conv' ? rows.filter((r) => now - r.t <= memory.EVERYWHERE_MS) : rows;
    const counted = kind === 'conv' || kind === 'offence' ? (r) => r.key : (r) => r.author;
    const n = new Set(live.map(counted)).size;
    if (n < memory.THRESHOLDS[det]) return null;
    if (kind !== 'media') return { n };
    let first;
    for (const r of live) if (memory.earlier(r.tweet, first)) first = r.tweet;
    return { n, first };
  }

  // A row is deleted once it is older than its Record_Kind's Retention:
  // t (or, for statistics, the day) strictly before the cut-off (Req 2.3).
  function cutoffs(keep, now) {
    const before = (days) => now - days * DAY_MS;
    return { cache: before(keep.cache), memory: before(keep.memory), history: before(keep.history), stats: dayOf(before(keep.stats)) };
  }

  // Share of the oldest history and memory rows to delete (Req 2.5). One
  // round per sweep: the estimate lags deletions, so a loop could overshoot.
  const capShare = (usage) => (usage > CAP ? (usage - TARGET) / usage : 0);

  const cacheRows = (all) => Object.entries(all ?? {})
    .filter(([k]) => k.startsWith('c:'))
    .map(([k, e]) => ({ handle: k.slice(2), ...e }));

  // One JSON file with every Record_Kind (Req 5.1, 5.3).
  function toJson({ version, now, keep, cache, memory: mem, history, stats }) {
    return { papieren: version, exported: new Date(now).toISOString(), retention: { ...keep }, cache, memory: mem, history, stats };
  }

  const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : '');

  // CSV columns per Record_Kind: [header, row -> value].
  const COLUMNS = {
    cache: [['handle', (r) => r.handle], ['country', (r) => r.c], ['accurate', (r) => r.a], ['via', (r) => r.s],
      ['created', (r) => r.cc], ['confidence', (r) => r.k], ['time', (r) => iso(r.t)], ['id', (r) => r.id]],
    memory: [['kind', (r) => r.kind], ['key', (r) => r.key], ['author', (r) => r.author], ['handle', (r) => r.handle],
      ['tweet', (r) => r.tweet], ['rule', (r) => r.rule], ['time', (r) => iso(r.t)]],
    history: [['day', (r) => r.day], ['tweet', (r) => r.tweet], ['handle', (r) => r.handle], ['page', (r) => r.page],
      ['rule', (r) => r.rule], ['revealed', (r) => r.revealed], ['time', (r) => iso(r.t)]],
    stats: [['day', (r) => r.day], ['rule', (r) => r.rule], ['judged', (r) => r.judged], ['hid', (r) => r.hid]],
  };

  // Quoted when it holds a comma, quote or line break. A text cell that a
  // spreadsheet would read as a formula gets a leading apostrophe: no field
  // is free text, but a country name comes from X.
  function cell(v) {
    if (v === undefined || v === null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // One Record_Kind as CSV with a header row, and the export's date, version
  // and Retention as three constant trailing columns (Req 5.2, 5.3).
  function toCsv(kind, rows, { version, now, keep }) {
    const cols = COLUMNS[kind];
    const tail = [new Date(now).toISOString(), version, keep[kind]].map(cell);
    const header = [...cols.map(([h]) => h), 'exported', 'version', 'retention_days'].join(',');
    const lines = rows.map((r) => [...cols.map(([, get]) => cell(get(r))), ...tail].join(','));
    return `${[header, ...lines].join('\n')}\n`;
  }

  const fileName = (kind, now) => (kind === 'all' ? `papieren-database-${dayOf(now)}.json` : `papieren-${kind}-${dayOf(now)}.csv`);

  const records = { DAY_MS, CAP, TARGET, KINDS, DETECTION, dayOf, flagFor, cutoffs, capShare, cacheRows, toJson, toCsv, fileName };

  globalThis.Papieren ??= {};
  globalThis.Papieren.records = records;
  if (typeof module === 'object') module.exports = records;
})();

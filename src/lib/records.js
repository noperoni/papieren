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

  const { dayOf } = memory;

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

  // --- db-flush intake: the message comes from a tab, so every row is checked ---

  const FLUSH_MAX = 2000;          // rows per list, the tab's buffer cap (Req 7.4)
  const KEY_OF = { copy: 'fp', conv: 'conv', media: 'media', offence: 'tweet' };
  const PAGES = ['home', 'status', 'search'];
  const NOT_OFFENCES = ['country', 'bm:offender'];
  const matches = (re) => (v) => typeof v === 'string' && re.test(v);
  const isId = matches(/^\w{1,64}$/);         // ids, fingerprints
  const isHandle = matches(/^\w{1,50}$/);
  const isRule = matches(/^[\w:.-]{1,64}$/);  // country, bm:<detection>, later pack:<id>
  const isDay = matches(/^\d{4}-\d{2}-\d{2}$/);
  const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  const list = (v) => (Array.isArray(v) ? v.slice(0, FLUSH_MAX) : []);

  // A flushed sighting as a stored memory row, fields in the design's order, or null.
  function memoryRow(m) {
    const field = Object.hasOwn(KEY_OF, m?.kind) ? KEY_OF[m.kind] : null;
    if (!field || !isId(m[field]) || !isId(m.author) || !isHandle(m.handle) || !Number.isFinite(m.t)) return null;
    const row = { kind: m.kind, key: m[field], author: m.author, handle: m.handle };
    if (m.kind === 'media' || m.kind === 'offence') {
      if (!isId(m.tweet)) return null;
      row.tweet = m.tweet;
    }
    if (m.kind === 'offence') {
      // A Repeat_Offender counts neither country hides nor its own (Glossary).
      if (!isRule(m.rule) || NOT_OFFENCES.includes(m.rule)) return null;
      row.rule = m.rule;
    }
    row.t = m.t;
    return row;
  }

  // Two sightings of one memory key as the one row kept: the newer wins, and
  // a media row keeps the earlier tweet, so the earliest post survives
  // (design, IndexedDB). old is undefined for a new key.
  function keepRow(old, r) {
    if (!old) return r;
    const kept = r.t >= old.t ? r : old;
    return r.kind === 'media' ? { ...kept, tweet: memory.earlier(old.tweet, r.tweet) ? old.tweet : r.tweet } : kept;
  }

  // A db-flush message as stored rows, malformed ones dropped. One row per
  // memory key and per history tweet, so a transaction never writes one key twice.
  function parseFlush(msg, now) {
    const day = isDay(msg?.day) ? msg.day : dayOf(now);
    const mem = new Map();
    for (const r of list(msg?.memory).map(memoryRow)) {
      if (!r) continue;
      const id = `${r.kind} ${r.key} ${r.author}`;
      mem.set(id, keepRow(mem.get(id), r));
    }
    const history = new Map();
    for (const h of list(msg?.history)) {
      if (!isId(h?.tweet) || !isHandle(h.handle) || !PAGES.includes(h.page) || !isRule(h.rule) || !Number.isFinite(h.t)) continue;
      if (!history.has(h.tweet)) history.set(h.tweet, { day, tweet: h.tweet, handle: h.handle, page: h.page, rule: h.rule, revealed: false, t: h.t });
    }
    const stats = [];
    const raw = msg?.stats && typeof msg.stats === 'object' ? msg.stats : {};
    for (const [rule, s] of Object.entries(raw)) {
      const judged = count(s?.judged);
      const hid = count(s?.hid);
      if (isRule(rule) && (judged || hid)) stats.push({ rule, judged, hid });
    }
    return { day, memory: [...mem.values()], history: [...history.values()], revealed: [...new Set(list(msg?.revealed).filter(isId))], stats };
  }

  // Flags are keyed by the key for copy and media, by the author for conv and offence.
  const flagKey = (r) => (r.kind === 'conv' || r.kind === 'offence' ? r.author : r.key);

  // The distinct [kind, flag key] pairs a batch of memory rows touches.
  function flagKeys(rows) {
    const out = new Map();
    for (const r of rows) out.set(`${r.kind} ${flagKey(r)}`, { kind: r.kind, key: flagKey(r) });
    return [...out.values()];
  }

  // Where flagFor's rows live: the memory index and inclusive key bounds.
  // conv reads the author's last 24 h; offence everything Retention left.
  function flagRange(kind, key, now) {
    if (kind === 'conv' || kind === 'offence') {
      return { index: 'author', lower: [kind, key, kind === 'conv' ? now - memory.EVERYWHERE_MS : -Infinity], upper: [kind, key, Infinity] };
    }
    return { index: 'key', lower: [kind, key], upper: [kind, key] };
  }

  // flags rows { kind, key, n, first? } in memory.js's Flags shape. n 0
  // stands for a deleted flag: memory.merge drops a falsy value.
  function toFlags(rows) {
    const out = memory.emptyFlags();
    for (const r of rows) {
      if (!Object.hasOwn(DETECTION, r?.kind)) continue;
      out[DETECTION[r.kind]][r.key] = r.kind === 'media' && r.n ? { n: r.n, first: r.first } : r.n;
    }
    return out;
  }

  // The history row a reveal marks: the day's, else the latest (Req 4.3).
  const revealTarget = (rows, day) => rows.find((r) => r.day === day) ?? rows.reduce((a, r) => (!a || r.t > a.t ? r : a), undefined);

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

  const records = {
    DAY_MS, CAP, TARGET, KINDS, DETECTION, dayOf, flagFor, cutoffs, capShare,
    keepRow, parseFlush, flagKeys, flagRange, toFlags, revealTarget, cacheRows, toJson, toCsv, fileName,
  };

  globalThis.Papieren ??= {};
  globalThis.Papieren.records = records;
  if (typeof module === 'object') module.exports = records;
})();

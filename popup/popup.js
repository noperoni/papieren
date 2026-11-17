// Popup: settings, the lookups switch, status and per-country counts
// (Req 3.6, 3.7, 5.4, 6.1-6.4, 7.1, 8.4), the Packs section (packs design,
// Popup) and the Database section (database design, Popup). The pure helpers are exported for node --test; the DOM
// wiring below them runs only in the popup.
(() => {
  const records = globalThis.Papieren?.records ?? require('../src/lib/records.js');
  const packsLib = globalThis.Papieren?.packs ?? require('../src/lib/packs.js');
  const MAX_IMPORT_BYTES = 100_000;
  const KINDS = { junk: 'Junk', topic: 'Topic' };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // Behaviour rules as the counts table names them, in the settings' order.
  const DETECTION_NAMES = {
    'bm:copy': 'Copy-paste reply',
    'bm:everywhere': 'Replies everywhere',
    'bm:media': 'Recycled media',
    'bm:offender': 'Repeat offender',
  };

  // Countries named by cached authors, so X's own spellings reach the picker.
  function seenCountries(all) {
    const out = new Set();
    for (const [k, v] of Object.entries(all ?? {})) {
      if (k.startsWith('c:') && typeof v?.c === 'string' && v.c) out.add(v.c);
    }
    return [...out];
  }

  // Ticked countries first, then the rest, each in picker order. A stored
  // country missing from the list (say, from an import) is kept so it can be
  // unticked. The query narrows both by case-insensitive substring.
  function visibleCountries(list, selected, query = '') {
    const q = query.trim().toLowerCase();
    const ticked = new Set(selected);
    const pool = [...list, ...selected.filter((c) => !list.includes(c))]
      .filter((c) => !q || c.toLowerCase().includes(q));
    return [...pool.filter((c) => ticked.has(c)), ...pool.filter((c) => !ticked.has(c))];
  }

  // The content script's byCountry, most hidden first (Req 5.4, 8.4).
  function countRows(byCountry) {
    return Object.entries(byCountry ?? {})
      .map(([country, r]) => ({ country, n: r.n, confirmed: r.confirmed ?? 0, flagged: r.flagged ?? 0 }))
      .sort((a, b) => b.n - a.n || a.country.localeCompare(b.country, 'en'));
  }

  // The content script's byDetection, for the rows under the countries: each
  // detection that hid something, in a fixed order (database Req 6.2).
  function detectionRows(byDetection) {
    return Object.entries(DETECTION_NAMES)
      .map(([rule, name]) => ({ name, n: byDetection?.[rule] ?? 0 }))
      .filter((r) => r.n > 0);
  }

  // One row per Pack in list order, with the muted line Req 4.3 asks for. A
  // Pack_Copy names its built-in, or the built-in's id if a release dropped it.
  function packRows(list, on) {
    const names = new Map(list.map((p) => [p.id, p.name]));
    const enabled = new Set(on);
    return list.map((p) => {
      const bits = [KINDS[p.kind], p.description, `threshold ${p.threshold}`, plural(packsLib.tellCount(p), 'tell')];
      if (p.from) bits.push(`copy of ${names.get(p.from.id) ?? p.from.id} v${p.from.version}`);
      return { id: p.id, name: p.name, on: enabled.has(p.id), line: bits.join(' · ') };
    });
  }

  // Pack hides on this page, each under its Pack's name in list order, then
  // "Outside your packs" (Req 7.4). A Pack deleted since it hid keeps its id.
  function packCountRows(byRule, list) {
    const by = byRule ?? {};
    const named = list.map((p) => ({ name: p.name, n: by[`pack:${p.id}`] ?? 0 }));
    const known = new Set(list.map((p) => `pack:${p.id}`));
    const gone = Object.keys(by).filter((r) => r.startsWith('pack:') && !known.has(r)).map((r) => ({ name: r.slice(5), n: by[r] }));
    return [...named, ...gone, { name: 'Outside your packs', n: by['packs:outside'] ?? 0 }].filter((r) => r.n > 0);
  }

  // What the badge means, in words, most important first (Req 7.1). budget is
  // the worker's session state; stats is the tab's answer, or null off x.com;
  // dbError is the worker's reason the database failed (database Req 7.2).
  function statusLines({ settings, budget = {}, stats = null, dbError = null, now, time }) {
    if (settings.paused) return ['Paused: every post is shown and no lookups run.'];
    const lines = [];
    if (stats && stats.layout === null) lines.push('X layout not recognised on this tab: nothing is filtered here.');
    if (settings.mode === 'allow' && settings.countries.length === 0) {
      lines.push('Show-only mode with nothing ticked: every author with a known country is hidden.');
    }
    if (dbError) lines.push(`Database unavailable (${dbError}): running without it.`);
    if (!settings.lookups) lines.push('Lookups off: filtering uses countries already cached.');
    else if (budget.stopped) lines.push('Lookups stopped after 3 failed attempts. Pause and unpause to retry.');
    else if (budget.cooldownUntil > now) lines.push(`X rate limit: lookups resume at ${time(budget.cooldownUntil)}.`);
    return lines;
  }

  // One export as a file (database Req 5): kind 'all' is every Record_Kind as
  // JSON, any other kind that Record_Kind as CSV. data carries version, now,
  // keep, and the rows of each kind read.
  function dbFile(kind, data) {
    const name = records.fileName(kind, data.now);
    if (kind === 'all') return { name, type: 'application/json', text: `${JSON.stringify(records.toJson(data), null, 2)}\n` };
    return { name, type: 'text/csv', text: records.toCsv(kind, data[kind], data) };
  }

  // The settings export (Req 6.4), named by day like the database exports.
  const settingsFile = (settings, now) => ({
    name: `papieren-settings-${records.dayOf(now)}.json`,
    type: 'application/json',
    text: `${JSON.stringify(settings, null, 2)}\n`,
  });

  // What an import brought, in words. Lookups never come from a file
  // (Req 3.7), so the note says so; Packs the file names that are not here
  // stay off, and the note names them.
  function importNote(settings, dropped = []) {
    const what = `${settings.mode === 'block' ? 'hide' : 'show only'} ${plural(settings.countries.length, 'country', 'countries')}`;
    const left = dropped.length ? ` Not here, so left off: ${dropped.join(', ')}.` : '';
    return `Imported: ${what}, ${plural(settings.packs.on.length, 'pack')} on.${left} Lookups stay as they were.`;
  }

  const popup = { seenCountries, visibleCountries, countRows, detectionRows, packRows, packCountRows, statusLines, dbFile, settingsFile, importNote };
  if (typeof module === 'object') {
    module.exports = popup;
    return;
  }

  // --- DOM wiring ---

  const { settings: Settings, countries: Countries, db: Db, packs: Packs } = globalThis.Papieren;
  const STORES = ['memory', 'history', 'stats'];
  const KIND_NAMES = { cache: 'country cache', memory: 'behaviour memory', history: 'hidden history', stats: 'statistics' };
  const $ = (id) => document.getElementById(id);
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let current;
  let picker = [];
  let packList = [];
  let budget = {};
  let stats = null;
  let dbError = null;

  const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  const note = (text) => { $('db-note').textContent = text; };
  const fileNote = (text) => { $('file-note').textContent = text; };
  const why = (error) => `database unavailable (${error})`;
  // A worker that is gone (extension reloaded) rejects; answer like a failure.
  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e?.message ?? e) }));

  // Every change is written at once; open tabs apply it through
  // storage.onChanged (Req 6.2). The worker clears dbError on any settings
  // change, so the popup forgets it too.
  async function save(patch) {
    current = Settings.normalize({ ...current, ...patch });
    dbError = null;
    await chrome.storage.local.set({ settings: current });
    render();
  }

  const saveDb = (patch) => save({ db: { ...current.db, ...patch } });

  // Rebuilt only on open, search and import, so ticking a box neither
  // reorders the list nor loses focus.
  function renderList() {
    const items = visibleCountries(picker, current.countries, $('search').value).map((c) => {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: c, checked: current.countries.includes(c) });
      const label = el('label', '');
      label.append(box, ` ${c === 'Unknown' ? 'Unknown (no country on X)' : c}`);
      return label;
    });
    $('countries').replaceChildren(...items);
  }

  // Pack names and descriptions come from files: textContent only. Rebuilt
  // on open and import, as the country list is.
  function renderPacks() {
    const rows = packRows(packList, current.packs.on).map((r) => {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: r.id, checked: r.on });
      box.setAttribute('aria-describedby', `pack-line-${r.id}`);
      const label = el('label', '');
      label.append(box, ` ${r.name}`);
      const row = document.createElement('div');
      row.append(label, Object.assign(el('p', r.line), { id: `pack-line-${r.id}`, className: 'muted pack-line' }));
      return row;
    });
    $('packs').replaceChildren(...rows);
    $('packs').hidden = rows.length === 0;
    $('packs-note').textContent = rows.length ? '' : 'No packs here yet: the built-in packs arrive when Papieren is installed or updated.';
  }

  // Country names come from X: textContent only, never innerHTML. The Pack
  // rows follow the countries (packs Req 7.4), then the detections
  // (database Req 6.2).
  function renderCounts() {
    const rows = !stats ? [] : [
      ...countRows(stats.byCountry).map((r) => [r.country, r.n,
        [r.confirmed && `${r.confirmed} confirmed`, r.flagged && `${r.flagged} flagged`].filter(Boolean).join(', ')]),
      ...packCountRows(stats.byRule, packList).map((r) => [r.name, r.n, '']),
      ...detectionRows(stats.byRule).map((r) => [r.name, r.n, '']),
    ];
    $('counts').tBodies[0].replaceChildren(...rows.map((cells) => {
      const tr = document.createElement('tr');
      tr.append(...cells.map((c) => el('td', String(c))));
      return tr;
    }));
    $('counts').hidden = rows.length === 0;
    $('counts-note').textContent = !stats ? 'Open an x.com tab to see what it hides.' : rows.length ? '' : 'Nothing hidden on this page.';
  }

  function render() {
    for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === current.mode;
    for (const r of document.querySelectorAll('input[name="placeholder"]')) r.checked = r.value === current.placeholder;
    for (const r of document.querySelectorAll('input[name="pack-mode"]')) r.checked = r.value === current.packs.mode;
    for (const box of $('packs').querySelectorAll('input')) box.checked = current.packs.on.includes(box.value);
    $('paused').checked = current.paused;
    $('lookups').checked = current.lookups;
    $('budget').value = String(current.budget);
    $('ticked').textContent = `${current.countries.length} ticked`;
    for (const box of $('db-detections').querySelectorAll('input')) box.checked = current.db[box.value];
    for (const input of $('db-keep').querySelectorAll('input')) input.value = String(current.db.keep[input.dataset.kind]);
    $('status').replaceChildren(...statusLines({ settings: current, budget, stats, dbError, now: Date.now(), time }).map((t) => el('p', t)));
    renderCounts();
  }

  async function importFile() {
    const file = $('import').files[0];
    $('import').value = '';
    if (!file) return;
    const out = file.size > MAX_IMPORT_BYTES
      ? { ok: false, reason: 'The file is too large to be Papieren settings.' }
      : Settings.parseImport(await file.text(), current, packList.map((p) => p.id));
    if (!out.ok) {
      fileNote(`Not imported: ${out.reason}`);
      return;
    }
    current = out.settings;
    await chrome.storage.local.set({ settings: current });
    fileNote(importNote(current, out.dropped));
    renderList();
    renderPacks();
    render();
  }

  // The object URL dies with the popup, so it is never revoked by hand.
  function download(name, type, text) {
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name }).click();
  }

  function exportFile() {
    const file = settingsFile(current, Date.now());
    download(file.name, file.type, file.text);
    fileNote(`Exported ${file.name}.`);
  }

  // Every row of the named IndexedDB stores, in one read-only transaction.
  async function readStores(stores) {
    const out = Object.fromEntries(stores.map((s) => [s, []]));
    if (stores.length) {
      await Db.tx(stores, 'readonly', (t) => Promise.all(stores.map((s) => Db.each(t, s, null, null, (v) => { out[s].push(v); }))));
    }
    return out;
  }

  // The worker sweeps first, so no record past its Retention reaches a file
  // (design, Sweep); a failed sweep exports nothing. The popup reads the
  // rows itself and saves through <a download>, as the settings export does.
  // Exports run one after another.
  let exporting = Promise.resolve();
  const exportDb = (kind) => (exporting = exporting.then(() => exportNow(kind)));

  async function exportNow(kind) {
    const swept = await send({ type: 'db-sweep' });
    if (swept?.error) return note(`Not exported: ${why(swept.error)}.`);
    try {
      const data = { version: chrome.runtime.getManifest().version, now: Date.now(), keep: current.db.keep };
      if (kind === 'all' || kind === 'cache') data.cache = records.cacheRows(await chrome.storage.local.get(null));
      Object.assign(data, await readStores(kind === 'all' ? STORES : STORES.filter((s) => s === kind)));
      const file = dbFile(kind, data);
      download(file.name, file.type, file.text);
      note(`Exported ${file.name}.`);
    } catch (e) {
      note(`Not exported: ${e?.message ?? e}.`);
    }
  }

  function disarm(button) {
    delete button.dataset.armed;
    button.textContent = 'Delete all';
  }

  // "Delete all" for one Record_Kind (database Req 2.4).
  async function clearKind(kind) {
    const r = await send({ type: 'db-clear', kind });
    note(r?.error ? `Not deleted: ${why(r.error)}.` : `Deleted the whole ${KIND_NAMES[kind]}.`);
  }

  function wire() {
    for (const name of ['mode', 'placeholder']) {
      for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
        r.addEventListener('change', () => save({ [name]: r.value }));
      }
    }
    $('paused').addEventListener('change', (e) => save({ paused: e.target.checked }));
    $('budget').addEventListener('change', (e) => save({ budget: Number(e.target.value) }));
    $('search').addEventListener('input', renderList);
    $('countries').addEventListener('change', (e) => {
      const set = new Set(current.countries);
      if (e.target.checked) set.add(e.target.value);
      else set.delete(e.target.value);
      save({ countries: [...set] });
    });

    for (const r of document.querySelectorAll('input[name="pack-mode"]')) {
      r.addEventListener('change', () => save({ packs: { ...current.packs, mode: r.value } }));
    }
    $('packs').addEventListener('change', (e) => {
      const set = new Set(current.packs.on);
      if (e.target.checked) set.add(e.target.value);
      else set.delete(e.target.value);
      save({ packs: { ...current.packs, on: [...set] } });
    });
    // A tab of the extension's own: no permission needed (packs design, Popup).
    $('edit-packs').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup/packs.html') }));

    // Switching on only opens the warning; lookups start on the explicit
    // accept (Req 3.7). Switching off is immediate.
    $('lookups').addEventListener('change', (e) => {
      if (e.target.checked) {
        e.target.checked = false;
        $('risk').hidden = false;
        $('accept').focus();
      } else {
        $('risk').hidden = true;
        save({ lookups: false });
      }
    });
    $('accept').addEventListener('click', () => {
      $('risk').hidden = true;
      save({ lookups: true });
    });
    $('cancel').addEventListener('click', () => {
      $('risk').hidden = true;
      $('lookups').focus();
    });

    $('db-detections').addEventListener('change', (e) => saveDb({ [e.target.value]: e.target.checked }));
    // An empty or out-of-range field reverts instead of saving: normalize
    // would clamp it to 1 day, and the next sweep would take nearly everything.
    $('db-keep').addEventListener('change', (e) => {
      if (!e.target.validity.valid) return render();
      saveDb({ keep: { ...current.db.keep, [e.target.dataset.kind]: Number(e.target.value) } });
    });
    // "Delete all" asks twice: the first click arms the button, the second
    // deletes, and moving focus away disarms it.
    $('db-keep').addEventListener('click', (e) => {
      const b = e.target;
      if (!b.dataset.clear) return;
      if (!b.dataset.armed) {
        b.dataset.armed = 'yes';
        b.textContent = 'Click again to delete';
        return;
      }
      disarm(b);
      clearKind(b.dataset.clear);
    });
    $('db-keep').addEventListener('focusout', (e) => {
      if (e.target.dataset.armed) disarm(e.target);
    });
    $('db-export').addEventListener('click', () => exportDb('all'));
    $('db-csv').addEventListener('click', () => exportDb($('db-kind').value));

    $('export').addEventListener('click', exportFile);
    $('import-btn').addEventListener('click', () => $('import').click());
    $('import').addEventListener('change', importFile);
  }

  // ponytail: reads the whole cache to collect seen countries, like the
  // content script's boot; keep a seen-countries key if the popup gets slow.
  async function load() {
    const [all, session, [tab]] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.session.get(['budget', 'dbError']),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    current = Settings.normalize(all.settings);
    picker = Countries.pickerList(seenCountries(all));
    // The same list the content scripts filter with (signals/packs.js).
    packList = Packs.merge(all['packs:builtin'], all['packs:user']);
    budget = session.budget ?? {};
    dbError = session.dbError ?? null;
    // No content script on this tab (not x.com) rejects: no counts, no layout.
    stats = tab?.id === undefined ? null : await chrome.tabs.sendMessage(tab.id, { type: 'stats' }).catch(() => null);
    wire();
    renderList();
    renderPacks();
    render();
    // Popup open is one of the sweep's moments (design, Sweep).
    send({ type: 'db-sweep' }).then((r) => {
      if (!r?.error) return;
      dbError = r.error;
      render();
    });
  }

  load();
})();

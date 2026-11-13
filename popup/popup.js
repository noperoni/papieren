// Popup: settings, the lookups switch, status and per-country counts
// (Req 3.6, 3.7, 5.4, 6.1-6.4, 7.1, 8.4). The pure helpers are exported for
// node --test; the DOM wiring below them runs only in the popup.
(() => {
  const MAX_IMPORT_BYTES = 100_000;

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

  // What the badge means, in words, most important first (Req 7.1). budget is
  // the worker's session state; stats is the tab's answer, or null off x.com.
  function statusLines({ settings, budget = {}, stats = null, now, time }) {
    if (settings.paused) return ['Paused: every post is shown and no lookups run.'];
    const lines = [];
    if (stats && stats.layout === null) lines.push('X layout not recognised on this tab: nothing is filtered here.');
    if (settings.mode === 'allow' && settings.countries.length === 0) {
      lines.push('Show-only mode with nothing ticked: every author with a known country is hidden.');
    }
    if (!settings.lookups) lines.push('Lookups off: filtering uses countries already cached.');
    else if (budget.stopped) lines.push('Lookups stopped after 3 failed attempts. Pause and unpause to retry.');
    else if (budget.cooldownUntil > now) lines.push(`X rate limit: lookups resume at ${time(budget.cooldownUntil)}.`);
    return lines;
  }

  const popup = { seenCountries, visibleCountries, countRows, statusLines };
  if (typeof module === 'object') {
    module.exports = popup;
    return;
  }

  // --- DOM wiring ---

  const { settings: Settings, countries: Countries } = globalThis.Papieren;
  const $ = (id) => document.getElementById(id);
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let current;
  let picker = [];
  let budget = {};
  let stats = null;

  const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });

  // Every change is written at once; open tabs apply it through
  // storage.onChanged (Req 6.2).
  async function save(patch) {
    current = Settings.normalize({ ...current, ...patch });
    await chrome.storage.local.set({ settings: current });
    render();
  }

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

  // Country names come from X: textContent only, never innerHTML.
  function renderCounts() {
    const rows = stats ? countRows(stats.byCountry) : [];
    $('counts').tBodies[0].replaceChildren(...rows.map((r) => {
      const marks = [r.confirmed && `${r.confirmed} confirmed`, r.flagged && `${r.flagged} flagged`].filter(Boolean).join(', ');
      const tr = document.createElement('tr');
      tr.append(el('td', r.country), el('td', String(r.n)), el('td', marks));
      return tr;
    }));
    $('counts').hidden = rows.length === 0;
    $('counts-note').textContent = !stats ? 'Open an x.com tab to see what it hides.' : rows.length ? '' : 'Nothing hidden on this page.';
  }

  function render() {
    for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === current.mode;
    for (const r of document.querySelectorAll('input[name="placeholder"]')) r.checked = r.value === current.placeholder;
    $('paused').checked = current.paused;
    $('lookups').checked = current.lookups;
    $('budget').value = String(current.budget);
    $('ticked').textContent = `${current.countries.length} ticked`;
    $('status').replaceChildren(...statusLines({ settings: current, budget, stats, now: Date.now(), time }).map((t) => el('p', t)));
    renderCounts();
  }

  async function importFile() {
    const file = $('import').files[0];
    $('import').value = '';
    if (!file) return;
    const out = file.size > MAX_IMPORT_BYTES
      ? { ok: false, reason: 'The file is too large to be Papieren settings.' }
      : Settings.parseImport(await file.text(), current);
    if (!out.ok) {
      $('import-note').textContent = `Not imported: ${out.reason}`;
      return;
    }
    current = out.settings;
    await chrome.storage.local.set({ settings: current });
    $('import-note').textContent = 'Imported.';
    renderList();
    render();
  }

  // The object URL dies with the popup, so it is never revoked by hand.
  function exportFile() {
    const blob = new Blob([`${JSON.stringify(current, null, 2)}\n`], { type: 'application/json' });
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'papieren-settings.json' }).click();
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

    $('export').addEventListener('click', exportFile);
    $('import-btn').addEventListener('click', () => $('import').click());
    $('import').addEventListener('change', importFile);
  }

  // ponytail: reads the whole cache to collect seen countries, like the
  // content script's boot; keep a seen-countries key if the popup gets slow.
  async function load() {
    const [all, session, [tab]] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.session.get('budget'),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    current = Settings.normalize(all.settings);
    picker = Countries.pickerList(seenCountries(all));
    budget = session.budget ?? {};
    // No content script on this tab (not x.com) rejects: no counts, no layout.
    stats = tab?.id === undefined ? null : await chrome.tabs.sendMessage(tab.id, { type: 'stats' }).catch(() => null);
    wire();
    renderList();
    render();
  }

  load();
})();

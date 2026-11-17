// The Pack editor tab (packs design, Editor tab; Req 3.4, 5.1-5.5, 6.1-6.3):
// every stored Pack on the left, the selected one on the right. The pure
// helpers are exported for node --test; the DOM wiring below them runs only
// in the tab.
(() => {
  const lib = globalThis.Papieren?.packs ?? require('../src/lib/packs.js');
  const MAX_PACKS = 100;   // Req 5.5, as settings.js
  const ID_MAX = 40;
  const NAME_MAX = 40;
  const COPY = ' (copy)';
  const FULL = `Papieren holds at most ${MAX_PACKS} packs: delete one first.`;

  // Seeded into an empty Pack, so a new one shows how a line is written (Req 5.3).
  const EXAMPLE_ANY = [
    '# One tell per line: its weight, -10 to 10 but not 0, then what to look for.',
    '# A line starting with # is a note. Notes are not kept when you save.',
    '# These read every post, whatever its language:',
    '# 1 name: crypto',
    '# 1 bio: /\\bnft\\b/',
    '# 2 emoji >= 5',
    '# 1 caps >= 0.6',
    '# 1 media: link',
    '# 2 domain: example.com',
    '# -2 context: reply',
    '# -3 account: gold',
  ].join('\n');
  const EXAMPLE_TEXT = [
    '# Phrases and /patterns/, read only in posts written in this language:',
    '# 3 like if you agree',
    '# 2 /^rt if\\b/',
  ].join('\n');

  const cut = (s, n) => [...s].slice(0, n).join('');

  // A name -> an id the validator takes: lowercase letters, digits, hyphens.
  function slug(name) {
    const s = String(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, ID_MAX).replace(/-+$/, '');
    return s || 'pack';
  }

  // base, then base-2, base-3, ..., the first not taken, cut to 40 characters (Req 6.3).
  function uniqueId(base, taken) {
    const used = new Set(taken);
    for (let n = 1; ; n++) {
      const tail = n === 1 ? '' : `-${n}`;
      const id = `${base.slice(0, ID_MAX - tail.length).replace(/-+$/, '')}${tail}`;
      if (!used.has(id)) return id;
    }
  }

  // Every id in storage, an invalid Pack's too, so nothing new takes one.
  const takenIds = (entries) => entries.map((e) => e.pack?.id ?? e.raw?.id).filter((id) => typeof id === 'string');
  // '#' is never in an id, so an invalid Pack's key cannot meet a valid one's.
  const keyOf = (e) => (e.pack ? e.pack.id : `${e.builtin ? 'b' : 'u'}#${e.index}`);

  // The list on the left: one row per stored Pack, valid or not.
  function listRows(entries, on) {
    const enabled = new Set(on);
    return entries.map((e) => {
      const p = e.pack;
      const named = typeof e.raw?.name === 'string' && e.raw.name.trim() ? cut(e.raw.name.trim(), NAME_MAX) : 'Unnamed pack';
      return {
        key: keyOf(e),
        name: p?.name ?? named,
        tag: !p ? 'invalid' : e.builtin ? 'built-in' : p.from ? 'copy' : 'yours',
        on: !!p && enabled.has(p.id),
      };
    });
  }

  // The line under the selected Pack's name.
  function aboutLine(e, builtins) {
    if (!e) return 'Pick a pack on the left, or make a new one.';
    if (!e.pack) {
      const fix = e.builtin ? '' : ' Delete it, or fix its file and import it again.';
      return `Invalid: ${e.reason} It is left out of filtering.${fix}`;
    }
    if (e.builtin) return 'Built-in pack, read-only. Edit a copy to change it; a new Papieren version may replace this one.';
    const from = e.pack.from;
    if (!from) return 'Your own pack.';
    const b = builtins.find((x) => x.id === from.id);
    const what = `A copy of ${b?.name ?? from.id} v${from.version}.`;
    if (!b) return `${what} That built-in pack is no longer shipped.`;
    return b.version > from.version ? `${what} The built-in is now at v${b.version}; nothing is merged into this copy.` : what;
  }

  // A Pack -> the editor's fields, the Tells as lines.
  function formOf(pack) {
    const langs = Object.entries(pack.languages).map(([code, tells]) => [code, lib.toLines(tells)]);
    const empty = lib.tellCount(pack) === 0;
    if (empty) {
      if (langs.length) langs[0][1] = EXAMPLE_TEXT;
      else langs.push(['en', EXAMPLE_TEXT]);
    }
    return {
      name: pack.name, kind: pack.kind, description: pack.description, threshold: String(pack.threshold),
      any: empty ? EXAMPLE_ANY : lib.toLines(pack.tells), langs,
    };
  }

  // The fields over a stored Pack -> { ok, changed, pack }, the version
  // bumped when anything changed; or { ok: false, reason } naming the box
  // and line (Req 5.4). An empty language is dropped.
  function fromForm(form, base, builtinIds = []) {
    const fail = (reason) => ({ ok: false, reason });
    const any = lib.parseLines(form.any, 'any');
    if (!any.ok) return fail(`Any language, line ${any.line}: ${any.reason}.`);
    const languages = {};
    for (const [code, text] of form.langs) {
      if (!lib.isLang(code)) return fail(`"${code}" is not a language code like "en" or "pt-br".`);
      if (code in languages) return fail(`Language ${code} is there twice.`);
      const r = lib.parseLines(text, 'text');
      if (!r.ok) return fail(`Language ${code}, line ${r.line}: ${r.reason}.`);
      if (r.tells.length) languages[code] = r.tells;
    }
    const raw = {
      papierenPack: 1, id: base.id, name: form.name, kind: form.kind, description: form.description,
      version: base.version, threshold: Number(form.threshold), tells: any.tells, languages,
    };
    if (base.from) raw.from = base.from;
    const v = lib.validate(raw, { builtinIds });
    if (!v.ok) return v;
    const changed = JSON.stringify(v.pack) !== JSON.stringify(base);
    return { ok: true, changed, pack: changed ? { ...v.pack, version: base.version + 1 } : base };
  }

  // "Edit a copy" (Req 5.1): the built-in's Tells under a new id, recording
  // the built-in and version it came from.
  function copyOf(b, taken) {
    const name = `${cut(b.name, NAME_MAX - COPY.length).trim()}${COPY}`;
    return lib.validate({ ...b, id: uniqueId(slug(name), taken), name, version: 1, from: { id: b.id, version: b.version } }).pack;
  }

  // The copy takes the built-in's place in packs.on, if the built-in was on.
  const placeCopy = (on, from, id) => (on.includes(from) ? on.map((x) => (x === from ? id : x)) : on);

  // "New pack": a Custom_Pack from the template, with no Tells yet (Req 5.3).
  function newPack(taken) {
    const id = uniqueId('my-pack', taken);
    const name = id === 'my-pack' ? 'My pack' : `My pack ${id.slice('my-pack-'.length)}`;
    return lib.validate({
      papierenPack: 1, id, name, kind: 'junk', description: 'What this pack hides, in one line.',
      version: 1, threshold: 5, tells: [], languages: {},
    }).pack;
  }

  // An imported file (Req 6.2, 6.3): refused whole with the reason, or the
  // Pack with its id suffixed -2, -3 on a clash, a built-in's id included.
  function importPack(text, taken) {
    const r = lib.validate(text);
    return r.ok ? { ok: true, pack: { ...r.pack, id: uniqueId(r.pack.id, taken) } } : r;
  }

  // The Pack_Template format, as validate returns it (Req 6.1).
  const packFile = (pack) => ({
    name: `papieren-pack-${pack.id}.json`,
    type: 'application/json',
    text: `${JSON.stringify(pack, null, 2)}\n`,
  });

  const editor = {
    MAX_PACKS, EXAMPLE_ANY, EXAMPLE_TEXT,
    slug, uniqueId, takenIds, listRows, aboutLine, formOf, fromForm, copyOf, placeCopy, newPack, importPack, packFile,
  };
  if (typeof module === 'object') {
    module.exports = editor;
    return;
  }

  // --- DOM wiring ---

  const { settings: Settings } = globalThis.Papieren;
  const $ = (id) => document.getElementById(id);
  const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  const note = (text) => { $('note').textContent = text; };
  const leave = () => !dirty || confirm('Leave this pack? Your changes are not saved.');
  const why = (e) => e?.message ?? String(e);
  let languageName = (code) => code;
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    languageName = (code) => {
      const n = names.of(code);
      return n && n.toLowerCase() !== code ? `${n} (${code})` : code;
    };
  } catch {
    // No Intl.DisplayNames: the bare code.
  }

  let entries = [];
  let on = [];
  let selected = null;   // keyOf the selected entry
  let dirty = false;     // the fields differ from the stored Pack

  const current = () => entries.find((e) => keyOf(e) === selected);
  const builtins = () => entries.filter((e) => e.builtin && e.pack).map((e) => e.pack);

  async function load() {
    const got = await chrome.storage.local.get(['packs:builtin', 'packs:user', 'settings']);
    entries = lib.check(got['packs:builtin'], got['packs:user']);
    on = Settings.normalize(got.settings).packs.on;
    if (!current()) selected = entries[0] ? keyOf(entries[0]) : null;
  }

  // Every write re-reads packs:user and settings first, so a second editor
  // tab's change survives. A refused write (a full storage.local) throws and
  // changes nothing, so the old Pack stays (Error Handling).
  async function write(change, changeOn) {
    const got = await chrome.storage.local.get(['packs:user', 'settings']);
    const out = { 'packs:user': change(Array.isArray(got['packs:user']) ? [...got['packs:user']] : []) };
    if (changeOn) {
      const s = Settings.normalize(got.settings);
      out.settings = { ...s, packs: { ...s.packs, on: changeOn(s.packs.on) } };
    }
    await chrome.storage.local.set(out);
    await load();
  }

  // The stored index of entry e, checked against what is stored now.
  function indexIn(user, e) {
    const same = (p) => JSON.stringify(p) === JSON.stringify(e.pack ?? e.raw);
    if (e.pack) {
      const i = user.findIndex((p) => p?.id === e.pack.id && same(lib.validate(p).pack));
      if (i >= 0) return i;
    } else if (same(user[e.index])) {
      return e.index;
    }
    throw new Error('the pack changed in another tab; look again and retry');
  }

  function renderList() {
    $('list').replaceChildren(...listRows(entries, on).map((r) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: r.name });
      b.dataset.key = r.key;
      if (r.key === selected) b.setAttribute('aria-current', 'true');
      const li = document.createElement('li');
      li.append(b, Object.assign(el('span', [r.tag, r.on && 'on'].filter(Boolean).join(', ')), { className: 'muted' }));
      return li;
    }));
  }

  function langBox(code, text) {
    const label = el('label', languageName(code));
    const area = Object.assign(document.createElement('textarea'), { rows: 6, spellcheck: false, value: text });
    area.dataset.lang = code;
    label.append(area);
    return label;
  }

  function fill(f, readOnly) {
    $('name').value = f.name;
    $('kind').value = f.kind;
    $('description').value = f.description;
    $('threshold').value = f.threshold;
    $('any').value = f.any;
    $('langs').replaceChildren(...f.langs.map(([code, text]) => langBox(code, text)));
    for (const x of $('fields').querySelectorAll('input, textarea')) x.readOnly = readOnly;
    $('kind').disabled = readOnly;
    $('add-row').hidden = readOnly;
  }

  const readForm = () => ({
    name: $('name').value,
    kind: $('kind').value,
    description: $('description').value,
    threshold: $('threshold').value,
    any: $('any').value,
    langs: [...$('langs').querySelectorAll('textarea')].map((a) => [a.dataset.lang, a.value]),
  });

  function disarm() {
    delete $('delete').dataset.armed;
    $('delete').textContent = 'Delete';
  }

  function renderPane() {
    const e = current();
    $('h-pack').textContent = e ? (e.pack?.name ?? 'Invalid pack') : 'No pack';
    $('about').textContent = aboutLine(e, builtins());
    $('form').hidden = !e?.pack;
    $('save').hidden = !e?.pack || e.builtin;
    $('copy').hidden = !e?.pack || !e.builtin;
    $('export').hidden = !e?.pack;
    $('delete').hidden = !e || e.builtin;
    disarm();
    dirty = false;
    if (e?.pack) fill(formOf(e.pack), e.builtin);
  }

  function select(key) {
    if (key === selected || !leave()) return;
    selected = key;
    note('');
    renderList();
    renderPane();
  }

  // One write, then the list and the pane shown afresh with what it made.
  async function act(what, run) {
    try {
      const msg = await run();
      renderList();
      renderPane();
      note(msg);
    } catch (e) {
      note(`Not ${what}: ${why(e)}.`);
    }
  }

  async function save() {
    const e = current();
    if (!e?.pack || e.builtin) return;
    const r = fromForm(readForm(), e.pack, builtins().map((p) => p.id));
    if (!r.ok) return note(`Not saved: ${r.reason}`);
    if (!r.changed) {
      dirty = false;
      return note('Nothing to save.');
    }
    await act('saved', async () => {
      await write((user) => {
        user[indexIn(user, e)] = r.pack;
        return user;
      });
      return `Saved, version ${r.pack.version}.`;
    });
  }

  // A new Pack at the end of packs:user, selected; the 101st is refused (Req 5.5).
  async function add(what, pack, said, changeOn) {
    if (!leave()) return;
    if (entries.length >= MAX_PACKS) return note(`Not ${what}: ${FULL}`);
    await act(what, async () => {
      await write((user) => [...user, pack], changeOn);
      selected = pack.id;
      return said();
    });
  }

  function editCopy() {
    const e = current();
    if (!e?.pack || !e.builtin) return;
    const copy = copyOf(e.pack, takenIds(entries));
    const said = () => `Made ${copy.name}${on.includes(copy.id) ? ', switched on in place of the built-in' : ''}.`;
    add('copied', copy, said, (list) => placeCopy(list, e.pack.id, copy.id));
  }

  async function importFile() {
    const file = $('import').files[0];
    $('import').value = '';
    if (!file) return;
    if (file.size > lib.MAX_FILE) return note('Not imported: The file is larger than 256 KB.');
    const r = importPack(await file.text(), takenIds(entries));
    if (!r.ok) return note(`Not imported: ${r.reason}`);
    await add('imported', r.pack, () => `Imported ${r.pack.name} as "${r.pack.id}", switched off.`);
  }

  // The object URL dies with the tab, so it is never revoked by hand.
  function exportPack() {
    const e = current();
    if (!e?.pack) return;
    const file = packFile(e.pack);
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([file.text], { type: file.type })), download: file.name }).click();
    note(`Exported ${file.name}.`);
  }

  // Delete asks twice, as the database's Delete all: the first click arms
  // the button, the second deletes, and moving focus away disarms it.
  function remove() {
    const e = current();
    if (!e || e.builtin) return;
    if (!$('delete').dataset.armed) {
      $('delete').dataset.armed = 'yes';
      $('delete').textContent = 'Click again to delete';
      return;
    }
    disarm();
    const id = e.pack?.id ?? e.raw?.id;
    act('deleted', async () => {
      await write((user) => {
        const i = indexIn(user, e);
        return user.filter((_, j) => j !== i);
      }, (list) => list.filter((x) => x !== id));
      return `Deleted ${e.pack?.name ?? 'the invalid pack'}.`;
    });
  }

  function addLanguage() {
    const code = $('lang-code').value.trim().toLowerCase();
    if (!code) return note('Type a language code first, like "fr".');
    if (!lib.isLang(code)) return note(`"${code}" is not a language code like "fr" or "pt-br".`);
    if (readForm().langs.some(([c]) => c === code)) return note(`${languageName(code)} is already there.`);
    const box = langBox(code, '');
    $('langs').append(box);
    $('lang-code').value = '';
    dirty = true;
    note('');
    box.querySelector('textarea').focus();
  }

  function wire() {
    $('list').addEventListener('click', (e) => {
      const key = e.target.closest('button')?.dataset.key;
      if (key) select(key);
    });
    $('form').addEventListener('input', () => { dirty = true; });
    $('form').addEventListener('submit', (e) => {
      e.preventDefault();
      save();
    });
    $('save').addEventListener('click', save);
    $('copy').addEventListener('click', editCopy);
    $('export').addEventListener('click', exportPack);
    $('delete').addEventListener('click', remove);
    $('delete').addEventListener('blur', disarm);
    $('add-lang').addEventListener('click', addLanguage);
    $('new').addEventListener('click', () => {
      const pack = newPack(takenIds(entries));
      add('made', pack, () => `Made ${pack.name}: give it tells, then switch it on in the popup.`);
    });
    $('import-btn').addEventListener('click', () => $('import').click());
    $('import').addEventListener('change', importFile);
    // The worker's update, the popup's switches, another editor tab: the
    // list follows; the pane too unless it holds unsaved changes.
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local' || !['packs:builtin', 'packs:user', 'settings'].some((k) => k in changes)) return;
      const before = selected;
      await load();
      renderList();
      if (!dirty || selected !== before) renderPane();
    });
  }

  load().then(() => {
    wire();
    renderList();
    renderPane();
  });
})();

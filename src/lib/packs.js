// The pure Pack library (packs design, lib/packs.js): validation, the
// editor's line syntax, folding, Pattern safety, Post_Shape, compiling and
// scoring. No DOM, no storage, no chrome.*: the content scripts, the worker,
// the popup and the editor all load it. Shared-lib pattern, see rules.js.
(() => {
  const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const LANG = /^[a-z]{2,3}(-[a-z0-9]+)?$/;
  const KINDS = ['junk', 'topic'];
  const MEASURES = ['emoji', 'hashtags', 'caps', 'lines', 'length'];
  const MEDIA = ['image', 'video', 'gif', 'poll', 'link'];
  const CONTEXTS = ['reply', 'quote', 'repost', 'original'];
  // Account Tells: the checkmarks X shows, then behaviour from the
  // database. Judged on either Author of a repost, as name and bio are.
  const ACCOUNT = ['gold', 'grey', 'affiliate', 'blue', 'everywhere', 'offences', 'copy', 'recycled', 'hidden-before'];
  const MAX_TELLS = 300;
  const MAX_FILE = 256 * 1024;   // bytes, refused before parsing
  const MAX_PATTERN = 200;
  const MAX_PHRASE = 100;

  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const chars = (s) => [...s].length;
  const count = (s, re) => (s.match(re) ?? []).length;

  const fold = (text) => String(text).normalize('NFKC').toLowerCase();
  // A Phrase as matched and deduplicated: folded, whitespace runs as one space.
  const phraseKey = (phrase) => fold(phrase).trim().replace(/\s+/gu, ' ');

  // ---- checkPattern (Req 5.4) ----

  // The quantifier starting at src[i], or null. A fixed {n} counts toward no
  // limit, but `repeats` still marks n above 1 for the group rule.
  function quantAt(src, i) {
    const c = src[i];
    if (c === '*' || c === '+') return { len: 1, counts: true, repeats: true };
    if (c === '?') return { len: 1, counts: true, repeats: false };
    const m = c === '{' && /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
    if (!m) return null;
    const max = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]);
    return { len: m[0].length, counts: m[2] !== undefined, repeats: max > 1 };
  }

  // The reason a Pattern is refused, or null. One scan tracking escapes,
  // classes and group depth. Measured on 500 characters (2026-11-15/17):
  // .*.*x 154 ms, \s*\s*\s*$ 26.5 s, (a*){3}x over 20 s; what passes stays near 13 ms.
  function checkPattern(src) {
    if (typeof src !== 'string' || src === '') return 'A pattern cannot be empty.';
    if (chars(src) > MAX_PATTERN) return `Longer than ${MAX_PATTERN} characters.`;
    try {
      new RegExp(src, 'iu');
    } catch (e) {
      return `Does not compile: ${e.message}`;
    }
    let quants = 0;
    let repeats = 0;
    let inClass = false;
    const groups = [{ quant: false, alt: false }];   // [0] is the whole Pattern
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1];
        if (/[1-9k]/.test(n)) return 'Backreferences are not allowed.';
        i = 'pPu'.includes(n) && src[i + 2] === '{' ? src.indexOf('}', i) : i + 1;
        continue;
      }
      if (inClass) {
        inClass = c !== ']';
        continue;
      }
      if (c === '[') {
        inClass = true;
      } else if (c === '(') {
        groups.push({ quant: false, alt: false });
        if (src[i + 1] === '?') i += 1;   // (?: (?= (?! (?<name> (?<= (?<!
      } else if (c === '|') {
        groups.at(-1).alt = true;
      } else if (c === ')') {
        const body = groups.pop();
        const q = quantAt(src, i + 1);
        if (q && (q.counts || q.repeats) && (body.quant || body.alt)) {
          return 'A repeated group cannot hold a quantifier or |.';
        }
        const outer = groups.at(-1);
        outer.quant ||= body.quant;
        outer.alt ||= body.alt;
      } else {
        const q = quantAt(src, i);
        if (!q) continue;
        if (q.counts) {
          quants += 1;
          if (q.repeats) repeats += 1;
          groups.at(-1).quant = true;
        }
        i += q.len - 1;
        if (src[i + 1] === '?') i += 1;   // lazy
      }
    }
    if (quants > 3) return 'More than three quantifiers (?, *, +, {m,n}).';
    if (repeats > 1) return 'More than one repeating quantifier (*, +, {m,}, {m,n}).';
    return null;
  }

  // ---- validate (the Pack file table, Req 5.4, 5.5, 6.2, 6.4) ----

  // A hostname as matched: lowercased, punycode, 'www.' dropped; null if not one.
  function host(d) {
    if (typeof d !== 'string' || !/^[^\s/:@?#\\]+$/u.test(d)) return null;
    let h;
    try {
      h = new URL(`http://${d}`).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
    return h.includes('.') && !h.endsWith('.') ? h : null;
  }

  function textTell(t, w, on) {
    if (('phrase' in t) === ('pattern' in t)) return 'needs a phrase or a pattern, not both';
    if ('phrase' in t) {
      const p = typeof t.phrase === 'string' ? t.phrase.trim() : '';
      if (chars(p) < 1 || chars(p) > MAX_PHRASE) return `phrase must be 1 to ${MAX_PHRASE} characters`;
      return { w, on, phrase: p };
    }
    const why = checkPattern(t.pattern);
    return why ? `pattern refused: ${why}` : { w, on, pattern: t.pattern };
  }

  function shapeTell(t, w) {
    if (!MEASURES.includes(t.measure)) return `measure must be one of ${MEASURES.join(', ')}`;
    if (!('min' in t) && !('max' in t)) return 'a shape tell needs min, max or both';
    const top = t.measure === 'caps' ? 1 : Infinity;
    const tell = { w, on: 'shape', measure: t.measure };
    for (const bound of ['min', 'max']) {
      if (!(bound in t)) continue;
      const v = t[bound];
      if (typeof v !== 'number' || !(v >= 0 && v <= top)) return `${bound} must be a number ${top === 1 ? 'from 0 to 1' : 'from 0 up'}`;
      tell[bound] = v;
    }
    if (tell.min > tell.max) return 'min is above max';
    return tell;
  }

  function mediaTell(t, w) {
    if (('has' in t) === ('domain' in t)) return 'needs has or domain, not both';
    if ('has' in t) return MEDIA.includes(t.has) ? { w, on: 'media', has: t.has } : `has must be one of ${MEDIA.join(', ')}`;
    const h = host(t.domain);
    return h ? { w, on: 'media', domain: h } : 'domain must be a hostname like example.com';
  }

  // One Tell, cleaned of unknown keys, or the reason it is refused.
  function cleanTell(t, inLanguage) {
    if (!isObject(t)) return 'not a tell';
    const { w, on } = t;
    if (!(Number.isInteger(w) && w >= -10 && w <= 10 && w !== 0)) return 'weight must be a whole number from -10 to 10, not 0';
    if (inLanguage && on !== 'text') return 'only text tells go under a language';
    switch (on) {
      case 'text': return inLanguage ? textTell(t, w, on) : 'text tells go under a language';
      case 'name':
      case 'bio': return textTell(t, w, on);
      case 'shape': return shapeTell(t, w);
      case 'media': return mediaTell(t, w);
      case 'context': return CONTEXTS.includes(t.is) ? { w, on, is: t.is } : `is must be one of ${CONTEXTS.join(', ')}`;
      case 'account': return ACCOUNT.includes(t.is) ? { w, on, is: t.is } : `is must be one of ${ACCOUNT.join(', ')}`;
      default: return `unknown tell input "${on}"`;
    }
  }

  // A list of Tells cleaned, Phrase duplicates by fold dropped; or the reason.
  function cleanList(list, inLanguage, path) {
    if (!Array.isArray(list)) return `${path} must be a list.`;
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const t = cleanTell(list[i], inLanguage);
      if (typeof t === 'string') return `${path}[${i}]: ${t}.`;
      if (t.phrase !== undefined) {
        const k = `${t.on} ${phraseKey(t.phrase)}`;
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(t);
    }
    return out;
  }

  const textField = (v, max) => typeof v === 'string' && chars(v.trim()) >= 1 && chars(v.trim()) <= max;
  const isCount = (v, min, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;

  // A Pack file's text or a stored Pack object -> the clean Pack, or the
  // first reason it is refused. opts.builtin: a shipped Pack (no `from`);
  // otherwise opts.builtinIds are ids a user Pack may not take.
  function validate(raw, opts = {}) {
    const no = (reason) => ({ ok: false, reason });
    if (typeof raw === 'string') {
      if (raw.length > MAX_FILE || new TextEncoder().encode(raw).length > MAX_FILE) return no('The file is larger than 256 KB.');
      try {
        raw = JSON.parse(raw);
      } catch {
        return no('The file is not valid JSON.');
      }
    }
    if (!isObject(raw)) return no('Not a Papieren pack.');
    if (raw.papierenPack !== 1) return no('Unknown pack format: papierenPack must be 1.');
    if (typeof raw.id !== 'string' || !ID.test(raw.id)) {
      return no('id must be 1 to 40 lowercase letters, digits or hyphens, starting with a letter or digit.');
    }
    if (!opts.builtin && new Set(opts.builtinIds ?? []).has(raw.id)) return no(`id "${raw.id}" belongs to a built-in pack.`);
    if (!textField(raw.name, 40)) return no('name must be 1 to 40 characters.');
    if (!textField(raw.description, 120)) return no('description must be 1 to 120 characters.');
    if (!KINDS.includes(raw.kind)) return no('kind must be "junk" or "topic".');
    if (!isCount(raw.version, 1)) return no('version must be a whole number from 1.');
    if (!isCount(raw.threshold, 1, 100)) return no('threshold must be a whole number from 1 to 100.');
    if ('from' in raw) {
      if (opts.builtin) return no('A built-in pack has no from.');
      const f = raw.from;
      if (!isObject(f) || typeof f.id !== 'string' || !ID.test(f.id) || !isCount(f.version, 1)) {
        return no('from must name the built-in pack id and a version from 1.');
      }
    }

    const tellsIn = raw.tells ?? [];
    const langsIn = raw.languages ?? {};
    if (!isObject(langsIn)) return no('languages must be an object.');
    const total = Object.values(langsIn).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), Array.isArray(tellsIn) ? tellsIn.length : 0);
    if (total > MAX_TELLS) return no(`More than ${MAX_TELLS} tells.`);

    const tells = cleanList(tellsIn, false, 'tells');
    if (typeof tells === 'string') return no(tells);
    const languages = {};
    for (const [lang, list] of Object.entries(langsIn)) {
      if (!LANG.test(lang)) return no(`languages: "${lang}" is not a language code like "en" or "pt-br".`);
      const clean = cleanList(list, true, `languages.${lang}`);
      if (typeof clean === 'string') return no(clean);
      languages[lang] = clean;
    }

    const pack = {
      papierenPack: 1, id: raw.id, name: raw.name.trim(), kind: raw.kind,
      description: raw.description.trim(), version: raw.version, threshold: raw.threshold,
    };
    if (raw.from) pack.from = { id: raw.from.id, version: raw.from.version };
    return { ok: true, pack: { ...pack, tells, languages } };
  }

  // The stored lists -> every valid Pack, built-ins first, then user Packs,
  // each in stored order. A Pack that fails, or repeats an id, is left out
  // (Error Handling); a user Pack may not take a built-in's id.
  function merge(builtin, user) {
    const seen = new Set();
    const clean = (list, opts) => (Array.isArray(list) ? list : []).flatMap((p) => {
      const r = validate(p, opts);
      if (!r.ok || seen.has(r.pack.id)) return [];
      seen.add(r.pack.id);
      return [r.pack];
    });
    const b = clean(builtin, { builtin: true });
    return [...b, ...clean(user, { builtinIds: b.map((p) => p.id) })];
  }

  // Req 4.3: every Tell, language-independent and per language.
  const tellCount = (pack) => Object.values(pack.languages).reduce((n, l) => n + l.length, pack.tells.length);

  // ---- parseLines, toLines: the editor's line syntax (Req 5.2, 5.4) ----

  // `#` at the start of a line, or after whitespace and before whitespace or
  // the end, starts a comment, so `1 #giveaway` stays a Phrase.
  // ponytail: no escape, so a Phrase or Pattern holding " # " cannot be
  // written as a line; add one if a Pack ever needs it.
  const uncomment = (line) => (/^\s*#/.test(line) ? '' : line.replace(/\s#(\s.*)?$/u, ''));
  const SHAPE_LINE = /^(emoji|hashtags|caps|lines|length)\s*(>=|<=)\s*(\S+)(?:\s*(>=|<=)\s*(\S+))?$/u;

  // One line's body -> a raw Tell for cleanTell, or the reason.
  function lineTell(w, body, on) {
    const phraseOrPattern = (s, input) => {
      if (!s.startsWith('/')) return { w, on: input, phrase: s };
      if (s.length < 3 || !s.endsWith('/')) return 'a pattern is written between slashes, like /^rt if\\b/';
      return { w, on: input, pattern: s.slice(1, -1) };
    };
    if (on === 'text') return phraseOrPattern(body, 'text');
    let m;
    if ((m = /^(name|bio):\s*(.+)$/u.exec(body))) return phraseOrPattern(m[2], m[1]);
    if ((m = /^media:\s*(\S+)$/u.exec(body))) return { w, on: 'media', has: m[1] };
    if ((m = /^domain:\s*(\S+)$/u.exec(body))) return { w, on: 'media', domain: m[1] };
    if ((m = /^context:\s*(\S+)$/u.exec(body))) return { w, on: 'context', is: m[1] };
    if ((m = /^account:\s*(\S+)$/u.exec(body))) return { w, on: 'account', is: m[1] };
    if ((m = SHAPE_LINE.exec(body))) {
      if (m[4] === m[2]) return 'use >= and <= at most once each';
      const t = { w, on: 'shape', measure: m[1] };
      t[m[2] === '>=' ? 'min' : 'max'] = Number(m[3]);
      if (m[4]) t[m[4] === '>=' ? 'min' : 'max'] = Number(m[5]);
      return t;
    }
    return 'not a tell: phrases and /patterns/ go under a language; here use name:, bio:, '
      + `${MEASURES.join(', ')}, media:, domain:, context: or account:`;
  }

  // A textarea -> Tells, or the first refused line (1-based) and its reason.
  // on: 'text' for a language's textarea, 'any' for the language-independent one.
  function parseLines(text, on) {
    const tells = [];
    const lines = String(text).split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
      const line = uncomment(lines[n]).trim();
      if (!line) continue;
      const fail = (reason) => ({ ok: false, line: n + 1, reason });
      const m = /^(-?\d+)\s+(.+)$/u.exec(line);
      if (!m) return fail('a tell starts with its weight, like "2 like if you agree"');
      const raw = lineTell(Number(m[1]), m[2], on);
      const t = typeof raw === 'string' ? raw : cleanTell(raw, on === 'text');
      if (typeof t === 'string') return fail(t);
      tells.push(t);
    }
    return { ok: true, tells };
  }

  function toLines(tells) {
    const pp = (t) => (t.pattern !== undefined ? `/${t.pattern}/` : t.phrase);
    const body = (t) => {
      switch (t.on) {
        case 'text': return pp(t);
        case 'name':
        case 'bio': return `${t.on}: ${pp(t)}`;
        case 'shape': return [t.measure, t.min !== undefined && `>= ${t.min}`, t.max !== undefined && `<= ${t.max}`].filter(Boolean).join(' ');
        case 'media': return t.has !== undefined ? `media: ${t.has}` : `domain: ${t.domain}`;
        default: return `${t.on}: ${t.is}`;
      }
    };
    return tells.map((t) => `${t.w} ${body(t)}`).join('\n');
  }

  // ---- visible, measure: Post_Shape at intake (Req 1.5, 1.6) ----

  // X's full_text is HTML-escaped and display_text_range counts code points
  // of the escaped text: cut first, unescape after.
  function visible(fullText, range) {
    if (typeof fullText !== 'string') return undefined;
    const cps = [...fullText];
    const [from, to] = Array.isArray(range) ? range : [0, cps.length];
    return cps.slice(from, to).join('').replace(/&(lt|gt|amp);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&' })[e]);
  }

  // Shape of the visible text in its original case. hashtags: the entity
  // count, undefined when X sent no entities. A measure left out is not available.
  function measure(text, hashtags) {
    const s = typeof text === 'string' ? text : '';
    const shape = { emoji: count(s, /\p{Extended_Pictographic}/gu), length: chars(s) };
    if (Number.isInteger(hashtags)) shape.hashtags = hashtags;
    const upper = count(s, /\p{Lu}/gu);
    const cased = upper + count(s, /\p{Ll}/gu);
    if (cased >= 20) shape.caps = upper / cased;
    if (s.trim()) {
      const lines = s.split('\n').filter((l) => l.trim()).length;
      shape.lines = lines / Math.max(1, count(s, /[.!?…]+(?=\s|$)/gu));
    }
    return shape;
  }

  // ---- compile, score (Req 1.1 to 1.6, 3.1 to 3.3) ----

  // Phrases are whole words where words exist: an edge gets a lookaround when
  // its character is a letter or digit outside the scripts written without spaces.
  const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
  const WORD = /[\p{L}\p{N}\p{M}]/u;
  const needsEdge = (c) => /[\p{L}\p{N}]/u.test(c) && !NO_SPACES.test(c);
  const escape = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

  const phraseSource = (k) => `(${k.split(' ').map(escape).join('\\s+')})`;

  // One alternation per input, longest Phrase first. At one position only the
  // longest can match, so `implied[i]` lists the shorter Phrases that are
  // whole-word prefixes of Phrase i and so are met whenever it is. The word
  // edges are checked by `scan`, not by lookarounds in the alternation: a
  // \p{L} class per Phrase cost about 190 ms at the first exec of a
  // 200-Phrase group, against 6 ms without (benchmark, 2026-11-17).
  function phraseGroup(input, phrases) {
    phrases.sort((a, b) => b.k.length - a.k.length);
    const implied = phrases.map((p) => phrases.flatMap((q, j) => {
      if (q.k.length >= p.k.length || !p.k.startsWith(q.k)) return [];
      const next = String.fromCodePoint(p.k.codePointAt(q.k.length));
      return needsEdge([...q.k].at(-1)) && WORD.test(next) ? [] : [j];
    }));
    const edges = phrases.map((p) => [needsEdge(String.fromCodePoint(p.k.codePointAt(0))), needsEdge([...p.k].at(-1))]);
    const re = new RegExp(phrases.map((p) => phraseSource(p.k)).join('|'), 'giu');
    return { input, re, w: phrases.map((p) => p.w), implied, edges };
  }

  // account Tells stay apart: their behaviour changes after intake, so
  // score() leaves them to accountScore() at judge time.
  function compileList(tells) {
    const byInput = new Map();   // input -> Map(phrase key -> weight)
    const list = { phrases: [], patterns: [], rest: [], account: [] };
    for (const t of tells) {
      if (t.on === 'account') {
        list.account.push(t);
      } else if (t.phrase !== undefined) {
        const keys = byInput.get(t.on) ?? byInput.set(t.on, new Map()).get(t.on);
        const k = phraseKey(t.phrase);
        if (!keys.has(k)) keys.set(k, t.w);
      } else if (t.pattern !== undefined) {
        list.patterns.push({ input: t.on, re: new RegExp(t.pattern, 'iu'), w: t.w });
      } else {
        list.rest.push(t);
      }
    }
    for (const [input, keys] of byInput) list.phrases.push(phraseGroup(input, [...keys].map(([k, w]) => ({ k, w }))));
    return list;
  }

  const memo = new WeakMap();

  // The enabled Packs, in list order -> one compiled entry each. Memoised by
  // the array's identity: a Pack change hands in a new array.
  function compile(packs) {
    let c = memo.get(packs);
    if (!c) {
      c = packs.map((p) => ({
        id: p.id, name: p.name, threshold: p.threshold,
        any: compileList(p.tells),
        langs: new Map(Object.entries(p.languages).map(([lang, tells]) => [lang, compileList(tells)])),
      }));
      memo.set(packs, c);
    }
    return c;
  }

  // Adds to `met` the index of every Phrase found in s. Matches may overlap:
  // the next search starts one code point after the last match's start.
  // A word edge at a match start fails every Phrase there, which all begin
  // with the same character; one at its end fails only the longest, whose
  // whole-word prefixes are then the Phrases the old lookarounds let match.
  const isWord = (c) => c !== undefined && WORD.test(c);
  const cpBefore = (s, i) => [...s.slice(Math.max(0, i - 2), i)].at(-1);
  const cpAt = (s, j) => (j < s.length ? String.fromCodePoint(s.codePointAt(j)) : undefined);
  function scan(group, s, met) {
    const { re, edges, implied } = group;
    re.lastIndex = 0;
    for (let m; (m = re.exec(s));) {
      const i = m.indexOf(m[0], 1) - 1;
      const [before, after] = edges[i];
      if (!(before && isWord(cpBefore(s, m.index)))) {
        if (after && isWord(cpAt(s, m.index + m[0].length))) for (const j of implied[i]) met.add(j);
        else met.add(i);
      }
      re.lastIndex = m.index + (s.codePointAt(m.index) > 0xffff ? 2 : 1);
    }
  }

  function otherMet(t, post) {
    switch (t.on) {
      case 'shape': {
        const v = post.shape?.[t.measure];
        return typeof v === 'number' && !(v < t.min) && !(v > t.max);
      }
      case 'media':
        return t.has !== undefined
          ? post.media?.includes(t.has) === true
          : post.domains?.some((d) => d === t.domain || d.endsWith(`.${t.domain}`)) === true;
      case 'context':
        return t.is === 'original'
          ? post.reply === false && post.quote === false && post.repost === false
          : post[t.is] === true;
      default:
        return false;
    }
  }

  // A Pattern that throws at match time despite checkPattern is skipped,
  // logged once per page (Error Handling).
  const warned = new Set();
  function patternMet(p, s) {
    try {
      return p.re.test(s);
    } catch (e) {
      p.dead = true;
      if (!warned.has(p.re.source)) {
        warned.add(p.re.source);
        console.warn(`Papieren: Pattern /${p.re.source}/ skipped:`, e);
      }
      return false;
    }
  }

  function listScore(list, inputs, post) {
    let sum = 0;
    for (const g of list.phrases) {
      const met = new Set();
      for (const s of inputs[g.input]) if (typeof s === 'string') scan(g, s, met);
      for (const i of [...met]) for (const j of g.implied[i]) met.add(j);
      for (const i of met) sum += g.w[i];
    }
    for (const p of list.patterns) if (!p.dead && inputs[p.input].some((s) => typeof s === 'string' && patternMet(p, s))) sum += p.w;
    for (const t of list.rest) if (otherMet(t, post)) sum += t.w;
    return sum;
  }

  // post: { text (folded), lang, shape, media, domains, reply, quote, repost };
  // authors: [{ name, bio }] folded, both Authors of a repost (Req 1.4).
  // A Tell whose input is missing is not met (Req 1.6). Account Tells are
  // left out: accountScore() adds them. -> Map(pack id -> Score)
  function score(compiled, post, authors = []) {
    const inputs = { text: [post.text], name: authors.map((a) => a?.name), bio: authors.map((a) => a?.bio) };
    const out = new Map();
    for (const p of compiled) {
      const lang = p.langs.get(post.lang);
      out.set(p.id, listScore(p.any, inputs, post) + (lang ? listScore(lang, inputs, post) : 0));
    }
    return out;
  }

  // The account Tells' share of each Score, read at judge time.
  // authors: [{ badges?: string[], acct?: { is: Set, hidden: Set of Pack ids } }],
  // both Authors of a repost; a Tell met by either counts once.
  // -> Map(pack id -> sum), only for Packs with account Tells.
  function accountScore(compiled, authors = []) {
    const out = new Map();
    for (const p of compiled) {
      if (!p.any.account.length) continue;
      const met = (t) => authors.some((a) => (t.is === 'hidden-before'
        ? a?.acct?.hidden.has(p.id) === true
        : a?.badges?.includes(t.is) === true || a?.acct?.is.has(t.is) === true));
      let sum = 0;
      for (const t of p.any.account) if (met(t)) sum += t.w;
      out.set(p.id, sum);
    }
    return out;
  }

  const packs = {
    KINDS, MEASURES, MEDIA, CONTEXTS, ACCOUNT, MAX_TELLS, MAX_FILE,
    fold, checkPattern, validate, merge, tellCount, parseLines, toLines, visible, measure, compile, score, accountScore,
  };

  globalThis.Papieren ??= {};
  globalThis.Papieren.packs = packs;
  if (typeof module === 'object') module.exports = packs;
})();

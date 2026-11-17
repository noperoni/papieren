const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_FILE, fold, checkPattern, validate, parseLines, toLines, visible, measure, compile, score,
} = require('../src/lib/packs.js');

const pack = (over = {}) => ({
  papierenPack: 1, id: 'bait', name: 'Bait', kind: 'junk', description: 'Asks for likes.',
  version: 1, threshold: 3, tells: [], languages: {}, ...over,
});
const refused = (raw, opts) => {
  const r = validate(raw, opts);
  assert.equal(r.ok, false, JSON.stringify(raw).slice(0, 120));
  assert.equal(typeof r.reason, 'string');
  return r.reason;
};
const tellReason = (t, inLanguage = false) => refused(inLanguage ? pack({ languages: { en: [t] } }) : pack({ tells: [t] }));

// ---- 4.1 fold, checkPattern, validate ----

test('fold: NFKC then lower case', () => {
  assert.equal(fold('𝐂𝐑𝐘𝐏𝐓𝐎'), 'crypto');
  assert.equal(fold('ＦＵＬＬ ｗｉｄｔｈ'), 'full width');
  assert.equal(fold('ﬁnance'), 'finance');
});

const ACCEPT = ['\\bcrypto\\b', 'nft|web3', '\\d{4}\\s+colou?r', '.*?x', '(?:nft|web3)\\b'];
const REFUSE = ['(a+)+', '(a|ab)*', '(\\w)\\1', '.*.*x', '\\s*\\s*\\s*$', 'a?a?a?a?', 'a'.repeat(201)];

test('checkPattern accepts the design list', () => {
  for (const src of ACCEPT) assert.equal(checkPattern(src), null, src);
  for (const src of ['a'.repeat(200), '.*x', '[*+?{]', '\\p{L}+', 'a{3}b{3}c{9}', '(?<tag>#)\\w+', '(?:ab){2,}', 'x+?y']) {
    assert.equal(checkPattern(src), null, src);
  }
});

test('checkPattern refuses the design list, each with its reason', () => {
  for (const src of REFUSE) assert.equal(typeof checkPattern(src), 'string', src);
  assert.match(checkPattern('(a+)+'), /repeated group/);
  assert.match(checkPattern('(a|ab)*'), /repeated group/);
  assert.match(checkPattern('(\\w)\\1'), /Backreferences/);
  assert.match(checkPattern('(?<w>\\w)\\k<w>'), /Backreferences/);
  assert.match(checkPattern('.*.*x'), /one repeating/);
  assert.match(checkPattern('\\s*\\s*\\s*$'), /one repeating/);
  assert.match(checkPattern('a?a?a?a?'), /three quantifiers/);
  assert.match(checkPattern('a'.repeat(201)), /200/);
  assert.match(checkPattern('(unclosed'), /Does not compile/);
  assert.match(checkPattern(''), /empty/);
  assert.match(checkPattern(7), /empty/);
});

test('checkPattern: a fixed {n} above 1 repeats a group, so (a*){3}x is refused', () => {
  // (a*){3}x ran past 20 s on 500 characters (2026-11-17).
  assert.match(checkPattern('(a*){3}x'), /repeated group/);
  assert.match(checkPattern('(?:a?){5}'), /repeated group/);
  assert.equal(checkPattern('(?:a+){1}'), null);
  assert.equal(checkPattern('(ab){3}c+'), null);
});

test('checkPattern: one repeating and two optional quantifiers at most', () => {
  assert.equal(checkPattern('.*a?a?x'), null);
  assert.match(checkPattern('.*a?a?a?x'), /three quantifiers/);
});

test('every accepted Pattern runs under 15 ms on 500 characters', () => {
  const inputs = ['a', ' ', '1', 'ab', 'x '].map((s) => s.repeat(500).slice(0, 500));
  for (const src of [...ACCEPT, '.*x', '.*a?a?x']) {
    const re = new RegExp(src, 'iu');
    for (const s of inputs) {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        re.test(s);
        best = Math.min(best, performance.now() - t0);
      }
      assert.ok(best < 15, `${src} took ${best.toFixed(1)} ms`);
    }
  }
});

test('validate: a full Pack passes and comes back clean', () => {
  const r = validate(pack({
    name: '  Bait ', extra: 'dropped', from: { id: 'engagement-bait', version: 3, x: 1 },
    tells: [
      { w: 2, on: 'shape', measure: 'emoji', min: 5, note: 'dropped' },
      { w: 1, on: 'bio', phrase: ' follow back ' },
      { w: -2, on: 'context', is: 'reply' },
      { w: 1, on: 'media', domain: 'WWW.Example.COM' },
      { w: 1, on: 'media', has: 'poll' },
      { w: 1, on: 'name', pattern: '\\bnft\\b' },
    ],
    languages: { en: [{ w: 3, on: 'text', phrase: 'like if you agree' }], 'pt-br': [] },
  }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.pack, {
    papierenPack: 1, id: 'bait', name: 'Bait', kind: 'junk', description: 'Asks for likes.', version: 1, threshold: 3,
    from: { id: 'engagement-bait', version: 3 },
    tells: [
      { w: 2, on: 'shape', measure: 'emoji', min: 5 },
      { w: 1, on: 'bio', phrase: 'follow back' },
      { w: -2, on: 'context', is: 'reply' },
      { w: 1, on: 'media', domain: 'example.com' },
      { w: 1, on: 'media', has: 'poll' },
      { w: 1, on: 'name', pattern: '\\bnft\\b' },
    ],
    languages: { en: [{ w: 3, on: 'text', phrase: 'like if you agree' }], 'pt-br': [] },
  });
  assert.deepEqual(validate(pack({ tells: undefined, languages: undefined })).pack.languages, {});
});

test('validate: file text is parsed; over 256 KB is refused unread', () => {
  assert.equal(validate(JSON.stringify(pack())).ok, true);
  assert.match(refused('{ not json'), /not valid JSON/);
  // Not JSON either, but refused for its size before any parse.
  assert.match(refused(`{${' '.repeat(MAX_FILE)}`), /256 KB/);
  // 256 KB counted in bytes: 100,000 three-byte characters.
  assert.match(refused(`"${'€'.repeat(100000)}"`), /256 KB/);
});

test('validate: the Pack fields', () => {
  assert.match(refused(null), /Not a Papieren pack/);
  assert.match(refused([]), /Not a Papieren pack/);
  assert.match(refused(pack({ papierenPack: 2 })), /Unknown pack format/);
  for (const id of ['Bait', '-bait', 'a'.repeat(41), '', 7]) assert.match(refused(pack({ id })), /^id must/);
  assert.equal(validate(pack({ id: 'a'.repeat(40) })).ok, true);
  assert.match(refused(pack({ id: 'ragebait' }), { builtinIds: ['ragebait'] }), /built-in/);
  assert.equal(validate(pack({ id: 'ragebait' }), { builtin: true, builtinIds: ['ragebait'] }).ok, true);
  for (const name of ['', '   ', 'x'.repeat(41), 3]) assert.match(refused(pack({ name })), /^name/);
  assert.match(refused(pack({ description: 'x'.repeat(121) })), /^description/);
  assert.match(refused(pack({ kind: 'spam' })), /^kind/);
  assert.equal(validate(pack({ kind: 'topic' })).ok, true);
  for (const version of [0, 1.5, '2']) assert.match(refused(pack({ version })), /^version/);
  for (const threshold of [0, 101, 2.5]) assert.match(refused(pack({ threshold })), /^threshold/);
  assert.equal(validate(pack({ threshold: 100 })).ok, true);
  assert.match(refused(pack({ from: { id: 'x', version: 1 } }), { builtin: true }), /built-in pack has no from/);
  for (const from of [null, { id: 'x' }, { id: 'X', version: 1 }, { id: 'x', version: 0 }]) assert.match(refused(pack({ from })), /^from/);
  assert.match(refused(pack({ tells: {} })), /tells must be a list/);
  assert.match(refused(pack({ languages: [] })), /languages must be an object/);
  for (const lang of ['EN', 'english', 'e']) assert.match(refused(pack({ languages: { [lang]: [] } })), /not a language code/);
  assert.match(refused(pack({ languages: { en: 'x' } })), /languages.en must be a list/);
});

test('validate: every Tell rule names where it failed', () => {
  for (const w of [0, 11, -11, 1.5, '2']) assert.match(tellReason({ w, on: 'context', is: 'reply' }), /^tells\[0\]: weight/);
  assert.equal(validate(pack({ tells: [{ w: -10, on: 'context', is: 'quote' }, { w: 10, on: 'context', is: 'repost' }] })).ok, true);
  assert.match(tellReason({ w: 1, on: 'text', phrase: 'x' }), /text tells go under a language/);
  assert.match(tellReason({ w: 1, on: 'bio', phrase: 'x' }, true), /^languages\.en\[0\]: only text tells/);
  assert.match(tellReason({ w: 1, on: 'mood' }), /unknown tell input/);
  assert.match(tellReason('2 like'), /not a tell/);
  assert.match(tellReason({ w: 1, on: 'name' }), /phrase or a pattern/);
  assert.match(tellReason({ w: 1, on: 'name', phrase: 'a', pattern: 'a' }), /phrase or a pattern/);
  for (const phrase of ['   ', 'x'.repeat(101), 5]) assert.match(tellReason({ w: 1, on: 'bio', phrase }), /phrase must be/);
  assert.match(tellReason({ w: 1, on: 'text', pattern: '(a+)+' }, true), /pattern refused: A repeated group/);
  assert.match(tellReason({ w: 1, on: 'shape', measure: 'words', min: 1 }), /measure must be/);
  assert.match(tellReason({ w: 1, on: 'shape', measure: 'emoji' }), /needs min, max or both/);
  assert.match(tellReason({ w: 1, on: 'shape', measure: 'caps', min: 1.5 }), /min must be a number from 0 to 1/);
  assert.match(tellReason({ w: 1, on: 'shape', measure: 'length', max: -1 }), /max must be a number from 0 up/);
  assert.match(tellReason({ w: 1, on: 'shape', measure: 'emoji', min: '5' }), /min must be/);
  assert.match(tellReason({ w: 1, on: 'shape', measure: 'emoji', min: 5, max: 2 }), /min is above max/);
  assert.match(tellReason({ w: 1, on: 'media', has: 'audio' }), /has must be/);
  assert.match(tellReason({ w: 1, on: 'media' }), /has or domain/);
  for (const domain of ['http://x.com', 'nodot', 'a b.com', 'x.com/path', 'user@x.com']) {
    assert.match(tellReason({ w: 1, on: 'media', domain }), /domain must be a hostname/, domain);
  }
  assert.match(tellReason({ w: 1, on: 'context', is: 'retweet' }), /is must be/);
});

test('validate: Phrase duplicates by fold are dropped within one list only', () => {
  const r = validate(pack({
    tells: [{ w: 1, on: 'bio', phrase: 'crypto' }, { w: 2, on: 'bio', phrase: 'ＣＲＹＰＴＯ' }, { w: 1, on: 'name', phrase: 'crypto' }],
    languages: {
      en: [{ w: 3, on: 'text', phrase: 'Like if you agree' }, { w: 1, on: 'text', phrase: 'like  if you AGREE' }],
      fr: [{ w: 3, on: 'text', phrase: 'like if you agree' }],
    },
  }));
  assert.deepEqual(r.pack.tells.map((t) => `${t.on}:${t.w}`), ['bio:1', 'name:1']);
  assert.equal(r.pack.languages.en.length, 1);
  assert.equal(r.pack.languages.fr.length, 1);
});

test('validate: at most 300 Tells over tells and every language (Req 5.5)', () => {
  const ctx = (n) => Array.from({ length: n }, () => ({ w: 1, on: 'context', is: 'reply' }));
  const text = (n) => Array.from({ length: n }, (_, i) => ({ w: 1, on: 'text', phrase: `p${i}` }));
  assert.equal(validate(pack({ tells: ctx(100), languages: { en: text(100), fr: text(100) } })).ok, true);
  assert.match(refused(pack({ tells: ctx(101), languages: { en: text(100), fr: text(100) } })), /More than 300 tells/);
});

// ---- 4.2 parseLines, toLines ----

const ANY = [
  '1 name: crypto', '2 bio: /web3|nft/', '2 emoji >= 5', '1 caps >= 0.6 <= 0.9', '1 length <= 40',
  '2 media: link', '1 domain: example.com', '-2 context: reply',
].join('\n');
const TEXT = ['3 like if you agree', '2 /^rt if\\b/', '1 #giveaway', '1 name: is a phrase here'].join('\n');

test('parseLines and toLines round trip normalised input', () => {
  for (const [x, on] of [[ANY, 'any'], [TEXT, 'text']]) {
    const r = parseLines(x, on);
    assert.equal(r.ok, true, r.reason);
    assert.equal(toLines(r.tells), x);
  }
  assert.deepEqual(parseLines(ANY, 'any').tells.slice(2, 4), [
    { w: 2, on: 'shape', measure: 'emoji', min: 5 },
    { w: 1, on: 'shape', measure: 'caps', min: 0.6, max: 0.9 },
  ]);
  assert.deepEqual(parseLines(TEXT, 'text').tells[1], { w: 2, on: 'text', pattern: '^rt if\\b' });
});

test('parseLines skips comments and blank lines; a hashtag stays a Phrase', () => {
  const r = parseLines('# Bait phrases\n\n  3 like if you agree   # the classic\r\n1 #giveaway\n#', 'text');
  assert.deepEqual(r.tells.map((t) => t.phrase), ['like if you agree', '#giveaway']);
});

test('parseLines: a refusal names the line number and the reason', () => {
  const fail = (text, on, line, reason) => {
    const r = parseLines(text, on);
    assert.equal(r.ok, false, text);
    assert.equal(r.line, line, text);
    assert.match(r.reason, reason, text);
  };
  fail('1 name: x\nlike if you agree', 'any', 2, /starts with its weight/);
  fail('2 like if you agree', 'any', 1, /not a tell: phrases and \/patterns\/ go under a language/);
  fail('# ok\n0 like', 'text', 2, /weight must be/);
  fail('11 like', 'text', 1, /weight must be/);
  fail('1 a\n2 b\n3 /(a+)+/', 'text', 3, /pattern refused: A repeated group/);
  fail('2 /abc', 'text', 1, /between slashes/);
  fail('2 caps >= 2', 'any', 1, /from 0 to 1/);
  fail('2 emoji >= 1 >= 2', 'any', 1, /at most once each/);
  fail('2 emoji >= lots', 'any', 1, /min must be a number/);
  fail('2 media: audio', 'any', 1, /has must be/);
  fail('2 domain: http://x.com', 'any', 1, /hostname/);
  fail('2 context: thread', 'any', 1, /is must be/);
});

// ---- 4.3 visible, measure, compile, score ----

test('visible: cut by code points on the escaped text, then unescaped', () => {
  // '@ann ' is 5 code points; 'hi &amp; 😀 bye' is 14 in the escaped text.
  assert.equal(visible('@ann hi &amp; 😀 bye https://t.co/x', [5, 19]), 'hi & 😀 bye');
  assert.equal(visible('a &amp;lt; b &lt;3 &gt;'), 'a &lt; b <3 >');
  assert.equal(visible(undefined, [0, 1]), undefined);
});

test('measure: each measure at its edges, original case', () => {
  const s = measure('Hi 😀😀 ❤️ #yes', 1);
  assert.equal(s.emoji, 3);
  assert.equal(s.hashtags, 1);
  assert.equal(s.length, [...'Hi 😀😀 ❤️ #yes'].length);
  assert.equal(measure('x').hashtags, undefined);
  assert.equal(measure('x', 0).hashtags, 0);
  assert.equal(measure('ABCDEFGHIJabcdefghi 1 2 3').caps, undefined);   // 19 cased letters
  assert.equal(measure('ABCDEFGHIJabcdefghij 1 2 3').caps, 0.5);        // 20
  assert.equal(measure('ÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉ').caps, 1);
  assert.equal(measure('a.\n\nb!\nc').lines, 1.5);   // 3 lines, 2 sentences
  assert.equal(measure('One. Two? Three…').lines, 1 / 3);
  assert.equal(measure('no stop at all').lines, 1);
  assert.equal(measure('  ').lines, undefined);
  assert.deepEqual(measure(''), { emoji: 0, length: 0 });
});

const one = (over) => compile([pack(over)]);
const scoreOf = (compiled, post, authors) => score(compiled, { reply: false, quote: false, repost: false, ...post }, authors).get('bait');
const en = (...phrases) => ({ languages: { en: phrases.map(([phrase, w = 1]) => ({ w, on: 'text', phrase })) } });

test('compile is memoised by array identity', () => {
  const list = [pack()];
  assert.equal(compile(list), compile(list));
  assert.notEqual(compile(list), compile([...list]));
});

test('Phrases match whole words, in Han text, after NFKC folding', () => {
  const c = one(en(['art'], ['加密'], ['crypto'], ['#giveaway']));
  assert.equal(scoreOf(c, { lang: 'en', text: 'what a party' }), 0);
  assert.equal(scoreOf(c, { lang: 'en', text: 'nice art!' }), 1);
  assert.equal(scoreOf(c, { lang: 'en', text: 'arte' }), 0);
  assert.equal(scoreOf(c, { lang: 'en', text: '我爱加密货币' }), 1);
  assert.equal(scoreOf(c, { lang: 'en', text: fold('𝐂𝐑𝐘𝐏𝐓𝐎 to the moon') }), 1);
  assert.equal(scoreOf(c, { lang: 'en', text: 'join the#giveaway now' }), 1);
});

test('a Phrase met twice counts once; whitespace runs match; overlapping Phrases all count', () => {
  const c = one(en(['like', 2], ['like if you agree', 3], ['if you agree', 4], ['agree with me', 5]));
  assert.equal(scoreOf(c, { lang: 'en', text: 'like like like' }), 2);
  assert.equal(scoreOf(c, { lang: 'en', text: 'like if\nyou   agree' }), 2 + 3 + 4);
  assert.equal(scoreOf(c, { lang: 'en', text: 'if you agree with me' }), 4 + 5);
  assert.equal(scoreOf(c, { lang: 'en', text: 'likes if you agreed' }), 0);
});

test('a shorter Phrase is implied only where it ends on a word edge', () => {
  const c = one(en(['follow me for more', 2], ['follow me', 1], ['follow m', 10]));
  assert.equal(scoreOf(c, { lang: 'en', text: 'follow me for more' }), 3);
});

test('text Tells only for the Post_Language; the rest whatever the language (Req 3.1 to 3.3)', () => {
  const c = one({ ...en(['like if you agree', 3]), tells: [{ w: 1, on: 'shape', measure: 'emoji', min: 2 }] });
  const post = { text: 'like if you agree', shape: { emoji: 2 } };
  assert.equal(scoreOf(c, { ...post, lang: 'en' }), 4);
  assert.equal(scoreOf(c, { ...post, lang: 'fr' }), 1);
  assert.equal(scoreOf(c, { ...post, lang: undefined }), 1);
});

test('Patterns on text, name and bio, each tested once', () => {
  const c = one({
    tells: [{ w: 2, on: 'name', pattern: '\\bnft\\b' }, { w: 1, on: 'bio', pattern: 'web3' }],
    languages: { en: [{ w: 3, on: 'text', pattern: '^rt if\\b' }] },
  });
  assert.equal(scoreOf(c, { lang: 'en', text: 'rt if you agree' }, [{ name: 'ann nft', bio: 'web3 web3' }]), 6);
  assert.equal(scoreOf(c, { lang: 'en', text: 'please rt if' }, [{ name: 'nfts' }]), 0);
});

test('a repost judges name and bio on either Author (Req 1.4)', () => {
  const c = one({ tells: [{ w: 2, on: 'bio', phrase: 'crypto' }, { w: 1, on: 'name', phrase: 'bot' }] });
  const authors = [{ name: 'ann', bio: 'gardening' }, { name: 'news bot', bio: 'all things crypto' }];
  assert.equal(scoreOf(c, { lang: 'en' }, authors), 3);
  assert.equal(scoreOf(c, { lang: 'en' }, [{ name: 'bot', bio: 'crypto' }, { name: 'bot', bio: 'crypto' }]), 3);
  assert.equal(scoreOf(c, { lang: 'en' }, [{}]), 0);
});

test('shape, media, domain and context Tells; negative weights', () => {
  const c = one({
    tells: [
      { w: 2, on: 'shape', measure: 'caps', min: 0.5 },
      { w: 1, on: 'shape', measure: 'length', max: 40 },
      { w: 3, on: 'media', has: 'video' },
      { w: 1, on: 'media', domain: 'example.com' },
      { w: -2, on: 'context', is: 'reply' },
      { w: 4, on: 'context', is: 'original' },
    ],
  });
  assert.equal(scoreOf(c, { shape: { caps: 0.5, length: 41 } }), 2 + 4);
  assert.equal(scoreOf(c, { shape: { length: 40 }, media: ['video'] }), 1 + 3 + 4);
  assert.equal(scoreOf(c, { domains: ['news.example.com'], reply: true }), 1 - 2);
  assert.equal(scoreOf(c, { domains: ['notexample.com', 'example.co'], quote: true }), 0);
  assert.equal(scoreOf(c, { repost: true }), 0);
});

test('a Tell whose input is missing is not met (Req 1.6)', () => {
  const c = one({
    tells: [
      { w: 1, on: 'shape', measure: 'caps', max: 1 },
      { w: 1, on: 'media', has: 'image' },
      { w: 1, on: 'media', domain: 'example.com' },
      { w: 1, on: 'context', is: 'original' },
      { w: 1, on: 'bio', phrase: 'crypto' },
    ],
    ...en(['agree']),
  });
  assert.equal(score(c, { lang: 'en' }, []).get('bait'), 0);
});

test('a quote is judged on its own text only (Req 1.5)', () => {
  // x-parse gives a quote its own full_text, which never holds the quoted Post's.
  const c = one({ ...en(['like if you agree', 3]), tells: [{ w: 1, on: 'context', is: 'quote' }] });
  assert.equal(scoreOf(c, { lang: 'en', text: 'lol', quote: true }), 1);
});

test('score answers one Score per enabled Pack', () => {
  const c = compile([pack(en(['agree'])), pack({ id: 'other', ...en(['agree', 5]) })]);
  assert.deepEqual([...score(c, { lang: 'en', text: 'agree' })], [['bait', 1], ['other', 5]]);
});

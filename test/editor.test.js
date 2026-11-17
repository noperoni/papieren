const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib/packs.js');
const ed = require('../popup/packs.js');

const pack = (over = {}) => lib.validate({
  papierenPack: 1, id: 'engagement-bait', name: 'Engagement bait', kind: 'junk', description: 'Asks for likes.',
  version: 3, threshold: 6,
  tells: [{ w: -3, on: 'account', is: 'gold' }, { w: 2, on: 'shape', measure: 'emoji', min: 5 }],
  languages: { en: [{ w: 3, on: 'text', phrase: 'like if you agree' }, { w: 2, on: 'text', pattern: '^rt if\\b' }] },
  ...over,
}).pack;
const form = (p, over = {}) => ({ ...ed.formOf(p), ...over });

test('slug and uniqueId: ids the validator takes, suffixed -2, -3 and cut to 40 (Req 6.3)', () => {
  assert.equal(ed.slug('Engagement bait (copy)'), 'engagement-bait-copy');
  assert.equal(ed.slug('Visite médicale!'), 'visite-medicale');
  assert.equal(ed.slug('***'), 'pack');
  assert.equal(ed.uniqueId('mine', []), 'mine');
  assert.equal(ed.uniqueId('mine', ['mine', 'mine-2']), 'mine-3');
  const long = 'a'.repeat(39) + 'b';
  assert.equal(ed.uniqueId(long, [long]), `${'a'.repeat(38)}-2`);
  for (const id of [ed.slug('x'.repeat(60)), ed.uniqueId('ab-', ['ab'])]) assert.match(id, /^[a-z0-9][a-z0-9-]{0,39}$/);
});

test('listRows and takenIds: every stored Pack, invalid ones named and tagged (Error Handling)', () => {
  const entries = lib.check([pack()], [
    pack({ id: 'mine', name: 'Mine', from: { id: 'engagement-bait', version: 2 } }),
    pack({ id: 'own', name: 'Own' }),
    { id: 'broken', name: '  Broken one ', papierenPack: 1 },
    pack({ id: 'engagement-bait', name: 'Clash' }),
  ]);
  assert.deepEqual(ed.listRows(entries, ['mine', 'broken']), [
    { key: 'engagement-bait', name: 'Engagement bait', tag: 'built-in', on: false },
    { key: 'mine', name: 'Mine', tag: 'copy', on: true },
    { key: 'own', name: 'Own', tag: 'yours', on: false },
    { key: 'u#2', name: 'Broken one', tag: 'invalid', on: false },
    { key: 'u#3', name: 'Clash', tag: 'invalid', on: false },
  ]);
  assert.deepEqual(ed.takenIds(entries), ['engagement-bait', 'mine', 'own', 'broken', 'engagement-bait']);
  assert.match(entries[3].reason, /^description must be/);
  assert.match(entries[4].reason, /built-in/);
});

test('aboutLine: built-in, copy behind a newer built-in, a retired built-in, invalid', () => {
  const b = pack();
  const [builtin] = lib.check([b], []);
  assert.match(ed.aboutLine(builtin, [b]), /^Built-in pack, read-only/);
  const copy = (v) => ({ builtin: false, pack: pack({ id: 'mine', from: { id: 'engagement-bait', version: v } }) });
  assert.equal(ed.aboutLine(copy(3), [b]), 'A copy of Engagement bait v3.');
  assert.equal(ed.aboutLine(copy(2), [b]), 'A copy of Engagement bait v2. The built-in is now at v3; nothing is merged into this copy.');
  assert.match(ed.aboutLine(copy(2), []), /engagement-bait v2\. That built-in pack is no longer shipped\.$/);
  assert.equal(ed.aboutLine({ builtin: false, index: 0, raw: {}, reason: 'Not a Papieren pack.' }, []),
    'Invalid: Not a Papieren pack. It is left out of filtering. Delete it, or fix its file and import it again.');
  assert.match(ed.aboutLine(undefined, []), /^Pick a pack/);
});

test('formOf and fromForm: an unchanged form saves nothing; a change bumps the version (Req 5.2)', () => {
  const p = pack({ id: 'mine', from: { id: 'engagement-bait', version: 3 } });
  const f = ed.formOf(p);
  assert.deepEqual(f.langs, [['en', '3 like if you agree\n2 /^rt if\\b/']]);
  assert.equal(f.any, '-3 account: gold\n2 emoji >= 5');
  assert.deepEqual(ed.fromForm(f, p), { ok: true, changed: false, pack: p });

  const r = ed.fromForm(form(p, { threshold: '4', any: `${f.any}\n1 bio: crypto # a note`, langs: [...f.langs, ['fr', '3 likez si'], ['de', '# nothing yet']] }), p);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.pack.version, 4);
  assert.equal(r.pack.threshold, 4);
  assert.deepEqual(r.pack.from, p.from, 'a copy keeps where it came from');
  assert.deepEqual(Object.keys(r.pack.languages), ['en', 'fr'], 'an empty language is dropped');
  assert.deepEqual(r.pack.tells.at(-1), { w: 1, on: 'bio', phrase: 'crypto' });
  assert.deepEqual(lib.validate(r.pack), { ok: true, pack: r.pack });
});

test('fromForm: a refusal names the box, the line and the reason, and saves nothing (Req 5.4)', () => {
  const p = pack({ id: 'mine' });
  const f = ed.formOf(p);
  const reason = (over) => {
    const r = ed.fromForm(form(p, over), p);
    assert.equal(r.ok, false);
    return r.reason;
  };
  assert.match(reason({ langs: [['en', '3 fine\n\n2 /(a+)+$/']] }), /^Language en, line 3: /);
  assert.match(reason({ langs: [['en', `1 /${'a'.repeat(201)}/`]] }), /^Language en, line 1: .*200/);
  assert.match(reason({ langs: [['en', '1 /(unclosed/']] }), /^Language en, line 1: /);
  assert.equal(reason({ any: '1 like if you agree' }), `Any language, line 1: ${lib.parseLines('1 like if you agree', 'any').reason}.`);
  assert.match(reason({ any: 'like if you agree' }), /^Any language, line 1: a tell starts with its weight/);
  assert.match(reason({ langs: [['en', '1 a'], ['en', '1 b']] }), /twice/);
  assert.match(reason({ langs: [['__proto__', '1 a']] }), /not a language code/);
  assert.match(reason({ threshold: '' }), /^threshold/);
  assert.match(reason({ name: ' ' }), /^name/);
  assert.match(reason({ langs: [['en', Array.from({ length: 301 }, (_, i) => `1 phrase ${i}`).join('\n')]] }), /300/);
  assert.equal(f.threshold, '6');
});

test('the seeded examples are comments, and every one parses once uncommented (Req 5.3)', () => {
  const p = ed.newPack([]);
  const f = ed.formOf(p);
  assert.deepEqual([f.any, f.langs], [ed.EXAMPLE_ANY, [['en', ed.EXAMPLE_TEXT]]]);
  assert.deepEqual(ed.fromForm(f, p), { ok: true, changed: false, pack: p }, 'saving the template unchanged changes nothing');
  const live = (text) => text.split('\n').filter((l) => /^# -?\d+ /.test(l)).map((l) => l.slice(2)).join('\n');
  const any = lib.parseLines(live(ed.EXAMPLE_ANY), 'any');
  const en = lib.parseLines(live(ed.EXAMPLE_TEXT), 'text');
  assert.deepEqual([any.ok, any.tells.length, en.ok, en.tells.length], [true, 8, true, 2]);
});

test('copyOf and placeCopy: a copy records its built-in and takes its place only when on (Req 5.1)', () => {
  const b = pack();
  const copy = ed.copyOf(b, ['engagement-bait', 'engagement-bait-copy']);
  assert.equal(copy.id, 'engagement-bait-copy-2');
  assert.equal(copy.name, 'Engagement bait (copy)');
  assert.deepEqual([copy.version, copy.from], [1, { id: 'engagement-bait', version: 3 }]);
  assert.deepEqual([copy.tells, copy.languages], [b.tells, b.languages]);
  assert.equal(lib.validate(copy, { builtinIds: [b.id] }).ok, true);
  assert.equal(ed.copyOf(pack({ name: 'x'.repeat(40) }), []).name, `${'x'.repeat(33)} (copy)`);
  assert.deepEqual(ed.placeCopy(['a', 'engagement-bait', 'b'], 'engagement-bait', 'c'), ['a', 'c', 'b']);
  assert.deepEqual(ed.placeCopy(['a'], 'engagement-bait', 'c'), ['a']);
});

test('newPack: the template, numbered past taken ids', () => {
  const p = ed.newPack([]);
  assert.deepEqual([p.id, p.name, p.kind, p.version, p.threshold, p.tells, p.languages], ['my-pack', 'My pack', 'junk', 1, 5, [], {}]);
  assert.deepEqual([ed.newPack(['my-pack', 'my-pack-2']).id, ed.newPack(['my-pack', 'my-pack-2']).name], ['my-pack-3', 'My pack 3']);
});

test('importPack and packFile: a bad file refused whole; export then import gives the same Pack under a free id (Req 6.1-6.3)', () => {
  const p = pack({ id: 'mine', from: { id: 'engagement-bait', version: 3 } });
  const file = ed.packFile(p);
  assert.equal(file.name, 'papieren-pack-mine.json');
  assert.equal(file.type, 'application/json');
  assert.deepEqual(ed.importPack(file.text, []), { ok: true, pack: p });
  assert.deepEqual(ed.importPack(file.text, ['mine', 'mine-2']).pack, { ...p, id: 'mine-3' });
  assert.equal(ed.importPack(ed.packFile(pack()).text, ['engagement-bait']).pack.id, 'engagement-bait-2', "a built-in's own file comes in as a pack of yours");

  const bad = JSON.parse(file.text);
  bad.languages.en.push({ w: 1, on: 'text', pattern: '(a+)+' });
  const r = ed.importPack(JSON.stringify(bad), []);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^languages\.en/);
  assert.equal(ed.importPack('{', []).reason, 'The file is not valid JSON.');
  assert.equal(ed.importPack(' '.repeat(lib.MAX_FILE + 1), []).reason, 'The file is larger than 256 KB.');
});

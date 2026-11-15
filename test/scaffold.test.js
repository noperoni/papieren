const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const libDir = path.join(root, 'src', 'lib');
const libs = fs.readdirSync(libDir).filter((f) => f.endsWith('.js'));

test('require() returns the namespace the lib registered on globalThis.Papieren', () => {
  const rules = require('../src/lib/rules.js');
  assert.equal(rules, globalThis.Papieren.rules);
});

test('all libs load as classic scripts in one shared global, as content scripts do', () => {
  const context = vm.createContext({});
  for (const file of libs) {
    vm.runInContext(fs.readFileSync(path.join(libDir, file), 'utf8'), context, { filename: file });
  }
  // One namespace per lib and nothing else leaked onto the global.
  assert.equal(Object.keys(context.Papieren).length, libs.length);
  assert.deepEqual(Object.keys(context), ['Papieren']);
});

test('every file the manifest names exists', () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
  }
});

test('every script the popup loads exists, records.js after memory.js', () => {
  const html = fs.readFileSync(path.join(root, manifest.action.default_popup), 'utf8');
  const dir = path.dirname(path.join(root, manifest.action.default_popup));
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of srcs) assert.ok(fs.existsSync(path.join(dir, src)), `missing ${src}`);
  // records.js reads globalThis.Papieren.memory at load.
  assert.ok(srcs.indexOf('../src/lib/memory.js') > -1 && srcs.indexOf('../src/lib/memory.js') < srcs.indexOf('../src/lib/records.js'));
});

test('permissions stay at storage plus the X hosts (Req 4.2, 4.4)', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://x.com/*', 'https://api.x.com/*']);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
});

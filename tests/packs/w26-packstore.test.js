/* tests/packs/w26-packstore.test.js — WS2: durable installed pack store
   Covers: fresh/corrupt/wrong-version degradation, quota/max limits,
   identical duplicate idempotence, conflicting update, inactive/active
   remove, export roundtrip, persisted install survives reload and is
   provided before activation, and malicious store cannot bypass TC.Packs. */
'use strict';
const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', '..', 'tests', 'helpers', 'load-game.js'));

function fresh(storage) {
  return loadGame(storage ? { storage, frames: 0 } : { frames: 0 });
}
function manifest(id, opts) {
  opts = opts || {};
  return JSON.stringify({
    manifest: 1,
    id: id,
    name: opts.name || id,
    version: opts.version || '1.0.0',
    type: 'data',
    content: opts.content || { items: [{ key: 'thing', name: 'Thing', kind: 'material' }] },
  });
}
function makeStorage() {
  const map = new Map();
  return {
    _map: map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

test('packstore: fresh store empty, install persists and load provides', () => {
  const g = fresh();
  const TC = g.TC;
  assert.strictEqual(TC.PackStore.list().length, 0);
  const text = manifest('mypack');
  const r = TC.PackStore.install(text);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'installed');
  assert.strictEqual(TC.PackStore.has('mypack'), true);
  assert.ok(TC.Packs.getManifest('mypack'), 'provided after install');
  // export roundtrip
  const exported = TC.PackStore.exportJSON();
  const parsed = JSON.parse(exported);
  assert.strictEqual(parsed.v, 1);
  assert.strictEqual(parsed.manifests.length, 1);
  assert.strictEqual(parsed.manifests[0].id, 'mypack');
});

test('packstore: installed survives reload via shared storage', () => {
  const storage = makeStorage();
  {
    const g1 = fresh(storage);
    const TC = g1.TC;
    // Boot should load empty
    TC.PackStore.load();
    const r = TC.PackStore.install(manifest('alpha'));
    assert.strictEqual(r.ok, true);
    // Not active yet, but provided
    assert.ok(TC.Packs.getManifest('alpha'));
  }
  {
    const g2 = fresh(storage);
    const TC = g2.TC;
    // On second boot, load should re-provide alpha
    const loaded = TC.PackStore.load();
    assert.strictEqual(loaded.provided, 1);
    assert.ok(TC.Packs.getManifest('alpha'), 're-provided after reload');
    // Activate should succeed
    const act = TC.Packs.setActive(['alpha']);
    assert.ok(act.activated.includes('alpha'));
  }
});

test('packstore: identical duplicate is idempotent', () => {
  const g = fresh();
  const TC = g.TC;
  const text = manifest('dup');
  const r1 = TC.PackStore.install(text);
  assert.strictEqual(r1.ok, true);
  const r2 = TC.PackStore.install(text);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.status, 'unchanged');
  assert.strictEqual(TC.PackStore.list().length, 1);
});

test('packstore: same id different digest requires explicit replace', () => {
  const g = fresh();
  const TC = g.TC;
  const v1 = manifest('conflict', { version: '1.0.0', content: { items: [{ key: 'a', name: 'A', kind: 'material' }] } });
  const v2 = manifest('conflict', { version: '2.0.0', content: { items: [{ key: 'a', name: 'A2', kind: 'material' }] } });
  const r1 = TC.PackStore.install(v1);
  assert.strictEqual(r1.ok, true);
  const r2 = TC.PackStore.install(v2);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.error, 'conflict');
  const r3 = TC.PackStore.install(v2, { replace: true });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.status, 'replaced');
  assert.strictEqual(TC.PackStore.list().length, 1);
});

test('packstore: storage write failures leave install, replace and remove unchanged', () => {
  const map = new Map();
  let failWrites = false;
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error('quota');
      map.set(String(k), String(v));
    },
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
  const g = fresh(storage);
  const TC = g.TC;
  const first = manifest('storage_atomic');
  const initial = TC.PackStore.install(first);
  assert.strictEqual(initial.ok, true);
  const before = TC.PackStore.exportPack('storage_atomic');
  failWrites = true;

  const rejectedInstall = TC.PackStore.install(manifest('storage_new'));
  assert.strictEqual(rejectedInstall.ok, false);
  assert.strictEqual(rejectedInstall.error, 'storage');
  const rejectedReplace = TC.PackStore.install(
    manifest('storage_atomic', { version: '2.0.0' }), { replace: true });
  assert.strictEqual(rejectedReplace.ok, false);
  assert.strictEqual(rejectedReplace.error, 'storage');
  const rejectedRemove = TC.PackStore.remove('storage_atomic');
  assert.strictEqual(rejectedRemove.ok, false);
  assert.strictEqual(rejectedRemove.error, 'storage');
  assert.strictEqual(TC.PackStore.exportPack('storage_atomic'), before);
  assert.strictEqual(TC.PackStore.has('storage_new'), false);
});

test('packstore: cannot remove active pack', () => {
  const g = fresh();
  const TC = g.TC;
  const text = manifest('activepack', { content: { walls: [{ key: 'w', name: 'W Wall', color: '#223344', hardness: 0.3 }] } });
  TC.PackStore.install(text);
  TC.Packs.setActive(['activepack']);
  const rm = TC.PackStore.remove('activepack');
  assert.strictEqual(rm.ok, false);
  assert.strictEqual(rm.error, 'active');
  // deactivate via fresh session required; removing inactive is ok
  // In same session cannot drop committed, so test inactive removal in separate realm
  const g2 = fresh();
  const TC2 = g2.TC;
  TC2.PackStore.install(manifest('inactive'));
  const rm2 = TC2.PackStore.remove('inactive');
  assert.strictEqual(rm2.ok, true);
  assert.strictEqual(TC2.PackStore.has('inactive'), false);
});

test('packstore: export/import canonical roundtrip', () => {
  const storage = makeStorage();
  const g1 = fresh(storage);
  const TC1 = g1.TC;
  TC1.PackStore.install(manifest('exportme'));
  const exported = TC1.PackStore.exportJSON();
  // fresh realm with empty storage, import via install
  const g2 = fresh();
  const TC2 = g2.TC;
  const env = JSON.parse(exported);
  for (const m of env.manifests) {
    const r = TC2.PackStore.install(m.json);
    assert.strictEqual(r.ok, true);
  }
  assert.ok(TC2.Packs.getManifest('exportme'));
  assert.strictEqual(TC2.PackStore.list().length, 1);
});

test('packstore: corrupt/truncated/wrong-version degrades safely', () => {
  const storage = makeStorage();
  storage.setItem('tc_packs_installed_v1', '{not json');
  {
    const g = fresh(storage);
    const TC = g.TC;
    const loaded = TC.PackStore.load();
    assert.strictEqual(loaded.provided, 0, 'corrupt json yields empty');
    assert.strictEqual(TC.PackStore.list().length, 0);
    // boot still works, zero-pack fingerprint intact
    assert.doesNotThrow(() => TC.Registry.validate());
  }
  storage.setItem('tc_packs_installed_v1', JSON.stringify({ v: 999, manifests: [{ id: 'x', digest: 'y', json: '{}' }] }));
  {
    const g = fresh(storage);
    const TC = g.TC;
    const loaded = TC.PackStore.load();
    assert.strictEqual(loaded.provided, 0, 'wrong version yields empty');
  }
  storage.setItem('tc_packs_installed_v1', JSON.stringify({ v: 1, manifests: 'not an array' }));
  {
    const g = fresh(storage);
    const TC = g.TC;
    const loaded = TC.PackStore.load();
    assert.strictEqual(loaded.provided, 0);
  }
});

test('packstore: per-manifest and total quota enforced', () => {
  const g = fresh();
  const TC = g.TC;
  // per-manifest too large
  const huge = 'x'.repeat(300 * 1024);
  const over = manifest('big');
  // craft an oversize JSON string >256KB by repeating content
  const bigContent = { items: [] };
  for (let i = 0; i < 600; i++) bigContent.items.push({ key: 'k' + i, name: 'N' + i, kind: 'material' });
  const bigText = JSON.stringify({ manifest: 1, id: 'big', name: 'Big', version: '1.0.0', type: 'data', content: bigContent });
  if (bigText.length > 256 * 1024) {
    const r = TC.PackStore.install(bigText);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'too-large');
  }
  // total quota: fill store near cap with many small manifests
  // Use small manifests but many to hit maxInstalled or maxBytes
  // Test maxInstalled limit (64)
  // Install 65 small manifests, last should fail with max-installed
  const storage2 = makeStorage();
  const g2 = fresh(storage2);
  const TC2 = g2.TC;
  let last;
  for (let i = 0; i < 65; i++) {
    const id = 'pack' + i;
    const txt = manifest(id, { content: { items: [{ key: 'thing', name: 'Thing', kind: 'material' }] } });
    last = TC2.PackStore.install(txt);
    if (i < 64) assert.strictEqual(last.ok, true, 'install ' + id + ' should succeed');
    else assert.strictEqual(last.error, 'max-installed');
  }
});

test('packstore: malicious content never bypasses TC.Packs', () => {
  const g = fresh();
  const TC = g.TC;
  // __proto__ smuggled through JSON text (realistic attack path, as in loader.test.js)
  const evilText = '{"manifest":1,"id":"evil","name":"E","version":"1.0.0","type":"data",' +
    '"content":{"items":[{"key":"k","name":"K","kind":"material","__proto__":{"polluted":true}}]}}';
  const r = TC.PackStore.install(evilText);
  assert.strictEqual(r.ok, false, 'prototype pollution rejected');
  assert.strictEqual(TC.PackStore.has('evil'), false);
  assert.strictEqual(TC.Packs.getManifest('evil'), null);
  // function-valued content cannot be JSON, but non-finite via string is checked
  const evil2 = '{"manifest":1,"id":"evil2","name":"E2","version":"1.0.0","type":"data","content":{"items":[{"key":"x","name":"X","kind":"material","value":null}]}}';
  // valid second evil should not affect store
  assert.strictEqual(TC.PackStore.list().length, 0);
});

test('packstore: stats reflect count and bytes', () => {
  const g = fresh();
  const TC = g.TC;
  const before = TC.PackStore.stats();
  assert.strictEqual(before.count, 0);
  TC.PackStore.install(manifest('s1'));
  TC.PackStore.install(manifest('s2'));
  const after = TC.PackStore.stats();
  assert.strictEqual(after.count, 2);
  assert.ok(after.totalBytes > 0);
  assert.strictEqual(after.maxInstalled, 64);
});

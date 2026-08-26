/* tests/packs/loader.test.js — MOD-001/002 fail-closed boundary: manifests
   are UNTRUSTED INPUT. Every structural/schema/security rejection must leave
   zero live mutation, and equivalent data must produce identical identity
   regardless of key order or provide order. */
'use strict';
const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', '..', 'tests', 'helpers', 'load-game.js'));

function fresh() {
  const g = loadGame({ frames: 0 });
  return g.TC;
}

function goodManifest(over) {
  const m = Object.assign({
    manifest: 1,
    id: 'goodpack',
    name: 'Good Pack',
    version: '1.0.0',
    type: 'data',
    content: {
      items: [{ key: 'good_gem', name: 'Good Gem', kind: 'material', value: 5 }],
    },
  }, over || {});
  if (over && over.content === null) delete m.content; // explicit no-content
  return m;
}

// Resource-flavored manifest without the default data content.
function resourceManifest(over) {
  return goodManifest(Object.assign({ content: null }, over || {}));
}

test('loader: valid manifest provides idempotently; same id different content rejects', () => {
  const TC = fresh();
  TC.Packs.provide(goodManifest());
  const before = TC.Packs.available().length;
  TC.Packs.provide(goodManifest()); // identical -> idempotent
  assert.strictEqual(TC.Packs.available().length, before);
  assert.throws(() => TC.Packs.provide(goodManifest({ version: '2.0.0' })),
    /already provided/, 'changed content under same id rejected');
});

test('loader: malformed JSON and oversize input reject without state change', () => {
  const TC = fresh();
  const before = TC.Packs.stats();
  assert.throws(() => TC.Packs.provideJSON('{not json'), /malformed pack JSON/i);
  assert.throws(() => TC.Packs.provideJSON(''), /non-empty/);
  assert.throws(() => TC.Packs.provideJSON('x'.repeat(300 * 1024)), /exceeds/);
  assert.throws(() => TC.Packs.provideJSON('null'), /manifest/);
  const after = TC.Packs.stats();
  assert.strictEqual(after.providedCount, before.providedCount);
  assert.strictEqual(after.committedEntries, before.committedEntries);
  assert.strictEqual(after.rejectedJson - before.rejectedJson, 4,
    'every rejected payload is counted for diagnostics');
});

test('loader: structural rejections (missing/bad fields, unknown versions)', () => {
  const TC = fresh();
  // a manifest WITHOUT a content key (undefined values are rejected by scan)
  const bare = goodManifest({ id: 'self', requires: { packs: { self: '^1.0.0' } }, content: null });
  const cases = [
    [goodManifest({ manifest: 2 }), /unsupported manifest schema/],
    [goodManifest({ id: 'BadID' }), /id must match/],
    [goodManifest({ id: 'a' }), /id must match/],           // too short
    [goodManifest({ id: 'x'.repeat(40) }), /id must match/], // too long
    [goodManifest({ version: '1.2.x' }), /version must be dotted/],
    [goodManifest({ version: '1.2.3.4' }), /version must be dotted/],
    [goodManifest({ type: 'code' }), /type must be/],
    [bare, /depend on itself|declares neither content nor resources/],
    [goodManifest({ resources: { locale: { 'bad locale!': {} } } }), /bad locale id/],
    [goodManifest({ content: { items: [] }, type: 'resource' }), /resource packs cannot declare gameplay content/],
    [goodManifest({ content: { warpDrive: [] } }), /unknown content family/],
    [goodManifest({ extraField: 1 }), /invalid manifest/],
  ];
  for (const [m, re] of cases) {
    assert.throws(() => TC.Packs.provide(m), re, JSON.stringify(m).slice(0, 60));
  }
});

test('loader: security scan rejects prototype pollution, functions, non-finites', () => {
  const TC = fresh();
  // __proto__ smuggled through JSON parse (the realistic attack path)
  const evil = JSON.parse('{"manifest":1,"id":"evil1","name":"E","version":"1.0.0","type":"data",' +
    '"content":{"items":[{"key":"k","name":"K","kind":"material","__proto__":{"polluted":true}}]}}');
  assert.throws(() => TC.Packs.provide(evil), /forbidden key|prototype/);
  // constructor / prototype keys anywhere
  assert.throws(() => TC.Packs.provide(goodManifest({
    content: { items: [{ key: 'k2', name: 'K', kind: 'material', constructor: {} }] },
  })), /forbidden key/);
  // function-valued fields (programmatic provide path)
  assert.throws(() => TC.Packs.provide(goodManifest({
    content: { items: [{ key: 'k3', name: 'K', kind: 'material', damage: () => 1 }] },
  })), /unsupported value type/);
  // non-finite numbers
  assert.throws(() => TC.Packs.provide(goodManifest({
    content: { items: [{ key: 'k4', name: 'K', kind: 'material', value: NaN }] },
  })), /non-finite/);
  assert.throws(() => TC.Packs.provide(goodManifest({
    content: { items: [{ key: 'k5', name: 'K', kind: 'material', value: Infinity }] },
  })), /non-finite/);
  // depth bomb
  let deep = { key: 'k6', name: 'K', kind: 'material' };
  deep.meta = {};
  let cur = deep.meta;
  for (let i = 0; i < 30; i++) { cur.next = {}; cur = cur.next; }
  assert.throws(() => TC.Packs.provide(goodManifest({ content: { items: [deep] } })), /nesting deeper/);
});

test('loader: reserved namespaces cannot be hijacked', () => {
  const TC = fresh();
  for (const id of ['core', 'tc', 'system']) {
    assert.throws(() => TC.Packs.provide(goodManifest({ id })),
      /reserved namespace/, 'ns ' + id + ' protected');
  }
});

test('loader: resource-path traversal and malformed paths reject', () => {
  const TC = fresh();
  const mk = (f) => resourceManifest({
    id: 'res' + Math.abs(f.length * 31 % 9973),
    resources: { files: Array.isArray(f) ? f : [f] },
  });
  for (const bad of ['../evil.png', '/abs/path.png', 'a\\b.png', 'a/../b.png',
    './rel.png', 'http://x/y.png', 'C:/x.png']) {
    assert.throws(() => TC.Packs.provide(mk(bad)),
      /pack resource root|path string/, 'traversal rejected: ' + bad);
  }
  TC.Packs.provide(mk('gfx/deep/name-1.file.png')); // clean path accepted
});

test('loader: schema bounds on family entries and values (activation-time)', () => {
  const TC = fresh();
  // Family schemas need the live registries, so they enforce at STAGING
  // (setActive) — provide() alone accepts structurally-shaped manifests.
  function expectStageReject(manifest, re) {
    TC.Packs.provide(manifest);
    assert.throws(() => TC.Packs.setActive([manifest.id]), re,
      JSON.stringify(manifest).slice(0, 80));
  }
  const manyItems = [];
  for (let i = 0; i < 257; i++) manyItems.push({ key: 'it' + i, name: 'I', kind: 'material' });
  // family SIZE caps are structural (manifest shape) -> provide-time
  assert.throws(() => TC.Packs.provide(goodManifest({ id: 'big', content: { items: manyItems } })),
    /exceeds 256 entries/);
  expectStageReject(goodManifest({ id: 'dmg', content: {
    items: [{ key: 'w', name: 'W', kind: 'weapon', damage: 99999 }] } }), /damage must be/);
  expectStageReject(goodManifest({ id: 'hp', content: {
    enemies: [{ key: 'e', name: 'E', hp: -5, dmg: 1, ai: 'slime' }] } }), /hp must be/);
  expectStageReject(goodManifest({ id: 'bossai', content: {
    enemies: [{ key: 'e2', name: 'E', hp: 10, dmg: 1, ai: 'king_slime' }] } }), /boss machinery/);
  expectStageReject(goodManifest({ id: 'ghostai', content: {
    enemies: [{ key: 'e3', name: 'E', hp: 10, dmg: 1, ai: 'does_not_exist' }] } }),
    /not a registered built-in behavior/);
  expectStageReject(goodManifest({ id: 'torchpat', content: {
    tiles: [{ key: 't', name: 'T', pattern: 'torch', colors: ['#123456'] }] } }),
    /inert built-in painter/);
  expectStageReject(goodManifest({ id: 'badcolor', content: {
    tiles: [{ key: 't2', name: 'T', colors: ['#12345', '#222222'] }] } }), /#rrggbb/);
  expectStageReject(goodManifest({ id: 'station', content: {
    recipes: [{ rid: 'r1', out: 'stone', cost: { dirt: 1 }, station: 'no_such_station' }] } }),
    /station/);
  expectStageReject(goodManifest({ id: 'ghosting', content: {
    recipes: [{ rid: 'r2', out: 'stone', cost: { no_item_xyz: 1 } }] } }), /does not resolve/);
  expectStageReject(goodManifest({ id: 'zerocost', content: {
    recipes: [{ rid: 'r3', out: 'stone', cost: { dirt: 0 } }] } }), /cost amount/);
  // unknown privileged fields inside entries are named, not silently dropped
  expectStageReject(goodManifest({ id: 'priv', content: {
    items: [{ key: 'privk', name: 'P', kind: 'material', secretHook: {} }] } }), /unknown field/);
});

test('identity: canonical digests are order-independent; different data differs', () => {
  const TC = fresh();
  // Same logical data built with different key insertion orders.
  const a = resourceManifest({ id: 'ord', name: 'O', type: 'resource',
    resources: { locale: { en: { ui: { a: 'A' }, z: 'Z' } } } });
  const c = {}; // reverse construction order, identical logical data
  c.resources = { locale: { en: { z: 'Z', ui: { a: 'A' } } } };
  c.type = 'resource'; c.version = '1.0.0'; c.name = 'O'; c.id = 'ord';
  c.manifest = 1;
  const ra = TC.Packs.provide(a);
  assert.strictEqual(ra.rawDigest,
    TC.Packs.provide(JSON.parse(JSON.stringify(c))).rawDigest,
    'key insertion order irrelevant after canonicalization');
  // any content change -> different digest (new id: same-id re-provides with
  // changed content are rejected as duplicates)
  const rd = TC.Packs.provide(resourceManifest({ id: 'ord2', name: 'O',
    resources: { locale: { en: { ui: { a: 'A!' }, z: 'Z' } } } }));
  assert.notStrictEqual(rd.rawDigest, ra.rawDigest, 'changed data changes identity');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadGame } = require(path.join(__dirname, '..', '..', 'tests', 'helpers', 'load-game.js'));

function fresh() {
  return loadGame({ frames: 0 }).TC;
}

function manifest(id, over) {
  return Object.assign({
    manifest: 1,
    id,
    name: id,
    version: '1.0.0',
    type: 'data',
    content: { items: [{ key: id + '_item', name: id, kind: 'material' }] },
  }, over || {});
}

function betaManifest(over) {
  return manifest('beta', Object.assign({
    content: {
      items: [{ key: 'shared', name: 'Shared', kind: 'material' }],
      walls: [{ key: 'beta_wall', name: 'Beta Wall', color: '#334455', hardness: 0.4 }],
      lootTables: [{
        key: 'common',
        name: 'Common',
        entries: [{ id: 'beta:shared', min: 1, max: 1, chance: 1 }],
      }],
      enemies: [{
        key: 'beta_enemy', name: 'Beta Enemy', hp: 10, dmg: 1, ai: 'slime',
        w: 24, h: 24, lootTable: 'beta:common',
      }],
      spawnRules: [{ enemy: 'beta:beta_enemy', zone: 'day', weight: 1 }],
    },
  }, over || {}));
}

function alphaManifest(over) {
  return manifest('alpha', Object.assign({
    optional: { packs: { beta: '>=1.2 <2' } },
    content: {
      items: [{ key: 'alpha_item', name: 'Alpha Item', kind: 'material' }],
      recipes: [{ rid: 'use_shared', out: 'beta:shared', cost: { stone: 1 } }],
    },
  }, over || {}));
}

function snapshot(TC) {
  return {
    active: TC.Packs.active(),
    registry: TC.Registry.fingerprint(),
    gameplay: TC.Packs.digest(),
    content: TC.Packs.contentDigest(),
    save: TC.Packs.saveMetadata(),
    items: Object.keys(TC.ITEM_DEFS),
    enemies: Object.keys(TC.ENEMY_DEFS),
    recipes: TC.RECIPES,
    walls: TC.WALL_DEFS,
    spawn: TC.Packs.getSpawnRules(),
    localization: TC.Localization.stats(),
  };
}

test('optional metadata schema fails closed without mutating provided state', () => {
  const TC = fresh();
  const before = TC.Packs.available().length;
  const cases = [
    manifest('unknown', { optional: { packs: {}, magicMode: true } }),
    manifest('badid', { optional: { packs: { BAD: '^1.0.0' } } }),
    manifest('selfop', { optional: { packs: { selfop: '^1.0.0' } } }),
    manifest('badrange', { optional: { packs: { beta: 'not-a-range' } } }),
  ];
  const tooMany = {};
  for (let i = 0; i < 17; i++) tooMany['dep' + String(i).padStart(2, '0')] = '^1.0.0';
  cases.push(manifest('manyopt', { optional: { packs: tooMany } }));
  for (const value of ['__proto__', 'prototype', 'constructor']) {
    const payload = JSON.parse('{"manifest":1,"id":"polluted","name":"P","version":"1.0.0","type":"data",' +
      '"optional":{"packs":{"' + value + '":"^1.0.0"}},"content":{"items":[]}}');
    cases.push(payload);
  }
  for (const value of cases) {
    assert.throws(() => TC.Packs.provide(value), /invalid manifest|forbidden key|prototype/);
  }
  assert.strictEqual(TC.Packs.available().length, before);
  assert.strictEqual(TC.Packs.getManifest('unknown'), null);
});

test('installed optional source stays inactive and identity-neutral', () => {
  const control = fresh();
  control.Packs.provide(alphaManifest({ content: { items: [{ key: 'alpha_item', name: 'Alpha Item', kind: 'material' }] } }));
  control.Packs.setActive(['alpha']);

  const TC = fresh();
  const alpha = alphaManifest({ content: { items: [{ key: 'alpha_item', name: 'Alpha Item', kind: 'material' }] } });
  assert.strictEqual(TC.PackStore.install(JSON.stringify(alpha)).ok, true);
  assert.strictEqual(TC.PackStore.install(JSON.stringify(betaManifest())).ok, true);
  TC.Packs.setActive(['alpha']);

  assert.strictEqual(TC.Packs.isActive('beta'), false);
  assert.strictEqual(TC.Registry.has('enemy', 'beta:beta_enemy'), false);
  assert.strictEqual(TC.Packs.getSpawnRules().length, 0);
  assert.strictEqual(TC.Packs.digest(), control.Packs.digest());
  assert.strictEqual(TC.Packs.contentDigest(), control.Packs.contentDigest());
  assert.strictEqual(TC.Registry.fingerprint(), control.Registry.fingerprint());
  assert.strictEqual(JSON.stringify(TC.Packs.saveMetadata()), JSON.stringify(control.Packs.saveMetadata()));
  assert.strictEqual(TC.PackStore.has('beta'), true);
});

test('compatible active optional dependency orders first and resolves references', () => {
  const TC = fresh();
  TC.Packs.provide(alphaManifest());
  TC.Packs.provide(betaManifest({ version: '1.5.0' }));
  const result = TC.Packs.setActive(['alpha', 'beta']);
  assert.strictEqual(result.activated.join(','), 'beta,alpha');
  const recipe = TC.RECIPES.find((entry) => entry.out === 'shared');
  assert.ok(recipe);
  assert.strictEqual(recipe.out, 'shared');
});

test('incompatible active optional dependency rejects before mutation', () => {
  const TC = fresh();
  const before = snapshot(TC);
  TC.Packs.provide(alphaManifest({ optional: { packs: { beta: '>=2 <3' } } }));
  TC.Packs.provide(betaManifest({ version: '1.5.0' }));
  assert.throws(() => TC.Packs.setActive(['alpha', 'beta']), /incompatible optional dependency version/);
  assert.deepStrictEqual(snapshot(TC), before);
});

test('reference to inactive optional dependency fails without auto-activation', () => {
  const TC = fresh();
  TC.Packs.provide(alphaManifest());
  TC.Packs.provide(betaManifest({ version: '1.5.0' }));
  assert.throws(() => TC.Packs.setActive(['alpha']), /does not resolve/);
  assert.strictEqual(TC.Packs.active().length, 0);
  assert.strictEqual(TC.Registry.has('item', 'beta:shared'), false);
  assert.strictEqual(TC.Packs.setActive(['alpha', 'beta']).activated.join(','), 'beta,alpha');
});

test('optional graph order and compiled identity ignore provide and request order', () => {
  const first = fresh();
  first.Packs.provide(alphaManifest());
  first.Packs.provide(betaManifest({ version: '1.5.0' }));
  first.Packs.setActive(['alpha', 'beta']);

  const second = fresh();
  second.Packs.provide(betaManifest({ version: '1.5.0' }));
  second.Packs.provide(alphaManifest());
  second.Packs.setActive(['beta', 'alpha']);

  assert.strictEqual(first.Packs.active().join(','), second.Packs.active().join(','));
  assert.strictEqual(first.Registry.fingerprint(), second.Registry.fingerprint());
  assert.strictEqual(first.Packs.digest(), second.Packs.digest());
  assert.strictEqual(first.Packs.contentDigest(), second.Packs.contentDigest());
  assert.strictEqual(JSON.stringify(first.Packs.saveMetadata()), JSON.stringify(second.Packs.saveMetadata()));
  assert.strictEqual(JSON.stringify(first.Packs.getSpawnRules()), JSON.stringify(second.Packs.getSpawnRules()));
  assert.strictEqual(JSON.stringify(first.WALL_DEFS), JSON.stringify(second.WALL_DEFS));
  assert.strictEqual(
    JSON.stringify(first.LootTables.rollById('beta:common', { rng: () => 0.5 })),
    JSON.stringify(second.LootTables.rollById('beta:common', { rng: () => 0.5 })),
  );
});

test('equivalent compound range spellings share canonical pack identity', () => {
  const first = fresh();
  first.Packs.provide(alphaManifest({ optional: { packs: { beta: '<2 >=1.2' } } }));
  first.Packs.provide(betaManifest({ version: '1.5.0' }));
  first.Packs.setActive(['alpha', 'beta']);

  const second = fresh();
  second.Packs.provide(alphaManifest({ optional: { packs: { beta: ' >=1.2   <2 ' } } }));
  second.Packs.provide(betaManifest({ version: '1.5.0' }));
  second.Packs.setActive(['beta', 'alpha']);

  assert.strictEqual(first.Packs.digest(), second.Packs.digest());
  assert.strictEqual(first.Packs.contentDigest(), second.Packs.contentDigest());
  assert.strictEqual(first.Registry.fingerprint(), second.Registry.fingerprint());
  assert.strictEqual(JSON.stringify(first.Packs.saveMetadata()), JSON.stringify(second.Packs.saveMetadata()));
});

test('anchored compound ranges remain valid after canonicalization', () => {
  for (const range of ['^1.2 <2', '1.2 <2']) {
    const TC = fresh();
    TC.Packs.provide(alphaManifest({ optional: { packs: { beta: range } } }));
    TC.Packs.provide(betaManifest({ version: range[0] === '^' ? '1.5.0' : '1.2.0' }));
    const result = TC.Packs.setActive(['alpha', 'beta']);
    assert.strictEqual(result.activated.join(','), 'beta,alpha');
  }
});

test('active cross-pack references still require an explicit dependency', () => {
  const TC = fresh();
  TC.Packs.provide(manifest('adep', {
    content: { items: [{ key: 'shared', name: 'Shared', kind: 'material' }] },
  }));
  TC.Packs.provide(manifest('zuser', {
    content: { recipes: [{ rid: 'undeclared', out: 'adep:shared', cost: { stone: 1 } }] },
  }));
  assert.throws(() => TC.Packs.setActive(['zuser', 'adep']), /requires declared dependency/);
  assert.strictEqual(TC.Registry.has('item', 'adep:shared'), false);
  assert.strictEqual(TC.Packs.active().length, 0);
});

test('numeric active cross-pack references still require a declared dependency', () => {
  const TC = fresh();
  TC.Packs.provide(manifest('adep', {
    content: { tiles: [{ key: 'shared', name: 'Shared', pattern: 'speckle', colors: ['#123456'] }] },
  }));
  TC.Packs.setActive(['adep']);
  const numeric = TC.Registry.stableToIndex('tile', 'adep:shared');
  TC.Packs.provide(manifest('zuser', {
    content: { items: [{ key: 'numeric_block', name: 'Numeric Block', kind: 'block', tile: numeric }] },
  }));
  assert.throws(() => TC.Packs.setActive(['adep', 'zuser']), /requires declared dependency/);
  assert.strictEqual(TC.Packs.isActive('zuser'), false);
});

test('active optional dependency cycles fail closed', () => {
  const TC = fresh();
  TC.Packs.provide(manifest('cycle_a', {
    optional: { packs: { cycle_b: '^1.0.0' } },
  }));
  TC.Packs.provide(manifest('cycle_b', {
    optional: { packs: { cycle_a: '^1.0.0' } },
  }));
  assert.throws(() => TC.Packs.setActive(['cycle_b', 'cycle_a']), /dependency cycle/);
  assert.strictEqual(TC.Packs.active().length, 0);
});

test('optional reference failure leaves every committed family unchanged', () => {
  const TC = fresh();
  TC.Packs.provide({
    manifest: 1, id: 'base', name: 'Base', version: '1.0.0', type: 'data',
    content: {
      items: [{ key: 'base_item', name: 'Base Item', kind: 'material' }],
      walls: [{ key: 'base_wall', name: 'Base Wall', color: '#223344', hardness: 0.3 }],
      lootTables: [{
        key: 'base_loot', name: 'Base Loot',
        entries: [{ id: 'base:base_item', min: 1, max: 1, chance: 1 }],
      }],
      enemies: [{ key: 'base_enemy', name: 'Base Enemy', hp: 10, dmg: 1, ai: 'slime', w: 24, h: 24, lootTable: 'base:base_loot' }],
      spawnRules: [{ enemy: 'base:base_enemy', zone: 'day', weight: 1 }],
    },
  });
  TC.Packs.setActive(['base']);
  const before = snapshot(TC);
  TC.Packs.provide(betaManifest({ id: 'zzbeta', version: '1.5.0' }));
  TC.Packs.provide({
    manifest: 1, id: 'zzalpha', name: 'ZZ Alpha', version: '1.0.0', type: 'data',
    optional: { packs: { zzbeta: '>=1.2 <2' } },
    content: {
      items: [{ key: 'zz_item', name: 'ZZ Item', kind: 'material' }],
      walls: [{ key: 'zz_wall', name: 'ZZ Wall', color: '#556677', hardness: 0.5 }],
      lootTables: [{
        key: 'zz_loot', name: 'ZZ Loot',
        entries: [{ id: 'zzalpha:zz_item', min: 1, max: 1, chance: 1 }],
      }],
      enemies: [{ key: 'zz_enemy', name: 'ZZ Enemy', hp: 8, dmg: 1, ai: 'slime', w: 24, h: 24 }],
      spawnRules: [{ enemy: 'zzalpha:zz_enemy', zone: 'day', weight: 1 }],
      recipes: [{ rid: 'bad_optional_ref', out: 'zzbeta:shared', cost: { stone: 1 } }],
    },
  });
  assert.throws(() => TC.Packs.setActive(['base', 'zzalpha']), /does not resolve/);
  assert.deepStrictEqual(snapshot(TC), before);
  assert.strictEqual(TC.Packs.isActive('zzalpha'), false);
});

test('adding a previously absent optional dependency requires a fresh session', () => {
  const TC = fresh();
  TC.Packs.provide(alphaManifest({
    content: { items: [{ key: 'alpha_item', name: 'Alpha Item', kind: 'material' }] },
  }));
  TC.Packs.provide(betaManifest({ version: '1.5.0' }));
  TC.Packs.setActive(['alpha']);
  assert.throws(() => TC.Packs.setActive(['alpha', 'beta']), /fresh session/);
  assert.strictEqual(TC.Packs.active().join(','), 'alpha');
  assert.strictEqual(TC.Registry.has('item', 'beta:shared'), false);
});

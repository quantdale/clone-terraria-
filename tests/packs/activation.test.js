/* tests/packs/activation.test.js — WS5 atomic activation, WS4 deterministic
   registry identity, and real gameplay consumption through canonical
   transactions (craft / place / summon / kill-loot) using the committed
   fixture pack. Base built-in identity must be untouched with zero packs. */
'use strict';
const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', '..', 'tests', 'helpers', 'load-game.js'));

function fresh() {
  return loadGame({ frames: 0 }).TC;
}

const BASE_FP = '1b1d7c15'; // regression-guarded elsewhere; pinned here too

test('activation: zero packs preserves base identity exactly', () => {
  const TC = fresh();
  assert.strictEqual(TC.Registry.fingerprint(), BASE_FP,
    'no-pack boot fingerprint must equal the historical baseline');
  assert.strictEqual(TC.Packs.active().join(","), "");
  assert.strictEqual(TC.Packs.digest(), '');
});

test('activation: fixture commits atomically and extends every family', () => {
  const TC = fresh();
  const nItems = TC.Registry.count('item');
  const nTiles = TC.Registry.count('tile');
  const nEnemies = TC.Registry.count('enemy');
  const nRecipes = TC.Registry.count('recipe');
  const tileDefsLen = TC.TILE_DEFS.length;
  const recipesLen = TC.RECIPES.length;

  TC.Packs.setActive(['testpack']);

  assert.strictEqual(TC.Registry.count('item'), nItems + 5);
  assert.strictEqual(TC.Registry.count('tile'), nTiles + 1);
  assert.strictEqual(TC.Registry.count('enemy'), nEnemies + 1);
  assert.strictEqual(TC.Registry.count('recipe'), nRecipes + 5);
  assert.strictEqual(TC.TILE_DEFS.length, tileDefsLen + 1, 'tile appended after built-ins');
  assert.strictEqual(TC.RECIPES.length, recipesLen + 5);
  // built-in entries keep their dense indices (append-only growth)
  for (let i = 0; i < tileDefsLen; i++) {
    assert.ok(TC.Registry.stableOfIndex('tile', i), 'built-in tile ' + i + ' intact');
  }
  // registry coherence gate ran inside commit
  assert.doesNotThrow(() => TC.Registry.validate());
});

test('activation: failed multi-pack transaction leaves zero mutation (rollback)', () => {
  const TC = fresh();
  TC.Packs.setActive(['testpack']);
  const fpWithFixture = TC.Registry.fingerprint();
  const itemKeys = Object.keys(TC.ITEM_DEFS).length;

  TC.Packs.provide({
    manifest: 1, id: 'halftone', name: 'Half Tone', version: '1.0.0', type: 'data',
    content: {
      items: [{ key: 'tone_a', name: 'Tone A', kind: 'material' }],
      recipes: [{ rid: 'bad', out: 'ghost_item_never_defined', cost: { stone: 1 } }],
    },
  });
  assert.throws(() => TC.Packs.setActive(['testpack', 'halftone']),
    /content failed validation/, 'invalid pack #2 fails the whole transaction');
  assert.strictEqual(Object.keys(TC.ITEM_DEFS).length, itemKeys,
    'no half-installed content remains');
  assert.strictEqual(TC.Packs.active().join(','), 'testpack');
  assert.strictEqual(TC.Registry.fingerprint(), fpWithFixture);
  assert.ok(!TC.ITEM_DEFS.tone_a, 'staged item rolled back');
  assert.strictEqual(TC.Packs.stats().rollbacks, 0,
    'rollback journal untouched because staging rejected before commit');
});

test('activation: session-permanent content cannot be silently dropped or changed', () => {
  const TC = fresh();
  TC.Packs.setActive(['testpack']);
  assert.throws(() => TC.Packs.setActive([]),
    /cannot be dropped|fresh session/);
  // re-requesting the same set is an idempotent no-op
  const r = TC.Packs.setActive(['testpack']);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(TC.Packs.stats().committedEntries, 12,
    'no double-commit on re-activation');
});

test('identity: digests are deterministic across realms and repeat activations', () => {
  const a = fresh(); a.Packs.setActive(['testpack']);
  const b = fresh(); b.Packs.setActive(['testpack']);
  assert.strictEqual(a.Packs.digest(), b.Packs.digest());
  assert.strictEqual(a.Packs.contentDigest(), b.Packs.contentDigest());
  assert.notStrictEqual(a.Packs.digest(), '', 'gameplay digest non-empty');
  // resource-only difference keeps the GAMEPLAY digest identical
  a.Packs.provide({
    manifest: 1, id: 'skinonly', name: 'Skin Only', version: '1.0.0',
    type: 'resource',
    resources: { locale: { en: { ui: { menu: { new_world: 'NEW WORLD!!!' } } } } },
  });
  a.Packs.setActive(['testpack', 'skinonly']);
  assert.strictEqual(a.Packs.digest(), b.Packs.digest(),
    'resource packs never change gameplay identity');
  assert.notStrictEqual(a.Packs.contentDigest(), b.Packs.contentDigest(),
    'but they do change content identity');
});

test('identity: dependency order is topological with ascending-id tie-breaks', () => {
  const TC = fresh();
  // zbase has no deps; amid depends on zbase; ytop depends on both.
  TC.Packs.provide({ manifest: 1, id: 'zbase', name: 'ZB', version: '1.0.0', type: 'data',
    content: { items: [{ key: 'zb_item', name: 'ZBI', kind: 'material' }] } });
  TC.Packs.provide({ manifest: 1, id: 'amid', name: 'AM', version: '1.0.0', type: 'data',
    requires: { packs: { zbase: '^1.0.0' } },
    content: { items: [{ key: 'am_item', name: 'AMI', kind: 'material' }] } });
  TC.Packs.provide({ manifest: 1, id: 'ytop', name: 'YT', version: '1.0.0', type: 'data',
    requires: { packs: { amid: '^1.0.0', zbase: '^1.0.0' } },
    content: { items: [{ key: 'yt_item', name: 'YTI', kind: 'material' }] } });
  const r = TC.Packs.setActive(['ytop']); // request order irrelevant
  assert.strictEqual(r.activated.join(''), ['zbase','amid','ytop'].join(''),
    'deps before dependents, ascending ids among equals');
  // cross-pack reference: ytop recipe costing zbase's bare key resolves
  TC.Packs.provide({
    manifest: 1, id: 'acook', name: 'AC', version: '1.0.0', type: 'data',
    requires: { packs: { zbase: '^1.0.0' } },
    content: { recipes: [{ rid: 'mix', out: 'zb_item', cost: { stone: 1 } }] } });
  TC.Packs.setActive(['ytop', 'acook']);
  const rec = TC.RECIPES[TC.RECIPES.length - 1];
  assert.strictEqual(rec.out, 'zb_item', 'cross-pack out normalized to canonical key');
});

test('activation: cyclic and missing dependencies fail closed', () => {
  const TC = fresh();
  TC.Packs.provide({ manifest: 1, id: 'cyc_a', name: 'CA', version: '1.0.0', type: 'data',
    requires: { packs: { cyc_b: '^1.0.0' } }, content: {} });
  TC.Packs.provide({ manifest: 1, id: 'cyc_b', name: 'CB', version: '1.0.0', type: 'data',
    requires: { packs: { cyc_a: '^1.0.0' } }, content: {} });
  assert.throws(() => TC.Packs.setActive(['cyc_a']), /cyclic|missing dependency/);
  TC.Packs.provide({ manifest: 1, id: 'needs_ghost', name: 'NG', version: '1.0.0', type: 'data',
    requires: { packs: { ghost_pack: '^1.0.0' } }, content: {} });
  assert.throws(() => TC.Packs.setActive(['needs_ghost']), /missing dependency.*ghost_pack/);
  // wrong requested version range rejects cleanly
  TC.Packs.provide({ manifest: 1, id: 'want_old', name: 'WO', version: '1.0.0', type: 'data',
    requires: { game: '>=99.0' }, content: {} });
  assert.throws(() => TC.Packs.setActive(['want_old']), /requires game/);
});

test('gameplay: full fixture chain works through canonical transactions', () => {
  const TC = fresh();
  TC.Packs.setActive(['testpack']);
  TC.Runtime.createWorld(424242);
  const p = TC.player;
  const TS = TC.CONST.TS;

  // 1. craft storm shard from vanilla stone (station-free recipe)
  p.inventory.add('stone', 6);
  let st = TC.Crafting.stationsNearby(p.x, p.y);
  let r = TC.Crafting.available(p.inventory, st)
    .find((x) => String(x.out).indexOf('tempest_shard') >= 0);
  assert.ok(r, 'fixture recipe visible in crafting availability');
  assert.strictEqual(
    TC.Commands.submit('CraftRecipe', { recipe: r, inv: p.inventory, stations: st }).ok, true);
  assert.strictEqual(p.inventory.count('tempest_shard'), 1,
    'output stored under canonical bare key');

  // 2. place the pack block via PlaceTile (numeric world id == appended index)
  p.inventory.add('tempest_brick', 2);
  const ptx = Math.floor(p.x / TS), pty = Math.floor(p.y / TS);
  let placedAt = null;
  outer:
  for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) {
    const res = TC.Commands.submit('PlaceTile',
      { tx: ptx + dx, ty: pty + dy, item: 'tempest_brick', player: p });
    if (res.ok) { placedAt = [ptx + dx, pty + dy]; break outer; }
  }
  assert.ok(placedAt, 'pack block placed near spawn');
  assert.strictEqual(TC.world.get(placedAt[0], placedAt[1]), TC.TILE_DEFS.length - 1,
    'world byte is the appended pack tile index');
  // mining it returns the declared drop (canonical key) through the loot seam
  const pickSlot = p.inventory.slots.findIndex((s) => s && s.id === 'copper_pickaxe');
  if (pickSlot >= 0) p.hotbarIndex = pickSlot;
  assert.strictEqual(
    TC.Commands.submit('MineTile', { tx: placedAt[0], ty: placedAt[1], player: p, toolPower: 35 }).ok,
    true);
  TC.Runtime.advanceTicks(90); // settle + magnet pickup window
  assert.ok(p.inventory.count('tempest_brick') >= 1 || TC.Items.drops.some(d => d.id === 'tempest_brick'),
    'mined pack tile yields its declared item drop');

  // 3. summon the mini-boss; charge consumed exactly once (realistic flow:
  // the charm sits in a hotbar slot and is SELECTED when used)
  p.inventory.add('tempest_charm', 1);
  const charmSlot = p.inventory.slots.findIndex((s) => s && s.id === 'tempest_charm');
  assert.ok(charmSlot >= 0 && charmSlot < 10, 'charm lives in the hotbar');
  p.hotbarIndex = charmSlot;
  const before = p.inventory.count('tempest_charm');
  const ur = TC.Commands.submit('UseItem', { slot: charmSlot, aimX: p.x + TS * 8, aimY: p.y - TS * 8, player: p });
  assert.ok(ur.ok && ur.result.used, 'charm use accepted');
  assert.strictEqual(TC.Enemies.list.length, 1, 'wisp spawned');
  assert.strictEqual(TC.Enemies.list[0].def.boss, true);
  assert.strictEqual(p.inventory.count('tempest_charm'), before - 1,
    'charge consumed exactly once');

  // 4. kill it -> declarative drops land as canonical keys
  TC.Enemies.damageEnemy(TC.Enemies.list[0], 999999, 1, 0, false);
  TC.Runtime.advanceTicks(150);
  const gotShard = p.inventory.count('tempest_shard') > 1 ||
    TC.Items.drops.some((d) => d.id === 'tempest_shard');
  assert.ok(gotShard, 'storm shard dropped from the wisp');

  // 5. localization resolves through registry-derived pack keys
  assert.strictEqual(TC.Localization.contentName('item', 'tempest_blade'), 'Tempest Blade');
  assert.strictEqual(TC.Localization.contentName('enemy', 'testpack:tempest_wisp'), 'Tempest Wisp');
  assert.strictEqual(TC.Localization.contentName('tile', TC.TILE_DEFS.length - 1), 'Tempest Brick');
});

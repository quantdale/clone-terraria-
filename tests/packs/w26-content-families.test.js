/* tests/packs/w26-content-families.test.js — WS1: declarative wall + standalone
   loot-table content families through the SAME fail-closed atomic pack pipeline
   used by tiles/items/enemies/recipes. Covers: append-only wall indices,
   registry identity, wall place/mine through canonical commands, loot-table
   registration + deterministic rolling, enemy lootTable reference + kill drop,
   cross-pack reference, invalid rejection, and transactional rollback.

   Each test loads a FRESH game realm so dense-table mutation never leaks across
   cases (pack activation is session-permanent within one realm). */
'use strict';
const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', '..', 'tests', 'helpers', 'load-game.js'));

const BASE_FP = '1b1d7c15';

function fresh() {
  return loadGame({ frames: 0 }).TC;
}

// Provide + activate a list of manifest objects; returns the TC.
function activate(TC, manifests) {
  for (const m of manifests) TC.Packs.provide(m);
  return TC.Packs.setActive(manifests.map((m) => m.id));
}

test('ws1: zero-pack fingerprint unchanged with lootTable kind added', () => {
  const TC = fresh();
  assert.strictEqual(TC.Registry.fingerprint(), BASE_FP,
    'adding an empty lootTable registry kind must not perturb the baseline');
  assert.strictEqual(TC.Registry.count('lootTable'), 0,
    'no lootTable entries in a zero-pack boot');
});

test('ws1: wall family commits append-only after built-ins', () => {
  const TC = fresh();
  const baseWalls = TC.WALL_DEFS.length;
  const baseRegWalls = TC.Registry.count('wall');

  activate(TC, [{
    manifest: 1, id: 'wallpack', name: 'Wall Pack', version: '1.0.0', type: 'data',
    content: {
      walls: [
        { key: 'azure', name: 'Azure Wall', color: '#2233aa', hardness: 0.4 },
        { key: 'crimson', name: 'Crimson Wall', color: '#aa2233', hardness: 0.6 },
      ],
    },
  }]);

  assert.strictEqual(TC.WALL_DEFS.length, baseWalls + 2, 'two walls appended');
  assert.strictEqual(TC.Registry.count('wall'), baseRegWalls + 2);
  // built-in wall indices are untouched
  for (let i = 0; i < baseWalls; i++) {
    assert.ok(TC.Registry.stableOfIndex('wall', i), 'built-in wall ' + i + ' intact');
  }
  const idx0 = TC.WALL_DEFS.length - 2;
  assert.strictEqual(TC.WALL_DEFS[idx0].name, 'Azure Wall');
  assert.strictEqual(TC.WALL_DEFS[idx0].color, '#2233aa');
  // numeric alias maps the stable id to the appended index
  assert.strictEqual(TC.Registry.stableToIndex('wall', 'wallpack:azure'), idx0);
  assert.strictEqual(TC.Registry.get('wall', 'wallpack:azure').hardness, 0.4);
  // registry coherence gate passed
  assert.doesNotThrow(() => TC.Registry.validate());
});

test('ws1: invalid wall schema rejected (color/hardness/unknown field)', () => {
  const TC = fresh();
  assert.throws(() => activate(TC, [{
    manifest: 1, id: 'badwall', name: 'Bad Wall', version: '1.0.0', type: 'data',
    content: { walls: [{ key: 'x', name: 'X Wall', color: 'blue', hardness: 0.3 }] },
  }]), /color must be a '#rrggbb'/);

  assert.throws(() => activate(TC, [{
    manifest: 1, id: 'badwall2', name: 'Bad Wall 2', version: '1.0.0', type: 'data',
    content: { walls: [{ key: 'x', name: 'X Wall', color: '#112233', hardness: 99 }] },
  }]), /hardness must be a number within 0\.\.10/);

  assert.throws(() => activate(TC, [{
    manifest: 1, id: 'badwall3', name: 'Bad Wall 3', version: '1.0.0', type: 'data',
    content: { walls: [{ key: 'x', name: 'X Wall', color: '#112233', hardness: 0.3, bogus: 1 }] },
  }]), /unknown field 'bogus'/);
});

test('ws1: wall item places and mines through canonical commands', () => {
  const TC = fresh();
  activate(TC, [{
    manifest: 1, id: 'wallpack', name: 'Wall Pack', version: '1.0.0', type: 'data',
    content: {
      walls: [{ key: 'azure', name: 'Azure Wall', color: '#2233aa', hardness: 0.4 }],
      items: [
        { key: 'azure_wall', name: 'Azure Wall Item', kind: 'block', wall: 'wallpack:azure' },
      ],
    },
  }]);
  TC.Runtime.createWorld(777);
  const p = TC.player;
  const TS = TC.CONST.TS;
  const w = TC.world;
  const ptx = Math.floor(p.x / TS), pty = Math.floor(p.y / TS);
  // ensure an air tile with no wall so PlaceWall + MineWall are both legal
  const tx = ptx, ty = pty + 1;
  w.set(tx, ty, TC.TILE.AIR);
  w.setWall(tx, ty, TC.WALL.NONE);

  const wallIdx = TC.Registry.stableToIndex('wall', 'wallpack:azure');
  assert.ok(wallIdx > 0, 'wall resolved to a positive dense index');
  assert.strictEqual(TC.ITEM_DEFS.azure_wall.wall, wallIdx, 'item def carries numeric wall id');

  p.inventory.add('azure_wall', 1);
  const place = TC.Commands.submit('PlaceWall', { tx, ty, item: 'azure_wall', player: p });
  assert.strictEqual(place.ok, true, 'wall placed via canonical transaction');
  assert.strictEqual(w.getWall(tx, ty), wallIdx, 'world wall byte is the pack wall index');

  const mine = TC.Commands.submit('MineWall',
    { tx, ty, player: p, tool: 'pick', toolPower: 100000 });
  assert.strictEqual(mine.ok, true, 'wall mined via canonical transaction');
  assert.strictEqual(w.getWall(tx, ty), TC.WALL.NONE, 'wall removed after mining');
});

test('ws1: loot-table family commits and rolls deterministically', () => {
  const TC = fresh();
  activate(TC, [{
    manifest: 1, id: 'lootpack', name: 'Loot Pack', version: '1.0.0', type: 'data',
    requires: { game: '>=0.9' },
    content: {
      items: [{ key: 'relic', name: 'Relic', kind: 'material', value: 5 }],
      lootTables: [{
        key: 'rare', name: 'Rare Drops',
        entries: [
          { id: 'lootpack:relic', min: 2, max: 2, chance: 1 },
        ],
      }],
    },
  }]);
  assert.strictEqual(TC.Registry.count('lootTable'), 1);
  const def = TC.Registry.get('lootTable', 'lootpack:rare');
  assert.ok(def && Array.isArray(def.entries), 'loot table registered with entries');

  // deterministic roll with an injected RNG
  let seq = [0.0, 0.5]; // first call passes chance(1) (>=1 always true except rng()>=1); second picks count
  let i = 0;
  const rng = () => seq[Math.min(i++, seq.length - 1)];
  const rolled = TC.LootTables.rollById('lootpack:rare', { rng });
  assert.strictEqual(rolled.length, 1, 'guaranteed entry rolled');
  assert.strictEqual(rolled[0].id, 'relic', 'entry id normalized to canonical bare key');
  assert.strictEqual(rolled[0].count, 2);
});

test('ws1: loot table referenced by enemy drops on kill', () => {
  const TC = fresh();
  activate(TC, [{
    manifest: 1, id: 'lootpack', name: 'Loot Pack', version: '1.0.0', type: 'data',
    requires: { game: '>=0.9' },
    content: {
      items: [{ key: 'relic', name: 'Relic', kind: 'material', value: 5 }],
      lootTables: [{
        key: 'common', name: 'Common Drops',
        entries: [{ id: 'lootpack:relic', min: 1, max: 1, chance: 1 }],
      }],
      enemies: [{
        key: 'husk', name: 'Husk', hp: 5, dmg: 1, ai: 'zombie', w: 24, h: 24,
        lootTable: 'lootpack:common',
      }],
    },
  }]);
  TC.Runtime.createWorld(999);
  const e = TC.Enemies.spawnEnemy('husk', TC.player.x, TC.player.y - 40);
  assert.ok(e, 'pack enemy spawned');
  assert.strictEqual(e.def.lootTable, 'lootpack:common');
  const before = TC.Items.drops.length;
  TC.Enemies.damageEnemy(e, 999999, 1, 0, false);
  TC.Runtime.advanceTicks(120);
  const dropped = TC.Items.drops.slice(before).some((d) => d.id === 'relic') ||
    TC.player.inventory.count('relic') > 0;
  assert.ok(dropped, 'enemy killed -> loot-table entry dropped');
});

test('ws1: cross-pack loot reference resolves through declared dependency', () => {
  const TC = fresh();
  TC.Packs.provide({
    manifest: 1, id: 'basep', name: 'Base', version: '1.0.0', type: 'data',
    content: { items: [{ key: 'base_gem', name: 'Base Gem', kind: 'material' }] },
  });
  TC.Packs.provide({
    manifest: 1, id: 'extp', name: 'Ext', version: '1.0.0', type: 'data',
    requires: { packs: { basep: '^1.0.0' } },
    content: {
      lootTables: [{
        key: 'from_base', name: 'From Base',
        entries: [{ id: 'basep:base_gem', min: 1, max: 1, chance: 1 }],
      }],
    },
  });
  const r = TC.Packs.setActive(['basep', 'extp']);
  assert.strictEqual(r.activated.join(','), 'basep,extp', 'deps before dependents');
  const rolled = TC.LootTables.rollById('extp:from_base', { rng: () => 0.1 });
  assert.strictEqual(rolled.length, 1);
  assert.strictEqual(rolled[0].id, 'base_gem', 'cross-pack item normalized to bare key');
});

test('ws1: loot table with unknown item / bad entry rejects before commit', () => {
  const TC = fresh();
  assert.throws(() => activate(TC, [{
    manifest: 1, id: 'badloot', name: 'Bad Loot', version: '1.0.0', type: 'data',
    content: {
      lootTables: [{ key: 'x', name: 'X', entries: [{ id: 'ghost_item', min: 1, max: 1, chance: 1 }] }],
    },
  }]), /does not resolve to a registered item/);

  assert.throws(() => activate(TC, [{
    manifest: 1, id: 'badloot2', name: 'Bad Loot 2', version: '1.0.0', type: 'data',
    content: {
      lootTables: [{ key: 'x', name: 'X', entries: [{ id: 'stone', min: 2, max: 1, chance: 1 }] }],
    },
  }]), /min\/max must be integers 0\.\.999 with max >= min/);
});

test('ws1: bad loot table in an otherwise-valid pack rolls back walls too', () => {
  const TC = fresh();
  const baseWalls = TC.WALL_DEFS.length;
  const baseRegWalls = TC.Registry.count('wall');
  const wallsBefore = TC.WALL_DEFS.map((d) => d.name);

  assert.throws(() => TC.Packs.setActive(
    TC.Packs.provide({
      manifest: 1, id: 'mixed', name: 'Mixed', version: '1.0.0', type: 'data',
      content: {
        walls: [{ key: 'okwall', name: 'OK Wall', color: '#123456', hardness: 0.3 }],
        lootTables: [{ key: 'bad', name: 'Bad', entries: [{ id: 'ghost', min: 1, max: 1, chance: 1 }] }],
      },
    }) && ['mixed'],
  ), /content failed validation/);

  assert.strictEqual(TC.WALL_DEFS.length, baseWalls, 'no wall appended on rollback');
  assert.strictEqual(TC.Registry.count('wall'), baseRegWalls);
  assert.deepStrictEqual(TC.WALL_DEFS.map((d) => d.name), wallsBefore,
    'wall table byte-for-byte coherent after rollback');
  assert.strictEqual(TC.Packs.active().length, 0);
});

test('ws1: save classifies the active wall/loot pack and refuses a missing one', () => {
  const TC = fresh();
  activate(TC, [{
    manifest: 1, id: 'wallpack', name: 'Wall Pack', version: '1.0.0', type: 'data',
    content: {
      walls: [{ key: 'azure', name: 'Azure Wall', color: '#2233aa', hardness: 0.4 }],
      lootTables: [{ key: 'lt', name: 'LT', entries: [{ id: 'stone', min: 1, max: 1, chance: 1 }] }],
    },
  }]);
  const meta = TC.Packs.saveMetadata();
  assert.ok(meta && meta.packs.some((p) => p.id === 'wallpack'), 'save metadata carries the pack');
  const cls = TC.Packs.classifySave(meta);
  assert.strictEqual(cls.ok, true, 'matching save classifies compatible');

  // a save that requires the pack while it is absent is refused
  const TC2 = fresh();
  const refused = TC2.Packs.classifySave(meta);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.status, 'incompatible');
});

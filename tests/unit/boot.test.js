/* tests/unit/boot.test.js — Phase 3/5 gates executed headlessly: full real-script
   boot, registry finalization, generation-version consistency (regression for the
   savecore/worldgen drift defect), and a new game + one simulated frame. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

test('boot: all modules load without throwing and TC surface exists', () => {
  const g = loadGame();
  const TC = g.TC;
  for (const name of ['CONST', 'Registry', 'Events', 'Systems', 'Commands', 'SaveCore',
    'WorldGen', 'World', 'Liquids', 'Progression', 'Player', 'Items', 'Combat',
    'Projectiles', 'Magic', 'Fishing', 'Accessories', 'Wiring', 'Gear', 'Loot',
    'Biomes', 'Stats', 'Save', 'UI', 'NPCs', 'Enemies']) {
    assert.ok(TC[name], 'TC.' + name + ' missing after boot');
  }
});

test('boot: registry syncs + validates cleanly at startup', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.Registry.syncFromTables();
  const res = TC.Registry.validate(); // throws on problems
  assert.ok(res && res.ok !== false);
  for (const kind of ['tile', 'wall', 'item', 'recipe', 'enemy', 'npc', 'buff', 'projectileType', 'biome', 'station']) {
    assert.ok(TC.Registry.count(kind) > 0, 'registry empty for kind ' + kind);
  }
});

test('regression: save envelope generationVersion matches WorldGen.GENERATION_VERSION', () => {
  const g = loadGame();
  const TC = g.TC;
  assert.strictEqual(TC.SaveCore.GENERATION_VERSION, TC.WorldGen.GENERATION_VERSION,
    'SaveCore.GENERATION_VERSION getter drifted from worldgen');
  // Envelope stamps the real generator version once a world exists
  // (without one, save.js's world.core provider correctly refuses a lossy save).
  TC.newGame(777);
  const env = TC.SaveCore.buildEnvelope({ world: TC.world, player: TC.player });
  assert.ok(env, 'envelope should build with live world+player');
  assert.strictEqual(env.generationVersion, TC.WorldGen.GENERATION_VERSION);
  assert.strictEqual(env.formatVersion, 2);
});

test('boot: duplicate SaveCore provider registration is rejected loudly', () => {
  const g = loadGame();
  const TC = g.TC;
  const before = TC.SaveCore.providerKeys().length;
  assert.throws(() => TC.SaveCore.register('systems.core.wiring', { serialize: () => ({}), deserialize: () => {} }),
    /duplicate|exists/i);
  assert.strictEqual(TC.SaveCore.providerKeys().length, before, 'provider count changed on dup register');
});

test('sim: new game starts, world+player live; bare generate() is deterministic', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(12345);
  assert.strictEqual(TC.state, 'playing');
  assert.ok(TC.world, 'world not created');
  assert.ok(TC.player, 'player not created');
  assert.strictEqual(TC.worldSeed, 12345);
  // True determinism invariant: two independent bare generations match.
  const a = TC.WorldGen.generate(12345);
  const b = TC.WorldGen.generate(12345);
  assert.deepStrictEqual(Array.from(a.tiles), Array.from(b.tiles),
    'generate(seed) not deterministic across calls');
  assert.deepStrictEqual(Array.from(a.surfaceY), Array.from(b.surfaceY));
  // World built via buildWorld == bare gen + deterministic loot post-pass
  // + W1 liquid import (WATER/LAVA tiles claimed into TC.Liquids -> AIR).
  const gen2 = TC.WorldGen.generate(12345);
  if (TC.Loot && TC.Loot.populateWorld) TC.Loot.populateWorld(gen2, 12345);
  let same = true;
  for (let i = 0; i < gen2.tiles.length; i++) {
    let expected = gen2.tiles[i];
    if (expected === TC.TILE.WATER || expected === TC.TILE.LAVA) expected = TC.TILE.AIR;
    if (expected !== TC.world.tiles[i]) { same = false; break; }
  }
  assert.ok(same, 'buildWorld output != generate()+populateWorld+liquid-import pipeline');
  // ...and the claimed liquid actually landed in the authoritative layer.
  let layerCells = 0;
  for (let i = 0; i < TC.world.tiles.length; i++) {
    const id = TC.world.tiles[i];
    if (id === TC.TILE.WATER || id === TC.TILE.LAVA) {
      layerCells = -1; break; // stray legacy tile: fail below
    }
  }
  if (layerCells === 0) layerCells = TC.Liquids.stats().cells;
  assert.ok(layerCells > 0, 'live world kept no liquid and imported none');
});

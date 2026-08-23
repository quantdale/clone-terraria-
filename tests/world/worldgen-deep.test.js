/* tests/world/worldgen-deep.test.js — Wave 4 (v3) deepening gates.
   Asserts the GENERATION_VERSION bump, byte-identical determinism of the
   new passes, presence of micro-biome marker blocks + silver/crystal ore
   underground, and a safe spawn area under the new validation pass. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

// One shared boot; WorldGen is stateless across generate() calls.
const G = loadGame();
const TC = G.TC;

function fnv(arr) {
  let h = 0x811c9dc5;
  for (let i = 0; i < arr.length; i++) {
    h ^= arr[i] & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

test('worldgen-deep: GENERATION_VERSION is 3 and feature flags default on', () => {
  assert.strictEqual(TC.WorldGen.GENERATION_VERSION, 3);
  assert.deepStrictEqual({ ...TC.WorldGen.CONFIG },
    { deepCaves: true, microBiomes: true, richOres: true });
});

test('worldgen-deep: two generate(seed) calls produce identical tiles/walls', () => {
  for (const seed of [12345, 777, 20260823]) {
    const a = TC.WorldGen.generate(seed);
    const b = TC.WorldGen.generate(seed);
    assert.strictEqual(fnv(a.tiles), fnv(b.tiles),
      'seed ' + seed + ': tiles differ between runs');
    assert.strictEqual(fnv(a.walls), fnv(b.walls),
      'seed ' + seed + ': walls differ between runs');
    assert.ok(typeof a.timings['deep-caves'] === 'number' && a.timings['deep-caves'] >= 0,
      'missing timing for deep-caves');
    assert.ok(typeof a.timings['micro-biomes'] === 'number' && a.timings['micro-biomes'] >= 0,
      'missing timing for micro-biomes');
    assert.ok(a.stats && typeof a.stats.invalidTiles === 'number',
      'validation stats not collected');
  }
});

test('worldgen-deep: every probed seed has micro-biome markers underground', () => {
  const T = TC.TILE;
  const markers = new Set([T.GLEAM, T.MUSHGRASS, T.MUSHSTEM,
    T.GRANITE, T.MARBLE, T.MOSSSTONE]);
  for (const seed of [1, 7, 12345, 987654321, 2147483646]) {
    const gen = TC.WorldGen.generate(seed);
    const t = gen.tiles;
    const W = gen.width;
    let found = 0;
    for (let y = 190; y < gen.height - 2; y++) {
      for (let x = 0; x < W; x++) {
        if (markers.has(t[y * W + x])) found++;
      }
    }
    assert.ok(found > 0,
      'seed ' + seed + ': no micro-biome marker block found underground');
  }
});

test('worldgen-deep: silver ore is common; crystal ore exists in most seeds', () => {
  const T = TC.TILE;
  let silverSeeds = 0, crystalSeeds = 0;
  const seeds = [1, 7, 13, 29, 41, 12345, 987654321];
  for (const seed of seeds) {
    const t = TC.WorldGen.generate(seed).tiles;
    let silver = 0, crystal = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === T.SILVER_ORE) silver++;
      else if (t[i] === T.CRYSTAL_ORE) crystal++;
    }
    if (silver > 0) silverSeeds++;
    if (crystal > 0) crystalSeeds++;
  }
  assert.ok(silverSeeds === seeds.length,
    'silver ore missing from some seeds (' + silverSeeds + '/' + seeds.length + ')');
  assert.ok(crystalSeeds >= Math.ceil(seeds.length / 2),
    'crystal ore too rare (' + crystalSeeds + '/' + seeds.length + ' seeds)');
});

test('worldgen-deep: spawn area is safe on seed 12345', () => {
  const gen = TC.WorldGen.generate(12345);
  const sx = gen.spawnX, sy = gen.spawnY;
  const W = gen.width, H = gen.height;
  const t = gen.tiles;
  assert.ok(sx >= 8 && sx < W - 8, 'spawnX out of safe bounds');
  assert.ok(sy >= 6 && sy < H - 6, 'spawnY out of bounds');
  // solid ground directly beneath the feet row
  assert.strictEqual(
    !!TC.TILE_DEFS[t[sy * W + sx]].solid, true,
    'spawn has no solid ground beneath');
  // several clear air rows above the head
  for (let dy = 1; dy <= 3; dy++) {
    assert.strictEqual(t[(sy - dy) * W + sx], TC.TILE.AIR,
      'spawn air row +' + dy + ' above ground is blocked');
  }
  // no liquid anywhere in the spawn window
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -6; dy <= 3; dy++) {
      const id = t[(sy + dy) * W + (sx + dx)];
      assert.notStrictEqual(id, TC.TILE.WATER, 'water inside spawn window');
      assert.notStrictEqual(id, TC.TILE.LAVA, 'lava inside spawn window');
    }
  }
});

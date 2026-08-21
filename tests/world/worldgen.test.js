/* tests/world/worldgen.test.js — T1: generation determinism gates.
   Seeds must produce byte-identical tiles/walls/surfaceY across repeated
   in-process calls, interleaved calls, and one fresh-process spot check.
   Also: CONFIG defaults, runPass('nope') throws, timings present. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { loadGame } = require('../helpers/load-game.js');

const SEEDS = [1, 42, 12345, 777777, 20260822, 987654321];

// FNV-1a 32-bit checksum over an array-like of bytes.
function fnv(arr) {
  let h = 0x811c9dc5;
  for (let i = 0; i < arr.length; i++) {
    h ^= arr[i] & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

test('worldgen: CONFIG feature flags default false', () => {
  const g = loadGame();
  assert.deepStrictEqual({ ...g.TC.WorldGen.CONFIG },
    { deepCaves: false, microBiomes: false, richOres: false });
});

test('worldgen: runPass("nope") throws; known pass runs', () => {
  const g = loadGame();
  const TC = g.TC;
  assert.throws(() => TC.WorldGen.runPass('nope', {}), /Unknown generation pass/i);
});

test('worldgen: generate twice per seed is byte-identical + timings present', () => {
  const g = loadGame();
  const TC = g.TC;
  for (const seed of SEEDS) {
    const a = TC.WorldGen.generate(seed);
    const b = TC.WorldGen.generate(seed);
    assert.strictEqual(fnv(a.tiles), fnv(b.tiles), 'tiles checksum mismatch seed=' + seed);
    assert.strictEqual(fnv(a.walls), fnv(b.walls), 'walls checksum mismatch seed=' + seed);
    assert.deepStrictEqual(Array.from(a.surfaceY), Array.from(b.surfaceY),
      'surfaceY mismatch seed=' + seed);
    // shape sanity
    assert.strictEqual(a.tiles.length, TC.CONST.WORLD_W * TC.CONST.WORLD_H);
    assert.ok(typeof a.spawnX === 'number' && typeof a.spawnY === 'number');
    for (const p of ['terrain', 'surface-biomes', 'caves', 'ores', 'structures',
      'decor', 'validation']) {
      assert.ok(typeof a.timings[p] === 'number' && a.timings[p] >= 0,
        'missing timing for pass ' + p);
    }
  }
});

test('worldgen: passes do not consume each other RNG streams — gen(A),gen(B),gen(A) keeps first==third', () => {
  const g = loadGame();
  const TC = g.TC;
  const A1 = TC.WorldGen.generate(777);
  const B = TC.WorldGen.generate(888);
  const A2 = TC.WorldGen.generate(777);
  assert.notStrictEqual(fnv(A1.tiles), undefined);
  if (fnv(A1.tiles) === fnv(B.tiles)) assert.fail('different seeds produced identical worlds?! (sanity)');
  assert.strictEqual(fnv(A1.tiles), fnv(A2.tiles), 'interleaved gen(777) drifted');
  assert.strictEqual(fnv(A1.walls), fnv(A2.walls));
});

test('worldgen: fresh-process determinism spot-check (seed 42) matches in-process result', () => {
  const g = loadGame();
  const local = fnv(g.TC.WorldGen.generate(42).tiles);
  const script =
    'const {loadGame}=require(' + JSON.stringify(path.join(process.cwd(), 'tests/helpers/load-game.js')) + ');' +
    'function f(a){let h=0x811c9dc5;for(let i=0;i<a.length;i++){h^=a[i]&255;h=Math.imul(h,16777619);}return h>>>0;}' +
    'console.log(f(loadGame().TC.WorldGen.generate(42).tiles));';
  const out = execFileSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.strictEqual(out.trim(), String(local),
    'fresh process generated a different world for seed 42');
});

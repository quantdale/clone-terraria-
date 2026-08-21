/* Scratch smoke test for js/worldgen.js — run with node, then delete. */
'use strict';
global.window = global; // modules assign through window.*; bare TC needs true globals
require('./js/utils.js');
require('./js/constants.js');
require('./js/worldgen.js');
const TC = window.TC;

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; } };

const t0 = Date.now();
const g1 = TC.WorldGen.generate(12345);
const ms = Date.now() - t0;
const g2 = TC.WorldGen.generate(12345);
const g3 = TC.WorldGen.generate(999);

assert(g1.width === TC.CONST.WORLD_W && g1.height === TC.CONST.WORLD_H, 'dims');
assert(g1.tiles.length === g1.width * g1.height, 'tiles length');
assert(g1.walls.length === g1.width * g1.height, 'walls length');

// determinism
for (let i = 0; i < g1.tiles.length; i++) {
  if (g1.tiles[i] !== g2.tiles[i]) { assert(false, 'determinism tiles @' + i); break; }
}
for (let i = 0; i < g1.walls.length; i++) {
  if (g1.walls[i] !== g2.walls[i]) { assert(false, 'determinism walls @' + i); break; }
}
assert(g1.spawnX === g2.spawnX && g1.spawnY === g2.spawnY, 'determinism spawn');

// all tile ids within table bounds
let maxId = 0;
for (let i = 0; i < g1.tiles.length; i++) if (g1.tiles[i] > maxId) maxId = g1.tiles[i];
assert(maxId < TC.TILE_DEFS.length, 'tile ids < TILE_DEFS.length (' + maxId + ' vs ' + TC.TILE_DEFS.length + ')');
let maxWall = 0;
for (let i = 0; i < g1.walls.length; i++) if (g1.walls[i] > maxWall) maxWall = g1.walls[i];
assert(maxWall < TC.WALL_DEFS.length, 'wall ids < WALL_DEFS.length');

// count helper
const T = TC.TILE;
function count(gen, id) {
  let n = 0;
  for (let i = 0; i < gen.tiles.length; i++) if (gen.tiles[i] === id) n++;
  return n;
}
const W = g1.width, H = g1.height;
const at = (g, x, y) => g.tiles[y * W + x];

console.log('counts: water=' + count(g1, T.WATER) + ' sand=' + count(g1, T.SAND) +
  ' cactus=' + count(g1, T.CACTUS) + ' ebonstone=' + count(g1, T.EBONSTONE) +
  ' crimstone=' + count(g1, T.CRIMSTONE) + ' ebongrass=' + count(g1, T.EBONGRASS) +
  ' shadewood=' + count(g1, T.SHADEWOOD) + ' dungeonBrick=' + count(g1, T.DUNGEON_BRICK) +
  ' hellBrick=' + count(g1, T.HELL_BRICK) + ' sandstone=' + count(g1, T.SANDSTONE_BRICK) +
  ' chest=' + count(g1, T.CHEST) + ' torch=' + count(g1, T.TORCH) + ' lava=' + count(g1, T.LAVA));

// oceans: water volume near both edges at sea level band
const SEA = TC.CONST.GEN.baseSurface + 6;
let edgeWaterL = 0, edgeWaterR = 0;
for (let x = 5; x < 60; x++) if (at(g1, x, SEA) === T.WATER) edgeWaterL++;
for (let x = W - 60; x < W - 5; x++) if (at(g1, x, SEA) === T.WATER) edgeWaterR++;
assert(edgeWaterL > 40, 'left ocean water at sea level (' + edgeWaterL + ')');
assert(edgeWaterR > 40, 'right ocean water at sea level (' + edgeWaterR + ')');
// seabed is sand under the water
let seabedSand = 0;
for (let x = 5; x < 80; x++) {
  let y = SEA;
  while (y < H && at(g1, x, y) === T.WATER) y++;
  if (at(g1, x, y) === T.SAND || at(g1, x, y) === T.STONE) seabedSand++;
}
assert(seabedSand > 60, 'ocean floor solid under water column (' + seabedSand + '/75)');
// no dry AIR below sea level in ocean bands (breaches sealed)
let dryBelow = 0;
for (let x = 0; x < 100; x++) {
  for (let y = SEA; y < Math.min(SEA + 30, H); y++) {
    if (at(g1, x, y) === T.AIR) dryBelow++;
  }
}
assert(dryBelow === 0, 'no unsealed air under left ocean (' + dryBelow + ')');

// evil strip: exactly one variant present, other absent
const evilCount = count(g1, T.EBONSTONE) + count(g1, T.CRIMSTONE);
assert(evilCount > 500, 'evil stone present (' + evilCount + ')');
assert(count(g1, T.EBONSTONE) === 0 || count(g1, T.CRIMSTONE) === 0, 'only one evil variant');
assert(count(g1, T.SHADEWOOD) > 50, 'shadewood veins/dead trees (' + count(g1, T.SHADEWOOD) + ')');

// desert overhaul
assert(count(g1, T.CACTUS) > 10, 'cacti placed (' + count(g1, T.CACTUS) + ')');
assert(count(g1, T.SANDSTONE_BRICK) > 200, 'pyramid brick (' + count(g1, T.SANDSTONE_BRICK) + ')');

// dungeon + hell temples
assert(count(g1, T.DUNGEON_BRICK) > 300, 'dungeon brick (' + count(g1, T.DUNGEON_BRICK) + ')');
assert(count(g1, T.HELL_BRICK) > 300, 'hell temple brick (' + count(g1, T.HELL_BRICK) + ')');
assert(count(g1, T.CHEST) >= 6, 'chests in structures (' + count(g1, T.CHEST) + ')');

// spawn sanity: standing room on a solid tile, not inside new structures
assert(g1.spawnX > 0 && g1.spawnX < W, 'spawnX in bounds');
const spawnGroundId = at(g1, g1.spawnX, g1.spawnY);
assert(TC.TILE_DEFS[spawnGroundId].solid, 'spawn stands on solid (' + TC.TILE_DEFS[spawnGroundId].name + ')');
assert(at(g1, g1.spawnX, g1.spawnY - 1) === T.AIR, 'spawn headroom air');

// walls behind ocean water exist
let oceanWall = 0;
for (let x = 5; x < 60; x++) {
  const wi = g1.walls[SEA * W + x];
  if (wi !== 0) oceanWall++;
}
assert(oceanWall > 40, 'walls behind ocean water (' + oceanWall + ')');

// every chest has support below (needsSupport 'below')
let chestOk = 0, chestN = 0;
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    if (at(g1, x, y) === T.CHEST) {
      chestN++;
      if (TC.TILE_DEFS[at(g1, x, y + 1)].solid) chestOk++;
    }
  }
}
assert(chestOk === chestN, 'all chests supported (' + chestOk + '/' + chestN + ')');

// different seed actually differs
let diff = 0;
for (let i = 0; i < g1.tiles.length; i += 97) if (g1.tiles[i] !== g3.tiles[i]) diff++;
assert(diff > 100, 'seeds produce different worlds');

console.log('gen time: ' + ms + 'ms | spawn: ' + g1.spawnX + ',' + g1.spawnY +
  ' | extension tile ids: CACTUS=' + T.CACTUS + ' EBONSTONE=' + T.EBONSTONE +
  ' SANDSTONE_BRICK=' + T.SANDSTONE_BRICK + ' | walls: SAND=' + TC.WALL.SAND + ' HELL=' + TC.WALL.HELL);
if (process.exitCode) console.log('SMOKE FAILED');
else console.log('SMOKE OK');

/* tests/world/liquids-boundary.test.js — W1 campaign: liquid authority
   invariant under the SINGLE-AUTHORITY contract:
     - TC.Liquids owns all runtime liquid. main.buildWorld() imports every
       WATER/LAVA tile into the volume layer at build time, so live worlds
       hold NO liquid tiles and run in mode 'layer'.
     - Legacy WATER/LAVA tile ids are only a representation (worldgen output,
       legacy-save diffs). No tile liquid simulation exists any more; a stray
       WATER tile written by hand stays exactly where it is until an import
       claims it.
      INVARIANT: no cell ever simultaneously holds a legacy liquid tile
      (TILE.WATER / TILE.LAVA) AND layer liquid (type != NONE && amount > 0).
   Enforcement paths under test: build-time import coherence, claim-on-set,
   consuming importFromWorld, restore filtering, displacement by solid
   placements, and SaveCore round-trips keeping the authority. */

const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

// ---- helpers ----------------------------------------------------------------

function setup(seed) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(seed == null ? 1 : seed);
  return { g, TC };
}

// Carve an isolated arena: interior [x0..x1]x[y0..y1] AIR, side walls STONE,
// solid STONE floor at y1+1. Raw writes only (no support pops).
function carveArena(TC, x0, y0, x1, y1) {
  const w = TC.world;
  const AIR = TC.TILE.AIR, STONE = TC.TILE.STONE;
  for (let y = y0 - 1; y <= y1 + 2; y++) {
    for (let x = x0 - 2; x <= x1 + 2; x++) w.setRaw(x, y, AIR);
  }
  for (let y = y0 - 1; y <= y1; y++) {
    w.setRaw(x0 - 1, y, STONE);
    w.setRaw(x1 + 1, y, STONE);
  }
  for (let x = x0 - 1; x <= x1 + 1; x++) w.setRaw(x, y1 + 1, STONE);
}

// Full-grid authority invariant scan: a cell may hold a liquid tile OR layer
// liquid, never both.
function scanInvariant(TC) {
  const w = TC.world;
  const T = TC.TILE, TYPE = TC.Liquids.TYPE;
  let worstTileCell = null, worstLayerCell = null;
  for (let y = 0; y < w.height; y++) {
    for (let x = 0; x < w.width; x++) {
      const i = y * w.width + x;
      const tileLiquid = w.tiles[i] === T.WATER || w.tiles[i] === T.LAVA;
      const layerLiquid = TC.Liquids.sampleAt(x * 16 + 8, y * 16 + 8).amount > 0;
      if (tileLiquid && !worstTileCell) worstTileCell = [x, y];
      if (layerLiquid && !worstLayerCell) worstLayerCell = [x, y];
      if (tileLiquid && layerLiquid) return { ok: false, cell: [x, y] };
    }
  }
  void worstTileCell; void worstLayerCell;
  return { ok: true, cell: null };
}

// Total layer volume in a region (amount units).
function regionVolume(TC, x0, y0, x1, y1) {
  let sum = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      sum += TC.Liquids.sampleAt(x * 16 + 8, y * 16 + 8).amount;
    }
  }
  return sum;
}

// Step both sims N ticks (world water tick is 0.05s like Liquids TICK).
function stepBoth(TC, ticks) {
  for (let i = 0; i < ticks; i++) {
    TC.world.update(0.05);
    TC.Liquids.update(0.05);
  }
}

// Count legacy liquid tiles on the whole grid.
function countLegacyLiquid(TC) {
  const T = TC.TILE;
  let n = 0;
  for (let i = 0; i < TC.world.tiles.length; i++) {
    const id = TC.world.tiles[i];
    if (id === T.WATER || id === T.LAVA) n++;
  }
  return n;
}

// ---- a. claim-on-set ---------------------------------------------------------

test('boundary: Liquids.set over a WATER tile CLAIMS the cell (tile -> AIR)', () => {
  const { TC } = setup(101);
  const X = 500, YFLOOR = 140;
  carveArena(TC, X - 3, YFLOOR - 3, X + 3, YFLOOR);
  // a stray legacy liquid tile (only possible by hand now — worldgen liquid
  // is imported at build time)
  TC.world.set(X, YFLOOR, TC.TILE.WATER);
  assert.strictEqual(TC.world.get(X, YFLOOR), TC.TILE.WATER, 'precondition');

  // claim it into the layer
  assert.ok(TC.Liquids.set(X, YFLOOR, TC.Liquids.TYPE.WATER, 255));
  assert.strictEqual(TC.world.get(X, YFLOOR), TC.TILE.AIR,
    'layer write did not clear the legacy liquid tile');
  assert.strictEqual(TC.Liquids.sampleAt(X * 16 + 8, YFLOOR * 16 + 8).amount, 255);

  // nothing can resurrect or move the claimed cell: no tile sim exists
  for (let i = 0; i < 20; i++) TC.world.update(0.05);
  assert.notStrictEqual(TC.world.get(X, YFLOOR), TC.TILE.WATER,
    'claimed water re-materialized as a tile');
  const inv = scanInvariant(TC);
  assert.ok(inv.ok, 'invariant broken at ' + JSON.stringify(inv.cell));
});

test('boundary: zero-type Liquids.set does NOT claim and clears layer only', () => {
  const { TC } = setup(102);
  const X = 510, YFLOOR = 140;
  carveArena(TC, X - 3, YFLOOR - 3, X + 3, YFLOOR);
  TC.world.set(X, YFLOOR, TC.TILE.WATER);
  assert.ok(TC.Liquids.set(X, YFLOOR, TC.Liquids.TYPE.NONE, 0));
  assert.strictEqual(TC.world.get(X, YFLOOR), TC.TILE.WATER,
    'a zero write must not touch the legacy tile');
});

// ---- b. consuming import -----------------------------------------------------

test('boundary: importFromWorld CONSUMES every WATER/LAVA tile into the layer', () => {
  const { TC } = setup(21);
  // build a deterministic pool shape first so assertions are exact
  const X0 = 700, X1 = 704, Y1 = 130;
  carveArena(TC, X0, Y1 - 2, X1, Y1);
  for (let x = X0; x <= X1; x++) TC.world.setRaw(x, Y1, TC.TILE.WATER);
  TC.world.setRaw(X0 + 2, Y1 - 1, TC.TILE.LAVA);
  const beforeTiles = countLegacyLiquid(TC);

  const imported = TC.Liquids.importFromWorld(TC.world);
  assert.ok(imported >= 6, 'imported too few cells: ' + imported);
  assert.strictEqual(countLegacyLiquid(TC), beforeTiles - imported,
    'consumed tile count != imported count');

  // pool shape landed in the layer exactly
  for (let x = X0; x <= X1; x++) {
    assert.strictEqual(TC.world.get(x, Y1), TC.TILE.AIR, 'claimed tile remains');
    const s = TC.Liquids.sampleAt(x * 16 + 8, Y1 * 16 + 8);
    assert.strictEqual(s.type, TC.Liquids.TYPE.WATER, 'pool cell missing in layer');
    assert.strictEqual(s.amount, 255, 'pool cell not FULL');
  }
  const lavaS = TC.Liquids.sampleAt((X0 + 2) * 16 + 8, (Y1 - 1) * 16 + 8);
  assert.strictEqual(lavaS.type, TC.Liquids.TYPE.LAVA, 'lava cell missing in layer');

  // re-import finds nothing left to convert (one-way act)
  assert.strictEqual(TC.Liquids.importFromWorld(TC.world), 0,
    'second import found liquid tiles — consumption failed');

  const inv = scanInvariant(TC);
  assert.ok(inv.ok, 'invariant broken after import at ' + JSON.stringify(inv.cell));
});

// ---- c. divergence impossibility + mass conservation ------------------------

test('boundary: after import, both sims run freely yet never diverge; pure-water mass conserved', () => {
  const { TC } = setup(33);
  // Wipe worldgen's own liquid first (raw: water is non-solid/non-opaque so
  // surfaceY/lighting are unaffected) so this basin is the ONLY liquid and
  // import counts are exact.
  const T = TC.TILE;
  for (let i = 0; i < TC.world.tiles.length; i++) {
    if (TC.world.tiles[i] === T.WATER || TC.world.tiles[i] === T.LAVA) {
      TC.world.tiles[i] = T.AIR;
    }
  }
  TC.world.markAllDirty();
  assert.strictEqual(countLegacyLiquid(TC), 0, 'wipe failed (sanity)');
  // sealed U-shaped basin of STONE: floor + walls so settled water cannot move
  const X0 = 800, X1 = 809, YTOP = 128, YFLR = 131;
  for (let y = YTOP; y <= YFLR; y++) {
    TC.world.setRaw(X0 - 1, y, TC.TILE.STONE);
    TC.world.setRaw(X0 + 10, y, TC.TILE.STONE);
  }
  for (let x = X0 - 1; x <= X0 + 10; x++) TC.world.setRaw(x, YFLR + 1, TC.TILE.STONE);
  // 6 columns x 2 rows of WATER tiles inside the basin
  for (let x = X0 + 2; x <= X0 + 7; x++) {
    for (let dy = 0; dy < 2; dy++) TC.world.setRaw(x, YFLR - dy, TC.TILE.WATER);
  }
  const massBefore = 12 * 255;

  const imported = TC.Liquids.importFromWorld(TC.world);
  assert.strictEqual(imported, 12, 'unexpected import count');
  assert.strictEqual(TC.Liquids.mode(), 'layer', 'import must flip mode to layer');

  for (let round = 0; round < 40; round++) stepBoth(TC, 5);

  const inv = scanInvariant(TC);
  assert.ok(inv.ok, 'invariant broken during joint simulation at ' + JSON.stringify(inv.cell));
  assert.strictEqual(countLegacyLiquid(TC), 0, 'liquid tiles reappeared post-import');
  assert.strictEqual(regionVolume(TC, X0, YTOP, X0 + 9, YFLR), massBefore,
    'pure-water layer mass changed without evaporation/contact causes');
});

// ---- d. no tile-liquid simulation exists ------------------------------------

test('boundary: stray WATER tiles never simulate — only the layer moves liquid', () => {
  const { TC } = setup(44);
  const X = 600, YF = 120;
  carveArena(TC, X - 3, YF - 2, X + 3, YF);
  assert.ok(TC.Liquids.importFromWorld(TC.world) >= 0); // idempotent no-op here
  assert.strictEqual(TC.Liquids.mode(), 'layer');

  // A hand-placed WATER tile over open air must stay put forever: the legacy
  // tile mover was removed in W1 and nothing else may mutate liquid tiles.
  const wx = X, wyA = YF - 4;
  TC.world.setRaw(wx, wyA, TC.TILE.WATER);
  for (let i = 0; i < 60; i++) TC.world.update(0.05);
  assert.strictEqual(TC.world.get(wx, wyA), TC.TILE.WATER,
    'a tile-water simulation still runs — dual simulation is back');
  assert.strictEqual(TC.Liquids.sampleAt(wx * 16 + 8, wyA * 16 + 8).amount, 0,
    'stray tile leaked into the layer');

  // ...and worldgen-imported layer liquid DOES fall/settle in the same span:
  // prove movement exists exactly once, on the authoritative side.
  carveArena(TC, X - 3, YF - 2, X + 3, YF);
  TC.world.setRaw(wx, wyA, TC.TILE.AIR);
  assert.ok(TC.Liquids.set(X, wyA, TC.Liquids.TYPE.WATER, 255));
  let landed = false;
  for (let i = 0; i < 60 && !landed; i++) {
    TC.Liquids.update(0.05);
    landed = TC.Liquids.sampleAt(X * 16 + 8, YF * 16 + 8).amount > 0;
  }
  assert.ok(landed, 'authoritative layer did not settle a free-falling cell');
});

// ---- e. persistence keeps the boundary --------------------------------------

test('boundary: SaveCore round-trip preserves layer cells AND layer authority', () => {
  const { TC } = setup(55);
  const X0 = 900, X1 = 903, Y1 = 110;
  carveArena(TC, X0, Y1 - 2, X1, Y1);
  for (let x = X0; x <= X1; x++) TC.world.setRaw(x, Y1, TC.TILE.WATER);
  assert.ok(TC.Liquids.importFromWorld(TC.world) >= 4);
  const before = [];
  for (let x = X0; x <= X1; x++) {
    before.push(TC.Liquids.sampleAt(x * 16 + 8, Y1 * 16 + 8).amount);
  }

  const env = TC.SaveCore.buildEnvelope({ world: TC.world, player: TC.player });
  TC.Liquids.reset(TC.world);
  assert.strictEqual(TC.Liquids.mode(), 'tiles', 'reset must drop back to tiles');
  const res = TC.SaveCore.restore(env, { world: TC.world, player: TC.player });
  assert.ok(res.restored.includes('world.core.liquids'),
    'provider not restored: ' + JSON.stringify(res));

  assert.strictEqual(TC.Liquids.mode(), 'layer',
    'restore must re-enter layer mode');
  for (let x = X0; x <= X1; x++) {
    assert.strictEqual(TC.Liquids.sampleAt(x * 16 + 8, Y1 * 16 + 8).amount, before[x - X0],
      'restored cell differs at x=' + x);
  }
  // restored surface wakes resettle through the LAYER, not the legacy sim
  stepBoth(TC, 10);
  const inv = scanInvariant(TC);
  assert.ok(inv.ok, 'invariant broken after restore at ' + JSON.stringify(inv.cell));
});

test('boundary: restore filters layer data that collides with live liquid tiles', () => {
  const { TC } = setup(56);
  const X = 950, Y1 = 100;
  carveArena(TC, X - 2, Y1 - 2, X + 2, Y1);
  // craft an envelope whose liquid data targets a cell that currently holds
  // a legacy WATER tile (hand-built hostile payload)
  TC.world.setRaw(X, Y1, TC.TILE.WATER);
  const idx = Y1 * TC.world.width + X;
  const env = TC.SaveCore.buildEnvelope({ world: TC.world, player: TC.player });
  env.world['core.liquids'] = { version: 1, data: [[idx, 1, 255]] };

  TC.SaveCore.restore(env, { world: TC.world, player: TC.player });
  const s = TC.Liquids.sampleAt(X * 16 + 8, Y1 * 16 + 8);
  assert.strictEqual(s.amount, 0,
    'restore wrote layer liquid over a live WATER tile (invariant hole)');
  assert.strictEqual(TC.world.get(X, Y1), TC.TILE.WATER, 'hostile restore ate the tile');
});

// ---- f. build-time import coherence (the migration act) ----------------------

test('boundary: a fresh game imports ALL worldgen liquid — zero liquid tiles live', () => {
  const { TC } = setup(57);
  // newGame -> buildWorld -> importFromWorld: the whole grid must be claimed
  assert.strictEqual(countLegacyLiquid(TC), 0,
    'live world still holds WATER/LAVA tiles after the build-time import');
  assert.strictEqual(TC.Liquids.mode(), 'layer', 'runtime authority must be the layer');
  assert.ok(TC.Liquids.stats().cells > 0, 'imported layer is empty (nothing imported?)');

  // gameplay edits never flip the authority back
  TC.world.set(600, 100, TC.TILE.STONE);
  assert.strictEqual(TC.Liquids.mode(), 'layer', 'gameplay edits must not flip mode');
  // ...and re-import is a no-op once everything is claimed
  assert.strictEqual(TC.Liquids.importFromWorld(TC.world), 0,
    'second import found liquid tiles — consumption failed');
});

// ---- g. solid placement displaces layer liquid ------------------------------

test('boundary: placing a solid tile into layer liquid displaces it', () => {
  const { TC } = setup(58);
  const X = 320, Y1 = 150;
  carveArena(TC, X - 3, Y1 - 2, X + 3, Y1);
  assert.ok(TC.Liquids.set(X, Y1, TC.Liquids.TYPE.WATER, 255), 'precondition');
  TC.world.set(X, Y1, TC.TILE.STONE);
  assert.strictEqual(TC.Liquids.sampleAt(X * 16 + 8, Y1 * 16 + 8).amount, 0,
    'solid placement left liquid buried inside a block');
  const inv = scanInvariant(TC);
  assert.ok(inv.ok, 'invariant broken at ' + JSON.stringify(inv.cell));
});

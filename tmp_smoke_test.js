/* Throwaway smoke test for tiles.js/world.js expansion. Deleted after use. */
'use strict';
const path = require('path');

// ---- browser stubs ----
function makeCtx() {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, k) {
      if (k === 'canvas') return { width: 16, height: 16 };
      return proxy;
    },
    set() { return true; },
    apply() { return proxy; }
  });
  // eslint-disable-next-line no-unreachable
}
global.window = global;   // browser-style: window.TC assignments become globals
global.document = {
  createElement() { return { width: 0, height: 0, getContext: () => makeCtx() }; }
};

require(path.join(__dirname, 'js/constants.js'));
require(path.join(__dirname, 'js/utils.js'));
require(path.join(__dirname, 'js/tiles.js'));
require(path.join(__dirname, 'js/world.js'));

const TC = window.TC;
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL: ' + msg); }
}

// ---- content extensions ----
ok(typeof TC.TILE.PLATFORM === 'number', 'PLATFORM id');
ok(typeof TC.TILE.ROPE === 'number', 'ROPE id');
ok(typeof TC.TILE.CHAIN === 'number', 'CHAIN id');
ok(TC.TILE_DEFS[TC.TILE.PLATFORM].pattern === 'platform', 'platform def pattern');
ok(TC.TILE_DEFS[TC.TILE.ROPE].climbable === true, 'rope climbable flag');
ok(TC.TILE_DEFS[TC.TILE.CHAIN].drop === 'chain', 'chain drop');
ok(TC.ITEM_DEFS.platform && TC.ITEM_DEFS.platform.tile === TC.TILE.PLATFORM, 'platform item');
ok(TC.ITEM_DEFS.rope && TC.ITEM_DEFS.rope.tile === TC.TILE.ROPE, 'rope item');
ok(TC.ITEM_DEFS.chain && TC.ITEM_DEFS.chain.tile === TC.TILE.CHAIN, 'chain item');
ok(TC.ITEM_DEFS.hammer && TC.ITEM_DEFS.hammer.tool === 'hammer', 'hammer item tool kind');
ok(TC.RECIPES.some(r => r.out === 'platform'), 'platform recipe');
ok(TC.RECIPES.some(r => r.out === 'rope'), 'rope recipe');
ok(TC.RECIPES.some(r => r.out === 'chain'), 'chain recipe');
ok(TC.RECIPES.some(r => r.out === 'hammer'), 'hammer recipe');
// save.js validation compat: every diff id must be <= TILE_DEFS.length-1 (trivially
// true) and ids must be stable across a reload of the module set.
const idsBefore = JSON.stringify([TC.TILE.PLATFORM, TC.TILE.ROPE, TC.TILE.CHAIN]);
ok(TC.Tiles.SHAPE && TC.Tiles.SHAPE.SLOPE_R === 2 && TC.Tiles.SHAPE.SLOPE_L === 3, 'SHAPE export');

// ---- world fixture ----
const W = 64, H = 64;
function makeGen() {
  const tiles = new Uint8Array(W * H).fill(TC.TILE.STONE);
  return {
    width: W, height: H, tiles,
    walls: new Uint8Array(W * H),
    surfaceY: new Int16Array(W).fill(0), spawnX: 1, spawnY: 1
  };
}
const w = new TC.World(makeGen());
ok(idsBefore === JSON.stringify([TC.TILE.PLATFORM, TC.TILE.ROPE, TC.TILE.CHAIN]), 'ids stable after world build');

// ---- platform hammer cycle: flat -> "/" -> "\" -> flat ----
w.set(5, 5, TC.TILE.PLATFORM);
ok(w.get(5, 5) === TC.TILE.PLATFORM, 'platform placed');
ok(w.shapeAt(5, 5) === 0, 'platform starts full');
ok(w.hammer(5, 5) === true && w.shapeAt(5, 5) === 2, 'hammer 1 -> SLOPE_R');
ok(w.hammer(5, 5) === true && w.shapeAt(5, 5) === 3, 'hammer 2 -> SLOPE_L');
ok(w.hammer(5, 5) === true && w.shapeAt(5, 5) === 0, 'hammer 3 -> back to FULL');

// ---- block hammer cycle: full -> half -> "/" -> "\" -> full ----
ok(w.hammer(8, 8) === true && w.shapeAt(8, 8) === 1, 'stone hammer 1 -> HALF');
ok(w.hammer(8, 8) === true && w.shapeAt(8, 8) === 2, 'stone hammer 2 -> SLOPE_R');
ok(w.hammer(8, 8) === true && w.shapeAt(8, 8) === 3, 'stone hammer 3 -> SLOPE_L');
ok(w.hammer(8, 8) === true && w.shapeAt(8, 8) === 0, 'stone hammer 4 -> FULL');

// ---- non-hammerable tile refuses ----
w.set(10, 10, TC.TILE.TORCH);
ok(w.hammer(10, 10) === false, 'torch not hammerable');
ok(w.hammer(200, 200) === false, 'out of bounds hammer safe');

// ---- rewrite clears shape/paint ----
w.hammer(8, 8); // shape 1
w.setPaint(8, 8, 1);
w.set(8, 8, TC.TILE.DIRT);
ok(w.shapeAt(8, 8) === 0, 'set() clears shape');
ok(w.getPaint(8, 8) === 0, 'set() clears paint');

// ---- furniture open/close + actuation ----
w.set(3, 3, TC.TILE.DOOR_CLOSED);
ok(w.toggleFurniture(3, 3) === true && w.get(3, 3) === TC.TILE.DOOR_OPEN, 'door toggles open');
ok(w.toggleFurniture(3, 3) === true && w.get(3, 3) === TC.TILE.DOOR_CLOSED, 'door toggles closed');
ok(w.toggleFurniture(4, 4) === false, 'non-furniture toggle refused');
w.setShape(6, 6, 0);
ok(w.actuate(6, 6) === true && w.shapeAt(6, 6) === 2, 'actuate platform -> SLOPE_R');
ok(w.actuate(6, 6) === true && w.shapeAt(6, 6) === 3, 'actuate platform again -> SLOPE_L');
ok(w.actuate(7, 7) === false, 'plain stone not actuable');
w.set(12, 12, TC.TILE.DOOR_OPEN);
w.set(13, 12, TC.TILE.DOOR_CLOSED);
ok(w.actuateRegion(11, 11, 14, 13) === 2, 'actuateRegion flips both doors');
ok(w.get(12, 12) === TC.TILE.DOOR_CLOSED && w.get(13, 12) === TC.TILE.DOOR_OPEN, 'region doors swapped');

// ---- paint stub ----
ok(w.setPaint(2, 2, 1) === true && w.getPaint(2, 2) === 1, 'paint set/get');
ok(w.setPaint(2, 2, 0) === true && w.getPaint(2, 2) === 0, 'paint cleared with 0');
ok(w.getPaint(-1, 0) === 0, 'paint OOB safe');

// ---- serialize roundtrip into a fresh world ----
w.setShape(20, 20, 2);
w.setPaint(21, 21, 1);
const shapesBlob = JSON.parse(JSON.stringify(w.serializeShapes()));
const paintsBlob = JSON.parse(JSON.stringify(w.serializePaints()));
ok(shapesBlob.some(e => e[0] === 20 * W + 20 && e[1] === 2), 'serializeShapes sparse entry');
const w2 = new TC.World(makeGen());
w2.loadShapes(shapesBlob);
w2.loadPaints(paintsBlob);
ok(w2.shapeAt(20, 20) === 2, 'loadShapes restores');
ok(w2.getPaint(21, 21) === 1, 'loadPaints restores');
w2.loadShapes(null); w2.loadPaints(undefined); // must not throw

// ---- lighting/minimap compatibility invariant: raw tiles stay plain ids ----
for (let i = 0; i < w.tiles.length; i++) {
  if (!TC.TILE_DEFS[w.tiles[i]]) { ok(false, 'raw tile id outside TILE_DEFS at ' + i); break; }
}
ok(true, 'raw tiles all resolve in TILE_DEFS');

// ---- chunk rebuild with shapes/paints/connections (proxy ctx) ----
w.rebuildChunk(0);
w.rebuildChunk(1);
ok(true, 'rebuildChunk ran with extended state');

// ---- drawTile smoke over every tile id x shape x paint x mask ----
const ctx = makeCtx();
for (let id = 0; id < TC.TILE_DEFS.length; id++) {
  for (let shape = 0; shape < 4; shape++) {
    for (let mask = 0; mask < 16; mask += 5) {
      try { TC.Tiles.drawTile(ctx, id, 0, 0, 16, 3 * id + shape, shape, mask, shape, mask % 4); }
      catch (e) { ok(false, 'drawTile threw id=' + id + ' shape=' + shape + ' mask=' + mask + ': ' + e.message); }
    }
  }
}
ok(true, 'drawTile smoke over all ids/shapes/masks/paints');

// connected variants exercise connBits via TC.world peek
TC.world = w;
try {
  TC.Tiles.drawTile(ctx, TC.TILE.PLATFORM, 0, 0, 16, 5, 5, 0, 0, 0);
  TC.Tiles.drawTile(ctx, TC.TILE.ROPE, 0, 0, 16, 5, 6, 0, 0, 0);
  TC.Tiles.drawTile(ctx, TC.TILE.CHAIN, 0, 0, 16, 5, 7, 0, 0, 0);
  ok(true, 'connected patterns drew against live world');
} catch (e) { ok(false, 'connected pattern threw: ' + e.message); }

console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);

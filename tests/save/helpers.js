/* tests/save/helpers.js — suite-local helpers for the save torture tests.
   The canonical harness (tests/helpers/load-game.js) stays the only way the
   game is booted; everything here is thin sugar on top of it. */
'use strict';
const { loadGame } = require('../helpers/load-game.js');

// Simulate "same browser profile": copy every storage key into a fresh boot.
function cloneStorage(from, to) {
  from._map.forEach((v, k) => { to.setItem(k, v); });
}

function parseJson(storage, key) {
  const raw = storage.getItem(key);
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function parseV2(storage) { return parseJson(storage, 'tc_save_v2'); }

// Boot a fresh instance and start a new game deterministically.
function makeGame(seed) {
  const g = loadGame();
  g.TC.newGame(seed);
  return g;
}

// Deterministic expanding-square-ring scan around a center tile.
function findAround(w, cx, cy, rad, pred) {
  if (pred(cx, cy)) return [cx, cy];
  for (let r = 1; r <= rad; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (!w || x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
        if (pred(x, y)) return [x, y];
      }
    }
  }
  return null;
}

// Minable with a pick at toolPower 100+ (mirrors MineTile validate rules).
function minablePick(TC, tx, ty) {
  const id = TC.world.get(tx, ty);
  const td = TC.TILE_DEFS[id];
  return !!td && id !== TC.TILE.AIR && td.hardness > 0 && td.hardness < 9999 &&
    (td.minPower || 0) <= 100 && (td.tool === 'any' || td.tool === 'pick') &&
    id !== TC.TILE.CHEST;
}

// First underground cell (below `fromY`) that is minable and has a wall
// behind it — breaking it leaves an AIR+wall cell for MineWall.
function findUndergroundWalled(TC, cx, fromY, maxDepth) {
  const w = TC.world;
  for (let dy = 0; dy <= maxDepth; dy++) {
    const hit = findAround(w, cx, fromY + dy, 25, (tx, ty) =>
      ty > fromY + 1 && minablePick(TC, tx, ty) &&
      typeof w.getWall === 'function' && w.getWall(tx, ty) > 0);
    if (hit) return hit;
  }
  return null;
}

// Air cell with at least one non-air orthogonal neighbour (PlaceTile rule).
function findAnchoredAir(TC, cx, cy, rad) {
  const w = TC.world;
  return findAround(w, cx, cy, rad, (tx, ty) => {
    if (w.get(tx, ty) !== TC.TILE.AIR) return false;
    const around = [
      w.get(tx + 1, ty), w.get(tx - 1, ty),
      w.get(tx, ty + 1), w.get(tx, ty - 1)
    ];
    return around.some((v) => v != null && v !== TC.TILE.AIR);
  });
}

// Inventory slot index holding `id`, or -1.
function slotWith(inv, id) {
  if (!inv || !inv.slots) return -1;
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.get(i);
    if (s && s.id === id && s.count > 0) return i;
  }
  return -1;
}

module.exports = {
  loadGame, makeGame, cloneStorage, parseJson, parseV2,
  findAround, minablePick, findUndergroundWalled,
  findAnchoredAir, slotWith
};

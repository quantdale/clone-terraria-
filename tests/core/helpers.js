/* tests/core/helpers.js — shared setup for the core (registry/events/systems/
   commands) validation suite. Thin layer over tests/helpers/load-game.js. */
'use strict';
const { loadGame } = require('../helpers/load-game.js');

// Boot the real game headlessly and start a new seeded world.
function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 4242 : seed);
  return g;
}

// Event spy: per-name counters + payload log, installed via the real bus.
function spyEvents(TC, names) {
  const counts = {};
  const payloads = {};
  const offs = [];
  for (const n of names) {
    counts[n] = 0;
    payloads[n] = [];
    offs.push(TC.Events.on(n, (p) => { counts[n]++; payloads[n].push(p); }));
  }
  return {
    counts,
    payloads,
    count: (n) => counts[n] || 0,
    payloadsOf: (n) => payloads[n] || [],
    stop: () => { for (const f of offs) f(); }
  };
}

// First minable tile near spawn: reachable, pick-minable, air above it
// (so breaking it cannot support-pop anything and skew event counts).
function findMinableNearPlayer(TC) {
  const w = TC.world, p = TC.player, T = TC.TILE;
  const TS = TC.CONST.TS;
  const sx = Math.floor((p.x + p.w / 2) / TS);
  const sy = Math.floor((p.y + p.h) / TS);
  for (let dy = -1; dy <= 10; dy++) {
    for (let dx = -14; dx <= 14; dx++) {
      const tx = sx + dx, ty = sy + dy;
      const id = w.get(tx, ty);
      const d = TC.TILE_DEFS[id];
      if (!d || !(d.hardness > 0) || d.hardness >= 9999) continue;
      if ((d.minPower || 0) > 35) continue;
      if (d.tool !== 'any' && d.tool !== 'pick') continue;
      if (!d.drop) continue;                    // exactly-once tests count drops
      if (id === T.TRUNK || id === T.CHEST || id === T.POT || id === T.LIFE_CRYSTAL) continue;
      if (w.get(tx, ty - 1) !== T.AIR) continue;
      if (!p.inReach(tx, ty)) continue;
      return { tx, ty, id };
    }
  }
  return null;
}

// Empty anchored cell near the player: has a non-air orthogonal neighbour
// and does not overlap the player hitbox (valid PlaceTile target).
function findPlacementCell(TC) {
  const w = TC.world, p = TC.player, T = TC.TILE;
  const TS = TC.CONST.TS;
  const sx = Math.floor((p.x + p.w / 2) / TS);
  const sy = Math.floor((p.y + p.h) / TS);
  for (let dy = -6; dy <= 8; dy++) {
    for (let dx = -12; dx <= 12; dx++) {
      const tx = sx + dx, ty = sy + dy;
      if (w.get(tx, ty) !== T.AIR) continue;
      let anchored = false;
      const around = [w.get(tx + 1, ty), w.get(tx - 1, ty), w.get(tx, ty + 1), w.get(tx, ty - 1)];
      for (let i = 0; i < 4; i++) {
        if (around[i] != null && around[i] !== T.AIR) { anchored = true; break; }
      }
      if (!anchored) continue;
      const rx = tx * TS, ry = ty * TS;
      if (rx < p.x + p.w && rx + TS > p.x && ry < p.y + p.h && ry + TS > p.y) continue;
      if (!p.inReach(tx, ty)) continue;
      return { tx, ty };
    }
  }
  return null;
}

// Deep underground cell below the surface in some near-spawn column; used
// without a player ref so reach does not constrain command edits.
function findDeepMinable(TC) {
  const w = TC.world;
  const p = TC.player;
  const TS = TC.CONST.TS;
  const sx = Math.floor((p.x + p.w / 2) / TS);
  for (let tries = 0; tries < 96; tries++) {
    const tx = sx + (tries % 9) - 4;
    const ty = w.surfaceY[tx] + 6 + ((tries / 9) | 0);
    if (ty < 0 || ty >= w.height) continue;
    const id = w.get(tx, ty);
    const d = TC.TILE_DEFS[id];
    if (!d || !(d.hardness > 0) || d.hardness >= 9999) continue;
    if (id === TC.TILE.CHEST || id === TC.TILE.POT) continue;
    if (d.tool !== 'any' && d.tool !== 'pick') continue;
    return { tx, ty, id };
  }
  return null;
}

// Index of the first inventory slot holding `id` (-1 when absent).
function slotOf(inv, id) {
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.slots[i];
    if (s && s.id === id && s.count > 0) return i;
  }
  return -1;
}

// Silence console.warn/error around noisy sections (listener-throw tests).
function quietConsole(fn) {
  const realWarn = console.warn, realErr = console.error;
  console.warn = () => {};
  console.error = () => {};
  try { fn(); } finally { console.warn = realWarn; console.error = realErr; }
}

module.exports = { boot, spyEvents, findMinableNearPlayer, findPlacementCell,
  findDeepMinable, slotOf, quietConsole };

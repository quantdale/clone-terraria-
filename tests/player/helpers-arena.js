/* tests/player/helpers-arena.js — shared arena/simulation helpers for the
   player physics suites. Builds flat test arenas with world.setRaw around a
   teleported player, then drives player.update(dt) or moveAndCollide(dt)
   directly with synthetic velocities. */
'use strict';

const DT = 1 / 60;

// Boot the real game headlessly and start a new world.
function setup(seed) {
  const { loadGame } = require('../helpers/load-game.js');
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(typeof seed === 'number' ? seed : 4242);
  return { g, TC };
}

// Clear a rect (air) and lay a solid STONE floor row spanning [x0, x0+w).
function arena(TC, x0, floorRow, wTiles, clearRowsAbove) {
  const world = TC.world;
  const AIR = TC.TILE.AIR;
  const top = floorRow - (clearRowsAbove || 12);
  for (let ty = top; ty <= floorRow + 3; ty++) {
    for (let tx = x0 - 6; tx <= x0 + wTiles + 6; tx++) {
      world.setRaw(tx, ty, AIR);
    }
  }
  for (let tx = x0 - 6; tx <= x0 + wTiles + 6; tx++) {
    world.setRaw(tx, floorRow, TC.TILE.STONE);
    for (let ty = floorRow + 1; ty <= floorRow + 3; ty++) world.setRaw(tx, ty, TC.TILE.STONE);
  }
  return { x0: x0 - 6, x1: x0 + wTiles + 6, floorTop: floorRow * TC.CONST.TS };
}

// Place the player at a pixel spot with all motion state zeroed.
function place(TC, px, py) {
  const p = TC.player;
  p.x = px; p.y = py;
  p.vx = 0; p.vy = 0;
  p.onGround = false;
  p.fallTiles = 0;
  p.dropT = 0;
  p.iframes = 0;
  return p;
}

// Run full update() frames; keeps vx pinned to keepPinVx when given
// (friction would otherwise bleed synthetic speeds off).
function runFrames(TC, n, keepPinVx) {
  const p = TC.player;
  const trace = [];
  for (let i = 0; i < n; i++) {
    if (keepPinVx !== undefined) p.vx = keepPinVx;
    p.update(DT);
    trace.push({ x: p.x, y: p.y, vy: p.vy, onGround: p.onGround });
  }
  return trace;
}

// Drive only gravity-free synthetic kinematics through moveAndCollide.
function driveCollide(TC, n, vx, vy) {
  const p = TC.player;
  for (let i = 0; i < n; i++) {
    p.vx = vx; p.vy = vy;
    p.moveAndCollide(DT);
  }
}

const feetOf = (p) => p.y + p.h;

module.exports = { DT, setup, arena, place, runFrames, driveCollide, feetOf };

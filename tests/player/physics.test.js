/* tests/player/physics.test.js — shape-physics torture matrix against the REAL
   scripts (headless vm boot via tests/helpers/load-game.js). Builds flat arenas
   with world.setRaw around a teleported player and drives vx/vy directly. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DT, setup, arena, place, runFrames, driveCollide, feetOf } = require('./helpers-arena.js');

// ---- 1. FULL floor regression baseline -------------------------------------
test('physics FULL: falling player lands exactly at the tile top boundary', () => {
  const { TC } = setup(101);
  const F = 60;
  arena(TC, 100, F, 12);
  const p = place(TC, 105 * TC.CONST.TS, (F - 6) * TC.CONST.TS);
  runFrames(TC, 90);
  const tileTop = F * TC.CONST.TS;
  assert.ok(Math.abs(feetOf(p) - tileTop) < 0.02,
    'feet should rest on the tile top, got ' + feetOf(p) + ' vs ' + tileTop);
  assert.strictEqual(p.onGround, true);
  assert.strictEqual(p.vy, 0);
});

// ---- 2a. PLATFORM: lands from above ----------------------------------------
test('physics PLATFORM: falls from above onto the deck (one-way top)', () => {
  const { TC } = setup(102);
  const P = 60;
  const { x0 } = arena(TC, 100, P + 8, 12);
  // replace the would-be floor row with a pure platform deck, air everywhere else
  for (let tx = x0; tx <= x0 + 24; tx++) {
    for (let ty = P + 1; ty <= P + 11; ty++) TC.world.setRaw(tx, ty, TC.TILE.AIR);
    TC.world.setRaw(tx, P + 8, TC.TILE.AIR);
    TC.world.setRaw(tx, P, TC.TILE.PLATFORM);
  }
  const deckTop = P * TC.CONST.TS + TC.CONST.TS * 5 / 16;
  const p = place(TC, 104 * TC.CONST.TS, (P - 6) * TC.CONST.TS);
  runFrames(TC, 90);
  assert.ok(Math.abs(feetOf(p) - deckTop) < 0.02,
    'should rest on deck top ' + deckTop + ', got feet=' + feetOf(p));
  assert.strictEqual(p.onGround, true);
  assert.strictEqual(p.vy, 0);
});

// ---- 2b. PLATFORM: rising from below passes through ------------------------
test('physics PLATFORM: jumping up from below passes through the deck', () => {
  const { TC } = setup(103);
  const P = 60;
  const { x0 } = arena(TC, 100, P + 8, 12);
  for (let tx = x0; tx <= x0 + 24; tx++) {
    TC.world.setRaw(tx, P + 8, TC.TILE.AIR);
    TC.world.setRaw(tx, P, TC.TILE.PLATFORM);
  }
  const deckTop = P * TC.CONST.TS + TC.CONST.TS * 5 / 16;
  // start fully below the deck, head under the band
  const p = place(TC, 104 * TC.CONST.TS, (P + 4) * TC.CONST.TS);
  let crossed = false;
  for (let i = 0; i < 60; i++) {
    p.vy = -320;                       // pinned synthetic upward velocity
    p.update(DT);
    if (feetOf(p) < deckTop) { crossed = true; break; }
  }
  assert.ok(crossed, 'player must rise through a platform from below');
});

// ---- 2c. PLATFORM: dropT gate drops through decks only ----------------------
test('physics dropT: deck becomes passable while dropT runs; HALF/slope stay solid', () => {
  const { TC } = setup(104);
  const SHP = TC.Shapes;
  const R = 60;
  const { x0 } = arena(TC, 100, R, 12);
  // deck of platforms at row R-1 over a stone floor at row R
  for (let tx = x0 + 2; tx <= x0 + 6; tx++) TC.world.setRaw(tx, R - 1, TC.TILE.PLATFORM);
  const deckTop = (R - 1) * TC.CONST.TS + TC.CONST.TS * 5 / 16;

  // stand on the deck, then trigger the drop gate
  let p = place(TC, 102 * TC.CONST.TS, (R - 5) * TC.CONST.TS);
  runFrames(TC, 90);
  assert.strictEqual(p.onGround, true, 'precondition: settled on deck');
  p.dropT = 0.25;
  runFrames(TC, 30);
  assert.ok(!p.onGround || feetOf(p) > deckTop + 4,
    'player must fall through the deck while dropT>0');

  // HALF under the feet: dropT must NOT open a hole
  TC.world.setRaw(102, R - 1, TC.TILE.STONE);
  TC.world.setShape(102, R - 1, SHP.HALF);
  p = place(TC, 102 * TC.CONST.TS, (R - 5) * TC.CONST.TS);
  runFrames(TC, 90);
  assert.strictEqual(p.onGround, true, 'precondition: settled on HALF');
  const halfFeet = feetOf(p);
  p.dropT = 0.25;
  runFrames(TC, 30);
  assert.strictEqual(p.onGround, true, 'dropT must not pass a HALF block');
  assert.ok(Math.abs(feetOf(p) - halfFeet) < 0.5, 'still resting on the HALF surface');

  // SLOPE_SE under the feet: same guarantee
  TC.world.setShape(102, R - 1, SHP.SLOPE_SE);
  p = place(TC, 102 * TC.CONST.TS, (R - 5) * TC.CONST.TS);
  runFrames(TC, 90);
  assert.strictEqual(p.onGround, true, 'precondition: settled on slope');
  p.dropT = 0.25;
  runFrames(TC, 30);
  assert.strictEqual(p.onGround, true, 'dropT must not pass a ground slope');
});

// ---- 3. HALF block surface height -------------------------------------------
test('physics HALF: stands at tileTop + TS/2', () => {
  const { TC } = setup(105);
  const SHP = TC.Shapes;
  const R = 60;
  const { x0 } = arena(TC, 100, R, 12);
  TC.world.setRaw(103, R - 1, TC.TILE.STONE);
  TC.world.setShape(103, R - 1, SHP.HALF);
  const want = (R - 1) * TC.CONST.TS + TC.CONST.TS / 2;
  const p = place(TC, 103 * TC.CONST.TS + 2, (R - 6) * TC.CONST.TS);
  runFrames(TC, 90);
  assert.ok(Math.abs(feetOf(p) - want) < 0.02,
    'feet should rest at half height ' + want + ', got ' + feetOf(p));
  assert.strictEqual(p.onGround, true);
});

// ---- 5. High-velocity tunneling guard ---------------------------------------
test('physics tunneling: vy=1200 does not punch through a 1-tile floor', () => {
  const { TC } = setup(106);
  const F = 60;
  arena(TC, 100, F, 12);
  const tileTop = F * TC.CONST.TS;
  const p = place(TC, 105 * TC.CONST.TS, tileTop - 3 * TC.CONST.TS);
  let worst = Infinity;
  for (let i = 0; i < 40; i++) {
    p.vy = 1200;
    p.moveAndCollide(DT);
    worst = Math.min(worst, tileTop - feetOf(p)); // negative => sank below floor
    if (p.onGround && p.vy === 0 && feetOf(p) <= tileTop) break;
  }
  assert.ok(feetOf(p) <= tileTop + 0.02,
    'must end resting on the floor top, got feet=' + feetOf(p));
  assert.ok(worst >= -0.02, 'never sank below the floor (worst overshoot ' + worst + ')');
  assert.strictEqual(Number.isFinite(p.x) && Number.isFinite(p.y), true);
});

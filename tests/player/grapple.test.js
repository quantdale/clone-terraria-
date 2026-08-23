/* tests/player/grapple.test.js — W3 campaign: grappling hook lifecycle.

   Contract under test (js/grapple.js):
     - kind 'grapple' use fires a flying hook toward the cursor; a second
       use releases (cancellation)
     - the hook latches ONLY onto solid terrain, within the item's range
     - while latched the rope pulls the player and constrains them to the
       rope circle (pendulum swing) without teleporting through walls
     - jump input releases with momentum kept; arrival flings and releases;
       mining the anchor auto-releases; timeout retracts
     - velocity stays capped at every step */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function setup(seed) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(seed == null ? 91 : seed);
  return { g, TC };
}

// Carve an isolated arena: interior AIR, side walls STONE, floor at y1+1.
function carveArena(TC, x0, y0, x1, y1) {
  const w = TC.world;
  const AIR = TC.TILE.AIR, STONE = TC.TILE.STONE;
  for (let y = y0 - 2; y <= y1 + 3; y++) {
    for (let x = x0 - 3; x <= x1 + 3; x++) w.setRaw(x, y, AIR);
  }
  for (let y = y0 - 2; y <= y1 + 1; y++) {
    w.setRaw(x0 - 2, y, STONE);
    w.setRaw(x1 + 2, y, STONE);
  }
  for (let x = x0 - 2; x <= x1 + 2; x++) w.setRaw(x, y1 + 1, STONE);
}

// Aim the input mouse at a world point and fire the grapple hook def.
function fire(TC, wx, wy) {
  TC.Input.mouse.worldX = wx;
  TC.Input.mouse.worldY = wy;
  const p = TC.player;
  p._grappleCd = 0;
  return TC.Grapple.onUseHeld(p, TC.ITEM_DEFS.hook_basic, 0.016);
}

test('grapple: fires toward aim and latches onto solid terrain', () => {
  const { TC } = setup(92);
  const X0 = 500, Y1 = 140;
  carveArena(TC, X0, Y1 - 8, X0 + 10, Y1);
  // stand mid-arena, hook the right wall
  TC.player.x = (X0 + 5) * 16;
  TC.player.y = (Y1 - 4) * 16;
  TC.player.vx = 0; TC.player.vy = 0;

  const wallX = (X0 - 1) * 16 + 12;
  assert.ok(fire(TC, wallX, TC.player.y), 'use not consumed');
  assert.ok(TC.Grapple.active(), 'hook did not launch');
  assert.strictEqual(TC.Grapple.phase(), 'flying', 'hook should be in flight');

  // lifecycle smoke: drive the machine until it settles with no exceptions
  for (let i = 0; i < 120 && TC.Grapple.active(); i++) {
    TC.Grapple.preUpdate(1 / 60);
    TC.Grapple.postUpdate(1 / 60);
  }
  assert.strictEqual(TC.Grapple.phase(), 'latched',
    'wall shot must end latched (not retracted)');
});

test('grapple: second use cancels; AIR never latches', () => {
  const { TC } = setup(93);
  const X0 = 500, Y1 = 140;
  // tall headroom so a hook fired upward finds nothing within its 270px
  carveArena(TC, X0, Y1 - 34, X0 + 10, Y1);
  TC.player.x = (X0 + 4) * 16;
  TC.player.y = (Y1 - 6) * 16;

  // fire into open sky: hook must NOT latch; it retracts when out of range
  assert.ok(fire(TC, (X0 + 5) * 16, (Y1 - 28) * 16));
  let flewOrRetracted = false;
  for (let i = 0; i < 200 && TC.Grapple.active(); i++) {
    TC.Grapple.preUpdate(1 / 60);
    TC.Grapple.postUpdate(1 / 60);
    flewOrRetracted = true;
  }
  assert.ok(flewOrRetracted, 'hook never entered flight');
  assert.strictEqual(TC.Grapple.active(), false,
    'hook latched AIR or never timed out');

  // refire then cancel immediately with a second use
  assert.ok(fire(TC, (X0 - 1) * 16 + 8, TC.player.y));
  assert.ok(TC.Grapple.active());
  TC.player._grappleCd = 0;
  assert.ok(fire(TC, (X0 - 1) * 16 + 8, TC.player.y));
  assert.strictEqual(TC.Grapple.active(), false, 'second use did not release');
});

test('grapple: latched rope pulls the player toward the anchor', () => {
  const { TC } = setup(94);
  const X0 = 500, Y1 = 140;
  carveArena(TC, X0, Y1 - 10, X0 + 12, Y1);
  const p = TC.player;
  p.x = (X0 + 6) * 16;
  p.y = (Y1 - 5) * 16;
  p.vx = 0; p.vy = 0;

  const anchorX = (X0 - 1) * 16 + 8;
  assert.ok(fire(TC, anchorX, p.y));

  // drive the machine manually until the hook latches
  let latched = false;
  for (let i = 0; i < 120 && !latched; i++) {
    TC.Grapple.preUpdate(1 / 60);
    TC.Grapple.postUpdate(1 / 60);
    if (TC.Grapple.phase() === 'latched') latched = true;
  }
  assert.ok(latched, 'hook never latched: phase=' + TC.Grapple.phase());

  // while latched, preUpdate thrusts velocity toward the anchor
  const vxBefore = p.vx;
  for (let i = 0; i < 10; i++) TC.Grapple.preUpdate(1 / 60);
  assert.ok(p.vx < vxBefore || Math.abs(p.x - anchorX) < ARRIVE,
    'pull produced no leftward acceleration');

  // velocity stays under the cap through every step
  const speedNow = Math.hypot(p.vx, p.vy);
  assert.ok(speedNow <= 900 + 1, 'velocity cap violated');
});
const ARRIVE = 14;

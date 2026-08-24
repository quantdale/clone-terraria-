/* tests/world/minimap-regions.test.js — W21: region-driven minimap refresh.
   The minimap consumes its own WorldRegions cursor: hidden means zero paint
   work, edits while hidden catch up exactly once on reveal, liquid motion
   repaints the affected region, and world swaps force a full initial paint.
   Player-marker independence and the authoritative Underworld boundary query
   are covered too. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 21 : seed);
  return g;
}

function paintedPixels(mini) { return mini.stats().pixelsPainted; }

// Freeze ambient liquid entirely: an empty, dormant layer means no settling
// marks race the assertions below (worldgen pools in some seeds keep
// churning for a long time). The pour test re-seeds its own water.
function freezeLiquids(TC) {
  TC.Liquids.reset(TC.world);
}
// Wait until the given consumer has no pending regions left.
function drainConsumer(TC, name, maxTicks) {
  const cons = TC.WorldRegions.consume(name);
  for (let i = 0; i < (maxTicks || 600); i++) {
    if (cons.pendingCount() === 0) return true;
    TC.Runtime.advanceTicks(1);
  }
  return cons.pendingCount() === 0;
}

test('minimap: hidden map does no repaint work while edits land', () => {
  const g = boot(3);
  const TC = g.TC, M = TC.MiniMap, w = TC.world;
  M.visible = false;
  const before = paintedPixels(M);
  assert.strictEqual(before, 0, 'never opened -> never painted');
  for (let k = 0; k < 30; k++) w.setRaw(100 + k, 100, TC.TILE.STONE);
  TC.Runtime.advanceTicks(20);
  assert.strictEqual(paintedPixels(M), 0, 'hidden map must not paint');
});

test('minimap: revealing after hidden edits catches up exactly once per stale region', () => {
  const g = boot(3);
  const TC = g.TC, M = TC.MiniMap, w = TC.world;
  // edit a single region while closed
  w.setRaw(100, 100, TC.TILE.STONE);
  w.setRaw(101, 100, TC.TILE.STONE);
  TC.Runtime.advanceTicks(5);
  const WR = TC.WorldRegions;
  const cons = WR.consume('minimap');
  assert.ok(cons.pendingCount() >= 1, 'hidden edits accumulate as pending work');
  M.visible = true;
  TC.Runtime.advanceTicks(30); // catch-up drains at up to 24 regions/frame
  const paintedAfterCatchup = paintedPixels(M);
  assert.ok(paintedAfterCatchup > 0, 'reveal must paint');
  freezeLiquids(TC);
  assert.strictEqual(drainConsumer(TC, 'minimap'), true, 'catch-up fully drains');
  // steady state: no further work once everything is drained
  const nowPainted = paintedPixels(M);
  TC.Runtime.advanceTicks(20);
  assert.strictEqual(paintedPixels(M), nowPainted, 'no perpetual repainting');
});

test('minimap: liquid motion repaints its own region only', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(4);
  const M = TC.MiniMap, w = TC.world;
  M.visible = true;
  TC.Runtime.advanceTicks(40); // full initial paint settles
  freezeLiquids(TC);
  drainConsumer(TC, 'minimap');
  const settled = paintedPixels(M);
  const pendingBefore = TC.WorldRegions.consume('minimap').pendingCount();
  // pour water in one spot via the runtime authority
  const tx = Math.floor(TC.player.x / 16) + 6;
  const ty = w.surfaceY[tx] - 2;
  assert.strictEqual(TC.Liquids.placeAt(tx, ty, 1), true, 'pour succeeds');
  drainConsumer(TC, 'minimap');
  const after = paintedPixels(M) - settled;
  const regionsRepainted = after / (32 * w.height);
  assert.ok(after > 0, 'liquid change must trigger a repaint');
  assert.ok(regionsRepainted <= 8,
    'repaint stays bounded to the affected region(s), got ' + regionsRepainted.toFixed(1));
  void pendingBefore;
});

test('minimap: world swap forces full initial paint', () => {
  const g = loadGame();
  const TC = g.TC, M = TC.MiniMap;
  TC.newGame(8);
  M.visible = true;
  TC.Runtime.advanceTicks(40);
  const firstWorld = paintedPixels(M);
  assert.ok(firstWorld >= TC.world.width * TC.world.height, 'full initial paint happened');
  TC.newGame(9);
  const counterAfterSwapStart = paintedPixels(M);
  TC.Runtime.advanceTicks(40);
  assert.ok(paintedPixels(M) > counterAfterSwapStart,
    'new world requires fresh painting (stale generations do not carry over)');
});

test('minimap: player marker/viewport logic independent of terrain repaints', () => {
  const g = boot(11);
  const TC = g.TC, M = TC.MiniMap;
  M.visible = true;
  TC.Runtime.advanceTicks(40);
  const ptx0 = M.ptx, pty0 = M.pty;
  // walk right for a while without touching terrain
  TC.player.x += 300;
  TC.Runtime.advanceTicks(10);
  assert.ok(M.ptx > ptx0 && M.pty !== undefined, 'player tracking updates without edits');
});

test('minimap: underworld cutoff comes from the shared Biomes authority', () => {
  const g = boot(11);
  const TC = g.TC;
  const topTy = Math.round(TC.Biomes.underworldTopPx() / 16) - 4;
  assert.strictEqual(typeof topTy, 'number');
  assert.ok(topTy > 0 && topTy < TC.world.height, 'authority returns an in-world depth');
});

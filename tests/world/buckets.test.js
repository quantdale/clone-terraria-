/* tests/world/buckets.test.js — W1 campaign: canonical bucket interactions.
   Buckets are the player-facing surface of the authoritative TC.Liquids
   layer: an empty bucket scoops a settled cell (>= COLLECT_MIN volume) and
   converts in place; a filled bucket pours a FULL cell into an empty,
   non-solid one and reverts to empty. Held-item conversion must never
   destroy items or duplicate them. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function setup(seed) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(seed == null ? 5 : seed);
  return { g, TC };
}

// Carve an isolated arena: interior AIR, side walls STONE, floor at y1+1.
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

// Point the input mouse at a world tile and fire the Liquids use hook.
// Clears the per-use cooldown so a test may chain several deliberate uses.
function aimUse(TC, tx, ty) {
  TC.Input.mouse.worldX = tx * 16 + 8;
  TC.Input.mouse.worldY = ty * 16 + 8;
  const p = TC.player;
  p._bucketCd = 0;
  const def = TC.ITEM_DEFS[p.selectedSlot().id];
  return TC.Liquids.onUseHeld(p, def, 0.016);
}

function give(TC, id, slot) {
  const inv = TC.player.inventory;
  inv.slots[slot] = { id, count: 1 };
}

test('buckets: filled bucket pours a FULL cell and reverts to empty', () => {
  const { TC } = setup(61);
  const X = 500, Y1 = 130;
  carveArena(TC, X - 3, Y1 - 3, X + 3, Y1);
  give(TC, 'bucket_water', 0);

  assert.ok(aimUse(TC, X, Y1), 'use hook did not claim the click');
  assert.strictEqual(TC.Liquids.sampleAt(X * 16 + 8, Y1 * 16 + 8).amount,
    TC.Liquids.FULL, 'poured cell is not FULL');
  assert.strictEqual(TC.player.inventory.slots[0].id, 'bucket',
    'filled bucket did not revert to empty');

  // pouring into a solid cell fails and keeps the filled bucket
  carveArena(TC, X - 3, Y1 - 3, X + 3, Y1);
  give(TC, 'bucket_water', 0);
  TC.world.set(X, Y1, TC.TILE.STONE);
  assert.ok(aimUse(TC, X, Y1));
  assert.strictEqual(TC.player.inventory.slots[0].id, 'bucket_water',
    'bucket consumed by a failed pour');
});

test('buckets: empty bucket scoops a settled cell; films refuse', () => {
  const { TC } = setup(62);
  const X = 520, Y1 = 130;
  carveArena(TC, X - 3, Y1 - 3, X + 3, Y1);
  TC.Liquids.set(X, Y1, TC.Liquids.TYPE.WATER, 255);
  give(TC, 'bucket', 0);

  assert.ok(aimUse(TC, X, Y1));
  assert.strictEqual(TC.Liquids.sampleAt(X * 16 + 8, Y1 * 16 + 8).amount, 0,
    'scooped cell still holds liquid');
  assert.strictEqual(TC.player.inventory.slots[0].id, 'bucket_water',
    'empty bucket did not fill');

  // thin film (< COLLECT_MIN) cannot be scooped
  give(TC, 'bucket', 0);
  TC.Liquids.set(X, Y1, TC.Liquids.TYPE.WATER, 10);
  assert.ok(aimUse(TC, X, Y1));
  assert.strictEqual(TC.player.inventory.slots[0].id, 'bucket',
    'a puddle film was scoopable');
});

test('buckets: lava scoops to a lava bucket; honey round-trips', () => {
  const { TC } = setup(63);
  const X = 540, Y1 = 130;
  carveArena(TC, X - 3, Y1 - 3, X + 3, Y1);
  TC.Liquids.set(X, Y1, TC.Liquids.TYPE.LAVA, 255);
  give(TC, 'bucket', 0);
  aimUse(TC, X, Y1);
  assert.strictEqual(TC.player.inventory.slots[0].id, 'bucket_lava');

  carveArena(TC, X - 3, Y1 - 3, X + 3, Y1);
  give(TC, 'bucket_lava', 0);
  aimUse(TC, X, Y1);
  assert.strictEqual(
    TC.Liquids.sampleAt(X * 16 + 8, Y1 * 16 + 8).type, TC.Liquids.TYPE.LAVA);

  TC.Liquids.displace(X, Y1);
  give(TC, 'bucket_honey', 0);
  aimUse(TC, X, Y1);
  assert.strictEqual(
    TC.Liquids.sampleAt(X * 16 + 8, Y1 * 16 + 8).type, TC.Liquids.TYPE.HONEY);
});

test('buckets: cooldown swallows held clicks without consuming anything', () => {
  const { TC } = setup(64);
  const X = 560, Y1 = 130;
  carveArena(TC, X - 3, Y1 - 3, X + 3, Y1);
  give(TC, 'bucket_water', 0);
  assert.ok(aimUse(TC, X, Y1)); // sets _bucketCd = BUCKET_CD
  // immediately reuse while hot: hook claims the click but nothing changes
  give(TC, 'bucket_water', 0); // pretend we still hold water (test harness)
  TC.Input.mouse.worldX = (X + 1) * 16 + 8;
  TC.Input.mouse.worldY = Y1 * 16 + 8;
  assert.ok(TC.Liquids.onUseHeld(TC.player,
    TC.ITEM_DEFS[TC.player.selectedSlot().id], 0.016));
  assert.strictEqual(TC.Liquids.sampleAt((X + 1) * 16 + 8, Y1 * 16 + 8).amount, 0,
    'cooldown window poured anyway');
});

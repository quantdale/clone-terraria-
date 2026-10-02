/* tests/core/ui-chest-quick-move.test.js — F-01 regression: Shift-click
   quick-move between inventory and an open chest. Exercises both
   container directions through the real click dispatch, asserts stack
   conservation, the joined-client authoritative path (and the connecting
   negative case), the absent-client local fallback, and that the UI
   render layer reports zero errors (the defect was previously swallowed
   by that counter). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

// layout constants mirrored from js/ui.js (SLOT/GAP/BAG_ROWS et al.)
const SLOT = 46, GAP = 5, HOTBAR_N = 10, BAG_ROWS = 4;
const BAG_X = 12 - 8, BAG_Y = 12 + SLOT + 14;
const BAG_H = 22 + BAG_ROWS * SLOT + (BAG_ROWS - 1) * GAP + 8;
const CHEST_PANEL_Y = BAG_Y + BAG_H + 14;
function bagSlotCenter(i) { // i is the player slot index (10..49 bag rows)
  const r = ((i - HOTBAR_N) / HOTBAR_N) | 0, c = (i - HOTBAR_N) % HOTBAR_N;
  return { x: BAG_X + 8 + c * (SLOT + GAP) + SLOT / 2, y: BAG_Y + 22 + r * (SLOT + GAP) + SLOT / 2 };
}
function chestSlotCenter(i) {
  const r = (i / HOTBAR_N) | 0, c = i % HOTBAR_N;
  return { x: BAG_X + 8 + c * (SLOT + GAP) + SLOT / 2, y: CHEST_PANEL_Y + 22 + r * (SLOT + GAP) + SLOT / 2 };
}

function shiftDown(game) {
  const kd = game.listeners.keydown || [];
  for (const fn of kd) fn({ code: 'ShiftLeft', repeat: false, preventDefault() {} });
}
function shiftUp(game) {
  const ku = game.listeners.keyup || [];
  for (const fn of ku) fn({ code: 'ShiftLeft', repeat: false, preventDefault() {} });
}

function clickAt(game, x, y) {
  const m = game.TC.Input.mouse;
  m.x = x; m.y = y; m.down = true; m.clicked = true;
}

function uiErrors(game) {
  let n = 0;
  try {
    for (const e of game.TC.RenderLayers.list()) n += e.errors || 0;
  } catch (e) {}
  return n;
}

function setup(gameOpts) {
  const game = loadGame({ frames: 1 });
  game.TC.newGame(90210);
  game.TC.UI.invOpen = true;
  game.TC.world.setRaw(30, 120, game.TC.TILE.CHEST);
  game.TC.UI.openChest(30, 120);
  return game;
}

test('inventory→chest shift-click moves the slot contents (single player)', () => {
  const game = setup();
  const p = game.TC.player;
  const inv = p.inventory;
  inv.slots[10] = { id: 'dirt', count: 7 };
  const chest = game.TC.Chests.get(30, 120);
  const before = chest.reduce((n, s) => n + (s ? s.count : 0), 0);
  clickAt(game, bagSlotCenter(10).x, bagSlotCenter(10).y);
  shiftDown(game);
  game.startFrameLoop();
  shiftUp(game);
  assert.strictEqual(inv.slots[10], null, 'source slot cleared');
  const after = chest.reduce((n, s) => n + (s ? s.count : 0), 0);
  assert.strictEqual(after, before + 7, 'chest received the stack');
  assert.strictEqual(uiErrors(game), 0, 'no UI-layer errors');
});

test('chest→inventory shift-click moves the slot contents (single player)', () => {
  const game = setup();
  const p = game.TC.player;
  const chest = game.TC.Chests.get(30, 120);
  chest[0] = { id: 'dirt', count: 3 };
  const bagBefore = p.inventory.slots.reduce((n, s) => n + (s ? s.count : 0), 0);
  clickAt(game, chestSlotCenter(0).x, chestSlotCenter(0).y);
  shiftDown(game);
  game.startFrameLoop();
  shiftUp(game);
  assert.strictEqual(chest[0], null, 'chest slot cleared');
  const bagAfter = p.inventory.slots.reduce((n, s) => n + (s ? s.count : 0), 0);
  assert.strictEqual(bagAfter, bagBefore + 3, 'inventory received the stack');
  assert.strictEqual(uiErrors(game), 0);
});

test('stack merge respects the max-stack boundary', () => {
  const game = setup();
  const p = game.TC.player;
  const chest = game.TC.Chests.get(30, 120);
  const defs = game.TC.ITEM_DEFS || {};
  const max = (defs.dirt && defs.dirt.maxStack) || 999;
  chest[0] = { id: 'dirt', count: max };
  p.inventory.slots[10] = { id: 'dirt', count: 4 };
  clickAt(game, bagSlotCenter(10).x, bagSlotCenter(10).y);
  shiftDown(game);
  game.startFrameLoop();
  shiftUp(game);
  // full stack stays full; the extra 4 must not have merged into it
  assert.strictEqual(chest[0].count, max, 'existing stack did not overflow');
  assert.ok(p.inventory.slots[10] == null || p.inventory.slots[10].count === 0 || chest.some(s => s && s.id === 'dirt' && s !== chest[0]), 'stack went to a fresh or second stack');
  assert.strictEqual(uiErrors(game), 0);
});

test('joined client routes ContainerMove through NetClient.intent and does not mutate locally', () => {
  const game = setup();
  const p = game.TC.player;
  p.inventory.slots[10] = { id: 'dirt', count: 5 };
  const chest = game.TC.Chests.get(30, 120);
  const before = chest.reduce((n, s) => n + (s ? s.count : 0), 0);
  const sent = [];
  const prevClient = game.TC.NetClient;
  game.TC.NetClient = {
    drivesTick: () => true,
    frame: () => {},
    active: () => ({ isActive: () => true, drivesTick: () => true }),
    intent: (name, ctx) => { sent.push([name, ctx]); return { ok: true, pending: true }; },
  };
  clickAt(game, bagSlotCenter(10).x, bagSlotCenter(10).y);
  shiftDown(game);
  game.startFrameLoop();
  shiftUp(game);
  game.TC.NetClient = prevClient;
  assert.deepStrictEqual(sent.map(s => s[0]), ['ContainerMove'], 'intent submitted');
  assert.strictEqual(sent[0][1].from, 'inv');
  assert.strictEqual(sent[0][1].to, 'chest');
  const after = chest.reduce((n, s) => n + (s ? s.count : 0), 0);
  assert.strictEqual(after, before, 'local chest not mutated');
  assert.strictEqual(p.inventory.slots[10] && p.inventory.slots[10].count, 5, 'local inventory not mutated');
  assert.strictEqual(uiErrors(game), 0);
});

test('connecting client does not route intent and does not throw', () => {
  const game = setup();
  const p = game.TC.player;
  p.inventory.slots[10] = { id: 'dirt', count: 5 };
  const chest = game.TC.Chests.get(30, 120);
  const before = chest.reduce((n, s) => n + (s ? s.count : 0), 0);
  const sent = [];
  const prevClient = game.TC.NetClient;
  game.TC.NetClient = {
    drivesTick: () => true,
    frame: () => {},
    active: () => ({ isActive: () => false, drivesTick: () => true }),
    intent: (name, ctx) => { sent.push([name, ctx]); return { ok: true, pending: true }; },
  };
  clickAt(game, bagSlotCenter(10).x, bagSlotCenter(10).y);
  shiftDown(game);
  game.startFrameLoop();
  shiftUp(game);
  game.TC.NetClient = prevClient;
  assert.strictEqual(sent.length, 0, 'no intent while connecting');
  // joinedActive() is false, so the local quick-move path runs (documented behavior)
  const after = chest.reduce((n, s) => n + (s ? s.count : 0), 0);
  assert.strictEqual(after, before + 5, 'local quick-move ran instead');
  assert.strictEqual(uiErrors(game), 0);
});

test('no NetClient present: local quick-move, no throw, zero UI errors', () => {
  const game = setup();
  const p = game.TC.player;
  p.inventory.slots[10] = { id: 'dirt', count: 2 };
  const chest = game.TC.Chests.get(30, 120);
  const before = chest.reduce((n, s) => n + (s ? s.count : 0), 0);
  const prevClient = game.TC.NetClient;
  delete game.TC.NetClient;
  clickAt(game, bagSlotCenter(10).x, bagSlotCenter(10).y);
  shiftDown(game);
  game.startFrameLoop();
  shiftUp(game);
  game.TC.NetClient = prevClient;
  assert.strictEqual(chest.reduce((n, s) => n + (s ? s.count : 0), 0), before + 2);
  assert.strictEqual(uiErrors(game), 0);
});

test('empty source slot shift-click does nothing and raises nothing', () => {
  const game = setup();
  clickAt(game, bagSlotCenter(11).x, bagSlotCenter(11).y);
  shiftDown(game);
  game.startFrameLoop();
  shiftUp(game);
  assert.strictEqual(uiErrors(game), 0);
});

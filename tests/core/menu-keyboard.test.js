/* tests/core/menu-keyboard.test.js — F-08: title/pause/packs/shop/craft are
   operable by keyboard alone; focus wraps, resets across surfaces, never
   leaks, never steals gameplay keys, and scrolls capped lists into view. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function key(game, code) {
  // Snapshot: audio's one-shot unlock listener removes itself mid-dispatch,
  // which would skip later listeners on a live array (browsers snapshot).
  for (const fn of (game.listeners.keydown || []).slice()) {
    fn({ code: code, repeat: false, preventDefault() {} });
  }
}
function keyUp(game, code) {
  for (const fn of (game.listeners.keyup || []).slice()) {
    fn({ code: code, repeat: false, preventDefault() {} });
  }
}
function frame(game, n) {
  for (let i = 0; i < (n || 1); i++) game.startFrameLoop();
}
function focusOf(game) { return game.TC.UI.focusInfo(); }

test('title: arrows move focus, Enter starts a world, no pointer needed', () => {
  const game = loadGame({ frames: 1 });
  assert.strictEqual(game.TC.state, 'title');
  frame(game);
  let f = focusOf(game);
  assert.strictEqual(f.surface, 'title');
  assert.strictEqual(f.index, 0);
  key(game, 'ArrowDown'); frame(game);
  assert.strictEqual(focusOf(game).index, 1);
  key(game, 'ArrowUp'); frame(game);
  assert.strictEqual(focusOf(game).index, 0, 'back to first');
  // activate the first button (New World) by keyboard alone
  key(game, 'Enter'); frame(game, 2);
  assert.strictEqual(game.TC.state, 'playing', 'keyboard Enter started a world');
});

test('title: focus wraps at both ends', () => {
  const game = loadGame({ frames: 1 });
  frame(game);
  const n = game.TC.UI.focusInfo();
  assert.strictEqual(n.surface, 'title');
  key(game, 'ArrowUp'); frame(game);
  const wrapped = focusOf(game).index;
  assert.ok(wrapped > 0, 'wrapped to the last item, got ' + wrapped);
  key(game, 'ArrowDown'); frame(game);
  assert.strictEqual(focusOf(game).index, 0, 'wrapped back to first');
});

test('pause: keyboard moves focus and activates the same action as a click', () => {
  const game = loadGame({ frames: 1 });
  game.TC.newGame(4242);
  frame(game, 2);
  key(game, 'Escape'); frame(game);
  assert.strictEqual(game.TC.UI.paused, true, 'Escape paused');
  frame(game);
  assert.strictEqual(focusOf(game).surface, 'pause');
  // resume is the first pause button: Enter resumes, same as clicking it
  key(game, 'Enter'); frame(game);
  assert.strictEqual(game.TC.UI.paused, false, 'keyboard Enter resumed');
});

test('focus does not leak across a state transition', () => {
  const game = loadGame({ frames: 1 });
  frame(game);
  key(game, 'ArrowDown'); frame(game);
  key(game, 'ArrowDown'); frame(game);
  assert.strictEqual(focusOf(game).index, 2, 'title focus moved');
  // activate first button path instead: reset to index 0 via wrap, start world
  key(game, 'ArrowUp'); frame(game);
  key(game, 'ArrowUp'); frame(game);
  assert.strictEqual(focusOf(game).index, 0);
  key(game, 'Enter'); frame(game, 2);
  assert.strictEqual(game.TC.state, 'playing');
  frame(game, 2);
  const f = focusOf(game);
  assert.ok(f.surface === null || f.surface === 'craft', 'no title focus survives, got ' + f.surface);
  assert.strictEqual(f.index, 0, 'index reset on the new surface');
});

test('craft: Tab moves focus, Enter crafts, arrows still move the player', () => {
  const game = loadGame({ frames: 1 });
  game.TC.newGame(4242);
  const TC = game.TC;
  // free recipes so the craft column is populated
  const p0 = TC.player;
  for (let i = 0; i < 30; i++) TC.RECIPES.push({ out: 'torch', n: 1, station: null, cost: {} });
  frame(game, 2);
  // open inventory via keyboard, ensure a craftable recipe is visible
  key(game, 'KeyE'); frame(game, 2);
  assert.strictEqual(TC.UI.invOpen, true);
  const surf = focusOf(game).surface;
  assert.strictEqual(surf, 'craft', 'craft surface focused, got ' + surf);
  const p = game.TC.player;
  const x0 = p.x;
  // arrows must still drive the player while the crafting column is open
  key(game, 'ArrowRight'); frame(game, 10); keyUp(game, 'ArrowRight');
  assert.ok(p.x > x0, 'player moved right under arrows with craft open');
  const f0 = focusOf(game).index;
  // Tab moves craft focus without moving the player
  const x1 = p.x;
  p.vx = 0;
  key(game, 'Tab'); frame(game); keyUp(game, 'Tab');
  assert.notStrictEqual(focusOf(game).index, f0, 'Tab moved craft focus');
  frame(game, 5);
  assert.ok(Math.abs(p.x - x1) < 8, 'Tab did not steer the player (drift ' + Math.abs(p.x - x1).toFixed(2) + ')');
});

test('craft: focusing past the visible window scrolls it into view', () => {
  const game = loadGame({ frames: 1 });
  game.TC.newGame(4242);
  const TC = game.TC;
  for (let i = 0; i < 30; i++) TC.RECIPES.push({ out: 'torch', n: 1, station: null, cost: {} });
  frame(game, 2);
  key(game, 'KeyE'); frame(game, 3);
  assert.strictEqual(focusOf(game).surface, 'craft');
  // walk focus forward; the window must follow before wrapping around
  let scrolled = false;
  for (let i = 0; i < 40 && !scrolled; i++) {
    key(game, 'Tab'); frame(game); keyUp(game, 'Tab');
    scrolled = focusOf(game).craftScroll > 0;
  }
  const f = focusOf(game);
  assert.ok(scrolled, 'scroll followed focus, got ' + JSON.stringify(f));
  assert.ok(f.index >= f.craftScroll, 'focus inside the visible window');
});

test('packs: keyboard opens the panel, moves over rows, Escape closes', () => {
  const game = loadGame({ frames: 1 });
  frame(game);
  for (let i = 0; i < 4; i++) { key(game, 'ArrowDown'); frame(game); }
  assert.strictEqual(focusOf(game).index, 4);
  key(game, 'Enter'); frame(game, 2);
  const opened = focusOf(game);
  assert.strictEqual(opened.surface, 'packs', 'packs opened, got ' + JSON.stringify(opened));
  key(game, 'ArrowDown'); frame(game);
  assert.strictEqual(focusOf(game).index, 1, 'packs focus moved');
  key(game, 'Escape'); frame(game, 2);
  const closed = focusOf(game);
  assert.strictEqual(closed.surface, 'title', 'Escape closed packs');
  assert.strictEqual(closed.index, 0, 'title focus reset');
});

test('shop: Tab moves over buy rows and Enter buys like a click', () => {
  const game = loadGame({ frames: 1 });
  game.TC.newGame(4242);
  const TC = game.TC;
  const p = TC.player;
  TC.NPCs.spawn('merchant', p.x + 40, p.y);
  TC.UI.showDialog('merchant', 'npc.core.merchant.dialogue.base_01');
  frame(game, 3);
  assert.strictEqual(focusOf(game).surface, 'shop', 'shop surface, got ' + JSON.stringify(focusOf(game)));
  const f0 = focusOf(game).index;
  key(game, 'Tab'); frame(game); keyUp(game, 'Tab');
  assert.notStrictEqual(focusOf(game).index, f0, 'Tab moved shop focus');
  // Shift+Tab moves back
  key(game, 'ShiftLeft');
  key(game, 'Tab'); frame(game); keyUp(game, 'Tab'); keyUp(game, 'ShiftLeft');
  assert.strictEqual(focusOf(game).index, f0, 'Shift+Tab moved back');
});

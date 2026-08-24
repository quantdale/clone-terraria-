/* tests/core/runtime-authority.test.js — proves PRODUCTION actually executes
   through TC.Runtime → TC.Systems (scheduler authority), drains the command
   queue in the commands phase (mutation authority), and dispatches rendering
   exclusively through TC.RenderLayers (render authority).

   Every test boots the REAL game scripts in a VM (browser-stubbed) and drives
   the real rAF loop via startFrameLoop — no direct legacy calls. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');
const { quietConsole } = require('./helpers.js');

function boot(opts) {
  const g = loadGame(Object.assign({ frames: 1 }, opts));
  return g;
}

// ---------------------------------------------------------------------
// Scheduler authority
// ---------------------------------------------------------------------

test('runtime authority: the live loop drives EVERY registered system exactly once per tick', () => {
  const g = boot();
  const TC = g.TC;
  TC.newGame(2024);
  g.startFrameLoop();          // one real frame = >= 1 fixed step
  const perTick = TC.Systems.getPerTickCounts();
  const names = Object.keys(perTick);
  assert.ok(names.length >= 25, 'production registrations present (' + names.length + ')');
  for (const k of names) {
    assert.strictEqual(perTick[k], 1,
      'system "' + k + '" ran more than once in a single tick — double-update regression');
  }
});

test('runtime authority: scheduler counters grow per tick while playing', () => {
  const g = loadGame({ frames: 12 });
  const TC = g.TC;
  TC.newGame(7);
  g.startFrameLoop();
  const counts = TC.Systems.getCounts();
  assert.ok(counts['movement/player'] >= 1, 'player system executed through the scheduler');
  assert.ok(counts['commands/core.queue'] >= 1, 'command drain executed through the scheduler');
  assert.ok(counts['eventsFlush/core.flush'] >= 1, 'event flush executed through the scheduler');
  assert.ok(TC.Runtime.getTickCount() >= 1, 'Runtime owns the tick count');
});

test('runtime authority: title state gates simulation but not UI', () => {
  const g = loadGame({ frames: 8 });
  const TC = g.TC;
  assert.strictEqual(TC.state, 'title');   // no world ever created
  g.startFrameLoop();
  const counts = TC.Systems.getCounts();
  assert.ok(counts['input/ui'] >= 1, 'UI updates on title (menu buttons)');
  assert.strictEqual(counts['environment/sky'] || 0, 0, 'sky frozen on title');
  assert.strictEqual(counts['movement/player'] || 0, 0, 'player frozen on title');
  assert.strictEqual(counts['ai/enemies'] || 0, 0, 'enemies frozen on title');
});

test('runtime authority: paused gates simulation but keeps UI alive', () => {
  const g = loadGame({ frames: 6 });
  const TC = g.TC;
  TC.newGame(11);
  g.startFrameLoop();                       // some playing ticks
  const beforeSky = TC.Systems.getCounts()['environment/sky'] || 0;
  TC.UI.paused = true;                      // pause overlay open
  g.startFrameLoop();
  const after = TC.Systems.getCounts();
  assert.strictEqual(after['environment/sky'], beforeSky,
    'paused: sky (and thus time of day) must not advance');
  assert.ok((after['input/ui'] || 0) > 0, 'paused: UI keeps running');
  // unpause resumes
  TC.UI.paused = false;
  g.startFrameLoop();
  assert.ok(TC.Systems.getCounts()['environment/sky'] > beforeSky,
    'unpausing resumes simulation');
});

// ---------------------------------------------------------------------
// Command queue authority
// ---------------------------------------------------------------------

test('commands: FIFO queue executes in order within the commands phase', () => {
  const g = loadGame({ frames: 1 });
  const TC = g.TC;
  TC.newGame(31);
  const inv = TC.player.inventory;
  inv.slots[0] = { id: 'dirt', count: 5 };
  inv.slots[1] = null;
  inv.slots[2] = null;
  quietConsole(() => {
    TC.Commands.enqueue('MoveItem', { fromInv: inv, fromSlot: 0, toInv: inv, toSlot: 1 });
    TC.Commands.enqueue('MoveItem', { fromInv: inv, fromSlot: 1, toInv: inv, toSlot: 2 });
    assert.strictEqual(TC.Commands.pending(), 2);
  });
  g.startFrameLoop();   // one tick drains both in FIFO order
  assert.strictEqual(TC.Commands.pending(), 0, 'queue fully drained');
  assert.ok(!inv.get(0) && !inv.get(1), 'intermediate slot emptied in order');
  const s = inv.get(2);
  assert.ok(s && s.id === 'dirt' && s.count === 5,
    'second move saw the first move\'s result — FIFO proven');
  const st = TC.Commands.stats();
  assert.strictEqual(st.processed, 2);
});

test('commands: rejection mutates nothing and is counted', () => {
  const g = loadGame({ frames: 1 });
  const TC = g.TC;
  TC.newGame(32);
  const inv = TC.player.inventory;
  const rejBefore = TC.Commands.stats().rejected;
  quietConsole(() => {
    // hotbar holds no dirt -> validate fails -> nothing placed, nothing consumed
    TC.Commands.enqueue('PlaceTile', {
      tx: 10, ty: 10, item: 'dirt', player: TC.player, slot: 0
    });
  });
  g.startFrameLoop();
  assert.strictEqual(TC.Commands.stats().rejected, rejBefore + 1);
  assert.strictEqual(TC.world.get(10, 10), TC.TILE.AIR, 'no partial mutation');
});

test('commands: queued MineTile breaks exactly once through the live loop', () => {
  const g = loadGame({ frames: 1 });
  const TC = g.TC;
  TC.newGame(33);
  const tx = TC.world.spawnX ?? 0;
  const sx = TC.player.x / 16 | 0;
  const ty = TC.world.surfaceY[sx];
  const idBefore = TC.world.get(sx, ty);
  let broken = 0, drops = 0;
  TC.Events.on('TileBroken', () => broken++);
  TC.Events.on('InventoryChanged', () => {});
  const dropsBefore = TC.Items.drops.length;
  TC.Commands.enqueue('MineTile', {
    tx: sx, ty: ty, toolPower: 10000, tool: 'pick', player: TC.player, dt: 1
  });
  g.startFrameLoop();
  assert.notStrictEqual(idBefore, TC.TILE.AIR, 'picked a solid tile');
  assert.strictEqual(TC.world.get(sx, ty), TC.TILE.AIR, 'tile removed');
  assert.strictEqual(broken, 1, 'TileBroken emitted exactly once');
  assert.strictEqual(TC.Items.drops.length, dropsBefore + 1, 'drop spawned exactly once');
});

test('commands: queue cannot leak across a world transition', () => {
  const g = loadGame({ frames: 1 });
  const TC = g.TC;
  TC.newGame(34);
  const inv = TC.player.inventory;
  inv.slots[3] = { id: 'dirt', count: 1 };
  quietConsole(() => {
    TC.Commands.enqueue('MoveItem', { fromInv: inv, fromSlot: 3, toInv: inv, toSlot: 4 });
    assert.strictEqual(TC.Commands.pending(), 1);
    TC.newGame(35);            // transition mid-flight
    assert.strictEqual(TC.Commands.pending(), 0,
      'queued commands dropped on new world — no cross-world leak');
  });
  g.startFrameLoop();
});

// ---------------------------------------------------------------------
// Render authority
// ---------------------------------------------------------------------

test('render: production frame dispatches once through RenderLayers, every drawer runs once', () => {
  const g = loadGame({ frames: 3 });
  const TC = g.TC;
  TC.newGame(41);
  let dw = 0, ds = 0;
  const ow = TC.RenderLayers.drawWorld, os = TC.RenderLayers.drawScreen;
  TC.RenderLayers.drawWorld = function (c, cam) { dw++; return ow(c, cam); };
  TC.RenderLayers.drawScreen = function (c, w, h) { ds++; return os(c, w, h); };
  g.startFrameLoop();
  assert.strictEqual(dw, 3, 'drawWorld dispatched exactly once per frame');
  assert.strictEqual(ds, 3, 'drawScreen dispatched exactly once per frame');
  const listed = TC.RenderLayers.list();
  const byName = new Map(listed.map((e) => [e.layer + '/' + e.name, e]));
  assert.ok(byName.size >= 20, 'production layers registered');
  for (const [k, e] of byName) {
    assert.strictEqual(e.calls, 3,
      'drawer "' + k + '" must execute exactly once per frame (got ' + e.calls + ')');
    assert.strictEqual(e.errors, 0, 'drawer "' + k + '" must not error');
  }
});

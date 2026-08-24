#!/usr/bin/env node
/* tools/bench-runtime.js — reproducible runtime benchmark for the
   scheduler/command/render convergence. Boots the real game headless
   (same VM loader as the test suites) and measures:

     - fixed-step simulation tick cost through TC.Runtime.tick (full
       scheduler: all phases, real world ticking);
     - command-queue drain cost: empty drains and a realistic batch;
     - RenderLayers dispatch cost against the no-op canvas stub (dispatch +
       drawer logic, no real rasterization — an upper-bound-free view of
       dispatch overhead itself).

   Usage: node tools/bench-runtime.js [ticks]
   Not part of npm test; run ad hoc when touching the dispatch path. */
'use strict';
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', 'tests', 'helpers', 'load-game.js'));

const TICKS = Math.max(60, (parseInt(process.argv[2], 10) || 600));

function ms() { return performance.now(); }

function fmt(msVal) {
  if (msVal >= 1) return msVal.toFixed(2) + ' ms';
  return (msVal * 1000).toFixed(1) + ' us';
}

const g = loadGame({ frames: 0 });
const TC = g.TC;
TC.Runtime.createWorld(20260824);

// warmup
TC.Runtime.advanceTicks(120);

// ---- full simulation ticks -------------------------------------------------
let t0 = ms();
TC.Runtime.advanceTicks(TICKS);
const tickTotal = ms() - t0;
const perTick = tickTotal / TICKS;

// ---- scheduler-only re-measure (isolates updateAll inside the same state) --
t0 = ms();
for (let i = 0; i < TICKS; i++) TC.Systems.updateAll(1 / 60);
const schedTotal = ms() - t0;

// ---- command drain: empty --------------------------------------------------
const EMPTY_N = 200000;
t0 = ms();
for (let i = 0; i < EMPTY_N; i++) TC.Commands.drain();
const drainEmptyTotal = ms() - t0;

// ---- command drain: batches of two valid single-item moves -----------------
const inv = TC.player.inventory;
inv.slots[0] = { id: 'dirt', count: 2 };
inv.slots[1] = null;
const BATCH_ROUNDS = 20000;
t0 = ms();
for (let i = 0; i < BATCH_ROUNDS; i++) {
  TC.Commands.enqueue('MoveItem', { fromInv: inv, fromSlot: 0, toInv: inv, toSlot: 1, count: 1 });
  TC.Commands.enqueue('MoveItem', { fromInv: inv, fromSlot: 1, toInv: inv, toSlot: 0, count: 1 });
  TC.Commands.drain();
}
const batchTotal = ms() - t0;
const st = TC.Commands.stats();

// ---- render dispatch -------------------------------------------------------
const ctx = TC.canvas.getContext('2d');
const cam = { x: 640, y: 360, zoom: 2 };
t0 = ms();
for (let i = 0; i < TICKS; i++) {
  TC.RenderLayers.drawWorld(ctx, cam);
  TC.RenderLayers.drawScreen(ctx, 1280, 720);
}
const renderTotal = ms() - t0;

console.log('=== clone-terraria runtime benchmark ===');
console.log('ticks measured            :', TICKS);
console.log('full sim tick (Runtime)   :', fmt(perTick), '/tick   (' + tickTotal.toFixed(1) + ' ms total)');
console.log('scheduler updateAll       :', fmt(schedTotal / TICKS), '/tick   (' + schedTotal.toFixed(1) + ' ms total)');
console.log('queue drain (empty)       :', ((drainEmptyTotal / EMPTY_N) * 1000).toFixed(3), 'us/drain');
console.log('queue drain (2-cmd batch) :', ((batchTotal / BATCH_ROUNDS) * 1000).toFixed(3), 'us/batch ->',
  (st.processed.toLocaleString()), 'processed,', (st.rejected.toLocaleString()), 'rejected');
console.log('render dispatch (stub ctx):', fmt(renderTotal / TICKS), '/frame  (' + renderTotal.toFixed(1) + ' ms total)');
console.log('systems registered        :', TC.Systems.list().length);
console.log('layers registered         :', TC.RenderLayers.list().length);
console.log('=========================================');

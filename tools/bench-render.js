#!/usr/bin/env node
/* tools/bench-render.js — PERF-W27 render-path benchmark.
   Boots the REAL game headless through the same loader the test suites use
   (tests/helpers/load-game.js), but substitutes a COUNTING 2D context for the
   default no-op stub (offscreen canvases created via document.createElement
   are counted too — chunk caches, lighting overlays, wall-variant bakes).

   Every existing bench-*.js tool in this repository measures simulation cost
   through the no-op stub, where fillRect/drawImage/fillText are free. None of
   them measure what the renderer actually asks the rasterizer to do. This
   tool closes that gap.

   Op counts are hardware-independent: they are the work issued to the
   rasterizer, not wall-clock time. They are the right currency here because
   they reproduce identically on any machine, and because raster wall-clock
   could not be obtained in the environment this tool was written in — Canvas
   2D and requestAnimationFrame do not function in that headless Chromium
   instance (see docs/W27-PERFORMANCE-PLAN.md §4). Real frame-time percentiles
   still require tests/browser/perf.spec.js on a machine with a working
   browser.

   Reconstructs the exact production frame from js/main.js's draw():
     TC.Runtime.tick -> TC.Sky.draw -> TC.RenderLayers.drawWorld -> drawScreen

   Usage: node tools/bench-render.js [--frames=N]
   Not part of npm test/validate; run ad hoc around render-path changes. */
'use strict';
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', 'tests', 'helpers', 'load-game.js'));

const args = process.argv.slice(2);
const framesArg = args.find((a) => a.startsWith('--frames='));
const N = framesArg ? Math.max(1, parseInt(framesArg.slice('--frames='.length), 10) || 120) : 120;
const WARMUP = 180;
const SEED = 12345;

// ---- counting 2D context: same method surface as tests/helpers/load-game.js
// makeCtx2D, but every call increments a shared tally instead of no-op'ing.
const METHODS = [
  'measureText', 'createLinearGradient', 'createRadialGradient', 'createPattern',
  'getImageData', 'createImageData', 'putImageData', 'drawImage', 'fillRect',
  'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc',
  'ellipse', 'rect', 'fill', 'stroke', 'clip', 'save', 'restore', 'translate',
  'rotate', 'scale', 'setTransform', 'transform', 'setLineDash', 'fillText',
  'strokeText', 'quadraticCurveTo', 'bezierCurveTo', 'arcTo', 'roundRect'
];
// Heavy = ops that touch the rasterizer directly (as opposed to path/state
// bookkeeping like beginPath/save/translate).
const HEAVY = new Set(['drawImage', 'fillRect', 'strokeRect', 'clearRect', 'fill',
  'stroke', 'fillText', 'strokeText', 'putImageData', 'getImageData']);

function makeTally() {
  const ops = {};
  let total = 0, heavy = 0;
  function note(op) { ops[op] = (ops[op] || 0) + 1; total++; if (HEAVY.has(op)) heavy++; }
  return { ops, note, get total() { return total; }, get heavy() { return heavy; },
    reset() { for (const k in ops) delete ops[k]; total = 0; heavy = 0; } };
}

function makeCountingCtx(canvas, tally) {
  const t = {
    canvas, lineWidth: 1, font: '10px sans-serif', textAlign: 'left',
    textBaseline: 'alphabetic', imageSmoothingEnabled: true, shadowBlur: 0,
    shadowColor: 'transparent'
  };
  for (const m of METHODS) {
    if (m === 'measureText') { t[m] = () => { tally.note(m); return { width: 0 }; }; continue; }
    if (m === 'createLinearGradient' || m === 'createRadialGradient') {
      t[m] = () => { tally.note(m); return { addColorStop() {} }; }; continue;
    }
    if (m === 'createPattern') { t[m] = () => { tally.note(m); return {}; }; continue; }
    if (m === 'getImageData') {
      t[m] = (x, y, w, h) => { tally.note(m); return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; };
      continue;
    }
    if (m === 'createImageData') {
      t[m] = (w, h) => { tally.note(m); return { data: new Uint8ClampedArray((w || 1) * (h || 1) * 4), width: w, height: h }; };
      continue;
    }
    t[m] = () => tally.note(m);
  }
  // Style/composite-mode writes are real rasterizer state transitions, not
  // free property sets — count a write only when the value actually changes,
  // matching how a real 2D context avoids redundant paint-source rebinds.
  let fillStyle = '#000', strokeStyle = '#000', globalAlpha = 1, globalCompositeOperation = 'source-over';
  Object.defineProperty(t, 'fillStyle', { get: () => fillStyle, set(v) { if (v !== fillStyle) tally.note('set:fillStyle'); fillStyle = v; } });
  Object.defineProperty(t, 'strokeStyle', { get: () => strokeStyle, set(v) { if (v !== strokeStyle) tally.note('set:strokeStyle'); strokeStyle = v; } });
  Object.defineProperty(t, 'globalAlpha', { get: () => globalAlpha, set(v) { if (v !== globalAlpha) tally.note('set:globalAlpha'); globalAlpha = v; } });
  Object.defineProperty(t, 'globalCompositeOperation', { get: () => globalCompositeOperation, set(v) { if (v !== globalCompositeOperation) tally.note('set:globalCompositeOperation'); globalCompositeOperation = v; } });
  return t;
}

function makeCountingCanvas(tally, w, h) {
  const cv = {
    width: w || 300, height: h || 150, style: {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w || 300, height: h || 150 })
  };
  cv.getContext = () => makeCountingCtx(cv, tally);
  return cv;
}

// ---- attribution: wrap each layer's public draw entry point so ops issued
// inside it are charged to it, not to whichever caller happens to sum first.
function wrapDrawer(TC, tally, attr, objName, fnName) {
  const o = objName === 'player' ? TC.player : TC[objName];
  if (!o || typeof o[fnName] !== 'function') return;
  const orig = o[fnName].bind(o);
  const key = objName + '.' + fnName;
  o[fnName] = function (...a) {
    const before = tally.total, beforeHeavy = tally.heavy;
    try { return orig(...a); }
    finally {
      const e = attr[key] || (attr[key] = { ops: 0, heavy: 0 });
      e.ops += tally.total - before;
      e.heavy += tally.heavy - beforeHeavy;
    }
  };
}
const DRAWERS = [
  ['Sky', 'draw'], ['world', 'draw'], ['Liquids', 'draw'], ['Loot', 'drawTiles'],
  ['Items', 'draw'], ['Enemies', 'draw'], ['NPCs', 'draw'], ['player', 'draw'],
  ['Fishing', 'draw'], ['Combat', 'draw'], ['Grapple', 'drawWorld'], ['Gear', 'draw'],
  ['Magic', 'drawWorld'], ['Particles', 'draw'], ['Biomes', 'drawOverlay'],
  ['Lighting', 'draw'], ['MiniMap', 'draw'], ['Input', 'drawCursor'],
  ['UI', 'draw'], ['Wiring', 'draw'], ['Debug', 'drawHud']
];

// ---- scene setup helpers ------------------------------------------------
function carveArena(TC, tx0, ty0, tw, th) {
  const AIR = TC.TILE.AIR;
  for (let ty = ty0; ty < ty0 + th; ty++) {
    for (let tx = tx0; tx < tx0 + tw; tx++) {
      TC.world.setRaw(tx, ty, AIR);
      if (TC.Liquids && TC.Liquids.displace) try { TC.Liquids.displace(tx, ty); } catch (e) {}
      if (TC.WorldRegions) TC.WorldRegions.markCell(tx, ty, 'bulk');
    }
  }
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- boot ----------------------------------------------------------------
const tally = makeTally();
const g = loadGame({ frames: 0, hash: '#test' });
const TC = g.TC;
g.ctx.document.createElement = (tag) =>
  tag === 'canvas' ? makeCountingCanvas(tally, 300, 150) : { style: {}, appendChild() {} };

TC.Runtime.reset();
TC.Runtime.createWorld(SEED);

const canvas = { width: 1280, height: 720 };
const ctx = makeCountingCtx(canvas, tally);
TC.canvas = TC.canvas || canvas;

const attr = {};
for (const [o, f] of DRAWERS) wrapDrawer(TC, tally, attr, o, f);

function frame() {
  TC.Runtime.tick(1 / 60);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (TC.Sky) TC.Sky.draw(ctx, TC.camera, canvas.width, canvas.height);
  if (TC.world && TC.state !== 'title') TC.RenderLayers.drawWorld(ctx, TC.camera);
  TC.RenderLayers.drawScreen(ctx, canvas.width, canvas.height);
}

function measure(label, setup) {
  if (setup) setup();
  for (let i = 0; i < WARMUP; i++) frame(); // settle chunk cache / lighting field
  tally.reset();
  for (const k in attr) delete attr[k];
  for (let i = 0; i < N; i++) frame();
  const perFrame = tally.total / N;
  const perFrameHeavy = tally.heavy / N;
  const histogram = Object.entries(tally.ops)
    .map(([k, v]) => [k, v / N])
    .filter(([, v]) => v >= 0.5)
    .sort((a, b) => b[1] - a[1]);
  const byDrawer = Object.entries(attr)
    .map(([k, v]) => [k, v.ops / N, v.heavy / N])
    .sort((a, b) => b[1] - a[1]);
  return { label, opsPerFrame: +perFrame.toFixed(1), heavyPerFrame: +perFrameHeavy.toFixed(1), histogram, byDrawer };
}

function printResult(r) {
  console.log('\n== ' + r.label + ' ==');
  console.log('  total ops/frame :', r.opsPerFrame);
  console.log('  heavy ops/frame :', r.heavyPerFrame,
    '(drawImage/fillRect/fill/stroke/text/imageData — direct rasterizer touches)');
  console.log('  -- op histogram (>=0.5/frame) --');
  for (const [k, v] of r.histogram) console.log('    ' + k.padEnd(28), v.toFixed(1));
  console.log('  -- per drawer (ops/frame, heavy/frame) --');
  for (const [k, ops, heavy] of r.byDrawer) {
    console.log('    ' + k.padEnd(22), String(ops.toFixed(1)).padStart(8), String(heavy.toFixed(1)).padStart(8));
  }
}

console.log('=== clone-terraria render benchmark (W27) ===');
console.log('frames/scene: ' + N + '  warmup: ' + WARMUP + ' ticks  seed: ' + SEED);
console.log('(hardware-independent canvas OPERATION counts, not raster wall-clock —');
console.log(' see docs/W27-PERFORMANCE-PLAN.md §4 for why wall-clock could not be used here)');

const results = [];
// maxHp is a derived stat (TC.Stats.resolve -> player.js syncs it from
// progress.lifeCrystals every tick, js/player.js:658) — setting the field
// directly gets stomped on the next tick. Grant crystals through the real
// progression field so the scaling scenario matches how a live character
// actually reaches higher max HP.
results.push(measure('idle-100hp (canonical scene)', () => {
  TC.player.lifeCrystals = 0; TC.player.hp = 100; TC.player.dead = false; TC.UI.invOpen = false;
}));
results.push(measure('idle-400hp (same scene, +300 max HP via 15 life crystals)', () => {
  TC.player.lifeCrystals = 15; TC.player.hp = 400;
}));
results.push(measure('inventory-open', () => {
  TC.player.lifeCrystals = 0; TC.player.hp = 100; TC.UI.invOpen = true;
}));
results.push(measure('24-enemies-on-screen', () => {
  TC.UI.invOpen = false; TC.player.lifeCrystals = 0;
  carveArena(TC, 990, TC.world.surfaceY[1000] - 8, 40, 10);
  if (TC.Enemies && TC.Enemies.clear) try { TC.Enemies.clear(); } catch (e) {}
  const p = TC.player;
  p.x = 1000 * TC.CONST.TS; p.y = (TC.world.surfaceY[1000] - 3) * TC.CONST.TS; p.vx = 0; p.vy = 0;
  if (TC.Enemies && TC.Enemies.spawnEnemy) {
    for (let i = 0; i < 24; i++) TC.Enemies.spawnEnemy('green_slime', p.x + (i % 12) * 20 - 120, p.y - 40);
  }
}));

for (const r of results) printResult(r);

console.log('\n-- HUD max-HP scaling (should be FLAT; §3.1 of the W27 plan) --');
const base = results.find((r) => r.label.startsWith('idle-100hp'));
const scaled = results.find((r) => r.label.startsWith('idle-400hp'));
const baseUi = (base.byDrawer.find((d) => d[0] === 'UI.draw') || [null, 0])[1];
const scaledUi = (scaled.byDrawer.find((d) => d[0] === 'UI.draw') || [null, 0])[1];
console.log('  UI.draw ops/frame at 100 maxHp:', baseUi.toFixed(1));
console.log('  UI.draw ops/frame at 400 maxHp:', scaledUi.toFixed(1));
console.log('  ratio:', baseUi > 0 ? (scaledUi / baseUi).toFixed(2) + 'x' : 'n/a',
  '(1.00x = flat / fixed; the plan target)');

console.log('\n-- engine stats (idle-100hp scene) --');
measure('idle-100hp (canonical scene)', () => { TC.player.lifeCrystals = 0; TC.player.hp = 100; });
const s = (o) => { try { return o && o.stats ? JSON.stringify(o.stats()) : null; } catch (e) { return null; } };
console.log('  regions :', s(TC.WorldRegions));
console.log('  lighting:', TC.Lighting && TC.Lighting.counters ? JSON.stringify(TC.Lighting.counters()) : null);
console.log('  minimap :', s(TC.MiniMap));
console.log('  renderer:', TC.world && TC.world.regionStats ? JSON.stringify(TC.world.regionStats()) : null);
console.log('  liquids :', s(TC.Liquids));

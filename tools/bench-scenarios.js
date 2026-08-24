#!/usr/bin/env node
/* tools/bench-scenarios.js — PERF-002 stable benchmark scenes (W21).
   Boots the REAL game headless through the same VM loader the test suites
   use (tests/helpers/load-game.js) and measures named scenarios that cover
   the systems W21 touches:

     exploration     player walking over live terrain
     construction    repeated authoritative MineTile/PlaceTile transactions
     combat-dense    many live enemies with contact damage + AI
     projectiles     projectile-pool churn (arrows/bolts)
     lighting-stress repeated emissive/opacity edits near the camera
     dynamic-lights  full pool of moving transient light sources
     liquids         active liquid settling after bulk wakes
     minimap         region repaint workload while visible
     save-diff       TC.Save.computeWorldDiffs on an edited world
     worldgen        deterministic generation pass timings

   Metrics are path-specific: fixed-step tick time, scheduler/system time,
   WorldRegions revisions, renderer rebuild/backlog counters, lighting
   recompute cells, minimap pixels painted, liquid active cells,
   save diff time, per-pass worldgen timings.

   Methodology: every scenario runs WARMUP ticks first (discarded), then
   SAMPLES measured rounds; the reported number is the MEDIAN round so a
   single noisy run never presents itself as proof.

   IMPORTANT SCOPE NOTE: all measurements here execute against the stub
   canvas context (no real rasterization). They capture simulation +
   dispatch + bookkeeping cost honestly, but they are NOT browser raster
   throughput. Real-renderer claims require the Playwright journeys.

   Usage: node tools/bench-scenarios.js [--quick]
   Not part of npm test/validate; run ad hoc around perf-relevant changes. */
'use strict';
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', 'tests', 'helpers', 'load-game.js'));

const QUICK = process.argv.includes('--quick');
const WARMUP = QUICK ? 30 : 120;
const SAMPLES = QUICK ? 3 : 5;
const ROUND_TICKS = QUICK ? 60 : 180;

function median(arr) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function fmtMs(v) { return v >= 1 ? v.toFixed(2) + 'ms' : (v * 1000).toFixed(1) + 'us'; }
const now = () => performance.now();

// ---- boot ------------------------------------------------------------------
const g = loadGame({ frames: 0 });
const TC = g.TC;

function resetWorld(seed) {
  TC.Runtime.reset();
  return TC.Runtime.createWorld(seed == null ? 20260825 : seed);
}

// Scenario helpers -----------------------------------------------------------

// Carve a safe flat arena at (tx,ty)..(+w,+h) via raw writes (test fixture,
// not gameplay) and settle liquids out of it.
function carveArena(w, tx0, ty0, tw, th) {
  const AIR = TC.TILE.AIR;
  for (let ty = ty0; ty < ty0 + th; ty++)
    for (let tx = tx0; tx < tx0 + tw; tx++) {
      w.setRaw(tx, ty, AIR);
      if (TC.Liquids && TC.Liquids.displace) try { TC.Liquids.displace(tx, ty); } catch (e) {}
      if (TC.WorldRegions) TC.WorldRegions.markCell(tx, ty, 'bulk');
    }
}

function teleport(tx, ty) {
  const p = TC.player, TS = TC.CONST.TS;
  p.x = tx * TS; p.y = ty * TS - p.h - 2;
  p.vx = 0; p.vy = 0;
}

// Hold the right arrow key down through TC.Input so exploration walks.
function pressRight(down) {
  if (!TC.Input) return;
  // Input.pressed/down read a code->state map; drive it directly (headless).
  const keys = TC.Input._keys || null;
  if (keys) keys['ArrowRight'] = down;
}

let scenariosRun = [];

function runScenario(name, setup, eachTick) {
  const rows = [];
  for (let s = 0; s < SAMPLES; s++) {
    const ctx = setup(s);
    TC.Runtime.advanceTicks(WARMUP);
    // snapshot counters we delta across the round
    const t0 = now();
    let t = 0;
    for (let i = 0; i < ROUND_TICKS; i++) {
      if (eachTick) eachTick(ctx, i);
      TC.Runtime.tick(1 / 60);
      t++;
    }
    const dtMs = now() - t0;
    rows.push({ ms: dtMs, perTick: dtMs / t, ctx });
  }
  const med = median(rows.map((r) => r.perTick));
  const extra = rows[(rows.length >> 1)] ? rows[(rows.length >> 1)].ctx : {};
  scenariosRun.push({ name, perTickMedianMs: med, totalMedianMs: med * ROUND_TICKS, samples: SAMPLES, roundTicks: ROUND_TICKS, extra });
  return med;
}

// ============================================================================
// Scenarios
// ============================================================================

resetWorld();

// 1. exploration — walk right along the surface
runScenario('exploration', function () {
  const w = TC.world;
  teleport(w.surfaceY[200] - 4, 200);
  pressRight(true);
  return {};
}, function () {});

// 2. construction — authoritative place/mine churn near the player
runScenario('construction', function () {
  const w = TC.world;
  const sy = w.surfaceY[300];
  carveArena(w, 290, sy - 6, 24, 8);
  teleport(300, sy - 3);
  return { tx: 292, ty: sy - 5 };
}, function (ctx, i) {
  // alternate place dirt / mine it through Commands (authoritative paths)
  const r = (i & 1) === 0
    ? TC.Commands.submit('PlaceTile', { tx: ctx.tx, ty: ctx.ty, item: 'dirt', player: TC.player })
    : TC.Commands.submit('MineTile', { tx: ctx.tx, ty: ctx.ty, toolPower: 55, player: TC.player, dt: 1 / 60 });
  void r;
});

// 3. combat-dense — keep MAX_ENEMIES alive next to the player
runScenario('combat-dense', function () {
  const w = TC.world;
  const sy = w.surfaceY[420];
  carveArena(w, 400, sy - 8, 48, 10);
  teleport(420, sy - 3);
  if (TC.Enemies.clear) TC.Enemies.clear();
  return {};
}, function (ctx) {
  const E = TC.Enemies;
  if (!E || !E.spawnEnemy) return;
  if (E.list.length < TC.CONST.MAX_ENEMIES * 2) {
    const p = TC.player;
    E.spawnEnemy('green_slime', p.x + 90, p.y - 20);
    E.spawnEnemy('blue_slime', p.x - 90, p.y - 20);
  }
});

// 4. projectile stress — fire bolts into the pool continuously
runScenario('projectiles', function () {
  const w = TC.world;
  const sy = w.surfaceY[520];
  carveArena(w, 500, sy - 8, 48, 10);
  teleport(520, sy - 3);
  if (TC.Projectiles && TC.Projectiles.clear) try { TC.Projectiles.clear(); } catch (e) {}
  return {};
}, function (ctx, i) {
  if (!TC.Projectiles) return;
  const p = TC.player;
  if ((i & 1) === 0) TC.Projectiles.spawn('magic_bolt', p.x, p.y, -0.35 + Math.sin(i) * 0.6, { owner: p, dmg: 8 });
  else TC.Projectiles.spawn('falling_star', p.x, p.y, -Math.PI / 2 + ((i % 7) - 3) * 0.2, { dmg: 10 });
});

// 5. lighting stress — rapid torch/air flips around the camera
runScenario('lighting-stress', function () {
  const w = TC.world;
  const sy = w.surfaceY[620];
  carveArena(w, 600, sy - 8, 44, 10);
  teleport(618, sy - 3);
  return { x: 610, y: sy - 6 };
}, function (ctx, i) {
  const T = TC.TILE;
  const id = (i & 1) === 0 ? T.TORCH : T.AIR;
  TC.world.set(ctx.x + (i & 7), ctx.y + ((i >> 3) & 3), id);
});

// 6. dynamic lights — fill the transient pool and sweep positions
runScenario('dynamic-lights', function () {
  const w = TC.world;
  const sy = w.surfaceY[720];
  carveArena(w, 700, sy - 8, 44, 10);
  teleport(718, sy - 3);
  return {};
}, function (ctx, i) {
  const L = TC.Lighting;
  if (!L || !L.addDynamic) return;
  for (let k = 0; k < 16; k++) {
    const ang = i * 0.11 + k * 0.39;
    L.addDynamic(TC.player.x + Math.cos(ang) * 130, TC.player.y + Math.sin(ang) * 70,
      96, 0.8, 0.2, k & 1 ? '#ff9a3a' : '#7a5af5');
  }
});

// 7. liquids — repeatedly wake a large pool region
runScenario('liquids', function () {
  const w = TC.world;
  const sy = w.surfaceY[820];
  carveArena(w, 800, sy - 10, 48, 14);
  teleport(818, sy - 3);
  // seed water into the trench via Liquids.placeAt (runtime authority)
  if (TC.Liquids && TC.Liquids.placeAt) {
    for (let tx = 802; tx < 846; tx += 3)
      for (let ty = sy - 8; ty < sy - 4; ty++) try { TC.Liquids.placeAt(tx, ty, 1); } catch (e) {}
  }
  return { x0: 802, y0: 0 };
}, function (ctx, i) {
  if (!TC.Liquids || !TC.Liquids.wake) return;
  const sy = TC.world.surfaceY[820];
  if ((i & 3) === 0) TC.Liquids.wake(802 + (i & 31), sy - 6);
});

// 8. minimap — visible map repainting while edits land
runScenario('minimap', function (s) {
  const w = TC.world;
  const sy = w.surfaceY[920];
  carveArena(w, 900, sy - 6, 40, 8);
  teleport(918, sy - 3);
  if (TC.MiniMap) { TC.MiniMap.visible = true; TC.MiniMap.fullRefresh = true; }
  return { n: 0 };
}, function (ctx, i) {
  const M = TC.MiniMap;
  if (!M) return;
  M.visible = true;
  if ((i & 15) === 0) {
    const sy = TC.world.surfaceY[920] + ((i >> 4) & 15);
    TC.world.set(905 + (i & 31), sy, TC.TILE.STONE);
  }
});

// 9. save-diff — computeWorldDiffs over an edited world (not ticked)
(function () {
  const w = TC.world;
  // edit ~2000 tiles deterministically
  const sy = w.surfaceY[1000];
  for (let k = 0; k < 2000; k++) {
    const tx = 1000 + (k % 40), ty = sy + ((k / 40) | 0);
    w.setRaw(tx, ty, TC.TILE.STONE);
  }
  const rows = [];
  const N = QUICK ? 20 : 60;
  for (let s = 0; s < N; s++) {
    const t0 = now();
    const d = TC.Save.computeWorldDiffs();
    rows.push(now() - t0);
    if (!d || !d.diffs.length) throw new Error('save-diff scenario produced no diffs');
  }
  scenariosRun.push({
    name: 'save-diff', perTickMedianMs: median(rows),
    totalMedianMs: median(rows), samples: N, roundTicks: 1,
    extra: { diffs: TC.Save.computeWorldDiffs().diffs.length }
  });
})();

// 10. worldgen pass timings (median of several generations)
(function () {
  const gens = [];
  const seeds = [11, 22, 33];
  for (const seed of seeds) {
    const t0 = now();
    const gen = TC.WorldGen.generate(seed);
    gens.push({ ms: now() - t0, timings: gen.timings || null });
  }
  const med = median(gens.map((x) => x.ms));
  const mid = gens[gens.length >> 1];
  scenariosRun.push({ name: 'worldgen', perTickMedianMs: med, totalMedianMs: med,
    samples: seeds.length, roundTicks: 1, extra: { passes: mid.timings } });
})();

// ---- report -----------------------------------------------------------------
console.log('=== clone-terraria scenario benchmark (W21) ===');
console.log('mode: ' + (QUICK ? 'QUICK' : 'full') + '  samples/scenario: ' + SAMPLES +
            '  warmup: ' + WARMUP + ' ticks  round: ' + ROUND_TICKS + ' ticks');
console.log('(stub-context measurements: simulation+dispatch cost, NOT browser raster)');
console.log('');
for (const s of scenariosRun) {
  console.log(s.name.padEnd(16), 'median', fmtMs(s.perTickMedianMs).padStart(9) + '/tick',
    '(' + (s.totalMedianMs).toFixed(1) + 'ms/' + (s.name === 'worldgen' || s.name === 'save-diff' ? 'op' : 'round') + ')',
    Object.keys(s.extra || {}).length ? JSON.stringify(s.extra) : '');
}
console.log('');

// ---- counter dump (feature-detected; W21 adds regions/lighting/minimetrics) --
const snap = (TC.Debug && TC.Debug.snapshot) ? TC.Debug.snapshot() : {};
if (TC.WorldRegions && TC.WorldRegions.stats) {
  console.log('WorldRegions:', JSON.stringify(TC.WorldRegions.stats()));
}
if (TC.Lighting && TC.Lighting.counters) {
  console.log('Lighting:', JSON.stringify(TC.Lighting.counters()));
}
if (TC.MiniMap && TC.MiniMap.stats) {
  console.log('MiniMap:', JSON.stringify(TC.MiniMap.stats()));
}
if (TC.world && typeof TC.world.regionStats === 'function') {
  console.log('Renderer :', JSON.stringify(TC.world.regionStats()));
}
console.log('Liquids  :', JSON.stringify((TC.Liquids && TC.Liquids.stats) ? TC.Liquids.stats() : {}));
console.log('Debug counters:', JSON.stringify(snap));

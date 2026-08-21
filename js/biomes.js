/* biomes.js — TC.Biomes: player-centered biome detection, sky tints,
   ambient particles/fog, spawn-table overrides and a music flag.

   Self-wiring via guarded runtime wraps — no lead-owned edits needed:
     - wraps TC.Sky.draw to apply a blended biome tint + fog after the
       vanilla gradient/hills (screen space)
     - wraps TC.Enemies.spawnDirector to swap the SPAWN table when a
       non-forest biome dominates (ocean/desert/snow/jungle/underworld)
     - ticks detection + ambient particles each frame via a wrap on
       TC.Sky.update and a fallback rAF loop if Sky is absent
     - exposes TC.Biomes.current (stable), .raw (instant), .blend (0..1),
       .musicTag (string for TC.Music), and .getSpawnOverride()

   Deterministic: no Math.random for state — visual jitter uses hash2 only
   where needed; particle spawns use Math.random (visual only).

   Load order: after sky.js is ideal, but install() polls until TC.Sky /
   TC.Enemies appear, so any order before main.js works. Requires one line
   in index.html (lead-owned):
     <script src="js/biomes.js"></script>
   after js/sky.js.
*/
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Biomes) return;

  const TS = (TC.CONST && TC.CONST.TS) || 16;
  const T = TC.TILE || {};
  const GEN = (TC.CONST && TC.CONST.GEN) || {};
  const UNDER_START = (GEN.underworld && GEN.underworld.startY) || 355;
  const OCEAN_EDGE = 55;
  const SCAN_R = 42;            // tiles radius around player centre
  const SCAN_H = 28;
  const SCAN_INTERVAL = 0.25;    // seconds between tile-count scans
  const HYSTERESIS = 0.85;       // seconds of consistent raw before flip
  const BLEND_SPEED = 0.9;       // 1/s lerp toward target tint

  // ---- helpers ----
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hash2(x, y, s) {
    if (TC.Utils && typeof TC.Utils.hash2 === 'function') return TC.Utils.hash2(x, y, s);
    let h = ((x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 1440662683) | 0;
    h = (h ^ (h >>> 13)) | 0; h = Math.imul(h, 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---- biome tint palette (screen overlay, rgba) ----
  // alpha is at full blend; actual alpha = pal.a * blend * daylight factor
  const PAL = {
    forest:     { r: 0, g: 0, b: 0, a: 0 },
    ocean:      { r: 42, g: 96, b: 150, a: 0.18 },
    desert:     { r: 210, g: 172, b: 92, a: 0.16 },
    snow:       { r: 200, g: 220, b: 240, a: 0.20 },
    jungle:     { r: 40, g: 120, b: 60, a: 0.17 },
    underworld: { r: 90, g: 18, b: 12, a: 0.32 },
    cave:       { r: 12, g: 12, b: 18, a: 0.10 }
  };

  // Spawn overrides per biome — keys match SPAWN table names where possible.
  // Values are arrays of [enemyId, weight] compatible with spawnDirector.
  const SPAWN_OVERRIDE = {
    ocean: [['cave_bat', 1], ['green_slime', 1]],
    desert: [['green_slime', 2], ['blue_slime', 1]],
    snow: [['blue_slime', 3], ['green_slime', 1]],
    jungle: [['cave_bat', 2], ['blue_slime', 2]],
    underworld: [['demon_eye', 2], ['cave_bat', 2], ['zombie', 1]],
    cave: null // use vanilla cave table
  };

  let current = 'forest';
  let raw = 'forest';
  let pending = 'forest';
  let pendingT = 0;
  let blend = 0;                // 0..1 toward current's tint
  let scanAcc = 0;
  let curPal = PAL.forest;
  let tgtPal = PAL.forest;

  function worldAt() { return TC.world; }
  function playerAt() { return TC.player; }

  function detect() {
    const world = worldAt();
    const p = playerAt();
    if (!world || !world.tiles || !p || p.dead) return raw;
    const px = (p.x + p.w / 2) / TS;
    const py = (p.y + p.h / 2) / TS;
    const W = world.width, H = world.height;

    // Underworld dominates by depth alone
    if (py >= UNDER_START - 4) return 'underworld';

    // Ocean: near world edge and close to surface
    const nearEdge = px < OCEAN_EDGE || px > W - OCEAN_EDGE;
    if (nearEdge && py < (world.surfaceY ? world.surfaceY[Math.min(W - 1, Math.max(0, px | 0))] + 18 : 140)) {
      return 'ocean';
    }

    // Sample a rectangle around player for tile composition
    const x0 = Math.max(0, (px - SCAN_R) | 0), x1 = Math.min(W - 1, (px + SCAN_R) | 0);
    const y0 = Math.max(0, (py - SCAN_H) | 0), y1 = Math.min(H - 1, (py + SCAN_H) | 0);
    let snow = 0, sand = 0, jgrass = 0, leaves = 0, stone = 0, total = 0;
    const tiles = world.tiles;
    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        const id = tiles[row + x];
        total++;
        if (id === T.SNOW) snow++;
        else if (id === T.SAND) sand++;
        else if (id === T.JGRASS) jgrass++;
        else if (id === T.LEAVES) leaves++;
        else if (id === T.STONE) stone++;
      }
    }
    if (total === 0) return 'forest';
    const snowR = snow / total, sandR = sand / total, jR = (jgrass + leaves * 0.5) / total;

    if (snowR > 0.08) return 'snow';
    if (sandR > 0.10) return 'desert';
    if (jR > 0.09) return 'jungle';

    // Deep underground without a surface biome -> cave
    const surfY = world.surfaceY ? world.surfaceY[Math.min(W - 1, Math.max(0, px | 0))] : 110;
    if (py > surfY + 30) return 'cave';
    return 'forest';
  }

  function setCurrent(next) {
    if (next === current) return;
    current = next;
    tgtPal = PAL[next] || PAL.forest;
    // blend restarts toward new target; draw lerps curPal -> tgtPal
  }

  function tick(dt) {
    scanAcc += dt;
    if (scanAcc >= SCAN_INTERVAL) {
      scanAcc = 0;
      raw = detect();
      if (raw !== pending) { pending = raw; pendingT = 0; }
      else {
        pendingT += SCAN_INTERVAL;
        if (pendingT >= HYSTERESIS && pending !== current) setCurrent(pending);
      }
    }
    // visual blend
    const want = (current === 'forest' || current === 'cave') ? 0.0 : 1.0;
    // forest/cave have subtle tints; keep them faint
    const targetBlend = (current === 'forest') ? 0 : 1;
    // lerp displayed palette
    const k = 1 - Math.exp(-BLEND_SPEED * dt * 3);
    curPal = {
      r: lerp(curPal.r, tgtPal.r, k),
      g: lerp(curPal.g, tgtPal.g, k),
      b: lerp(curPal.b, tgtPal.b, k),
      a: lerp(curPal.a, tgtPal.a, k)
    };
    blend = lerp(blend, targetBlend, 1 - Math.exp(-2.2 * dt));
    if (TC.state === 'playing') spawnAmbience(dt);
  }

  // ---- ambient particles per biome ----
  let ambAcc = 0;
  function spawnAmbience(dt) {
    ambAcc += dt;
    if (ambAcc < 0.12) return;
    ambAcc = 0;
    if (!TC.Particles || typeof TC.Particles.spawn !== 'function') return;
    const cam = TC.camera;
    const p = playerAt();
    if (!p || !cam) return;
    const r = Math.random;
    // small chance each tick, themed
    if (current === 'snow' && r() < 0.55) {
      const x = cam.x + r() * (cam.zoom ? (TC.canvas.width / cam.zoom) : 400);
      const y = cam.y - 10;
      try {
        TC.Particles.spawn({ x: x, y: y, vx: (r() - 0.5) * 20, vy: 40 + r() * 60, life: 3 + r() * 2, size: 1.5 + r() * 1.5, color: 'rgba(255,255,255,0.85)', gravity: 18 });
      } catch (e) {}
    } else if (current === 'desert' && r() < 0.35) {
      const x = cam.x - 10;
      const y = cam.y + r() * (cam.zoom ? (TC.canvas.height / cam.zoom) : 240);
      try {
        TC.Particles.spawn({ x: x, y: y, vx: 70 + r() * 90, vy: (r() - 0.5) * 20, life: 1.2 + r(), size: 1.2 + r(), color: 'rgba(216,200,110,0.5)', gravity: 0 });
      } catch (e) {}
    } else if (current === 'jungle' && r() < 0.22) {
      const x = p.x + (r() - 0.5) * 120;
      const y = p.y - 20;
      try {
        TC.Particles.spawn({ x: x, y: y, vx: (r() - 0.5) * 16, vy: 18 + r() * 18, life: 2 + r(), size: 1.0 + r(), color: 'rgba(90,200,90,0.45)', gravity: 10 });
      } catch (e) {}
    } else if (current === 'underworld' && r() < 0.30) {
      const x = cam.x + r() * (cam.zoom ? (TC.canvas.width / cam.zoom) : 400);
      const y = cam.y + r() * (cam.zoom ? (TC.canvas.height / cam.zoom) : 240);
      try {
        TC.Particles.spawn({ x: x, y: y, vx: (r() - 0.5) * 30, vy: -10 - r() * 20, life: 1.5 + r(), size: 1.3 + r() * 1.2, color: 'rgba(255,90,40,0.55)', gravity: -8 });
      } catch (e) {}
    }
  }

  // Public API
  const Biomes = {
    get current() { return current; },
    get raw() { return raw; },
    get blend() { return blend; },
    get musicTag() { return current; },
    getSpawnOverride: function () {
      if (current === 'forest' || current === 'cave') return null;
      return SPAWN_OVERRIDE[current] || null;
    },
    // called by patched Sky.update each frame; also safe to call directly
    update: function (dt) { tick(dt); },
    reset: function () {
      current = 'forest'; raw = 'forest'; pending = 'forest'; pendingT = 0;
      blend = 0; scanAcc = 0; curPal = PAL.forest; tgtPal = PAL.forest;
    }
  };
  TC.Biomes = Biomes;

  // ---- draw overlay (screen space) ----
  function drawOverlay(ctx, w, h) {
    if (TC.state === 'title') return;
    const pal = curPal;
    if (!pal || pal.a <= 0.001 || blend <= 0.001) return;
    // daylight modulates intensity slightly so night biomes read stronger
    let dl = 1;
    try { dl = TC.Sky && typeof TC.Sky.daylight === 'function' ? TC.Sky.daylight() : 1; } catch (e) {}
    const fogBoost = (current === 'underworld') ? 1 : (0.55 + 0.45 * dl);
    const a = clamp(pal.a * blend * fogBoost, 0, 0.42);
    if (a <= 0.005) return;
    ctx.save();
    ctx.fillStyle = 'rgba(' + (pal.r | 0) + ',' + (pal.g | 0) + ',' + (pal.b | 0) + ',' + a.toFixed(3) + ')';
    ctx.fillRect(0, 0, w, h);
    // subtle vignette for underworld
    if (current === 'underworld' && blend > 0.3) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.55, w / 2, h / 2, Math.max(w, h) * 0.9);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,' + (0.28 * blend).toFixed(3) + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  // ---- patches ----
  function patchSky() {
    if (!TC.Sky || TC.Sky.__biomesPatched) return false;
    TC.Sky.__biomesPatched = true;
    const origDraw = TC.Sky.draw;
    TC.Sky.draw = function (c, cam, w, h) {
      const r = origDraw.call(this, c, cam, w, h);
      try { drawOverlay(c, w, h); } catch (e) {}
      return r;
    };
    const origUpdate = TC.Sky.update;
    TC.Sky.update = function (dt) {
      const r = origUpdate.call(this, dt);
      try { Biomes.update(dt); } catch (e) {}
      return r;
    };
    // if Sky wasn't ticking yet (title), still tick via wrapper above
    return true;
  }

  function patchEnemies() {
    if (!TC.Enemies || typeof TC.Enemies.spawnDirector !== 'function' || TC.Enemies.__biomesPatched) return false;
    TC.Enemies.__biomesPatched = true;
    const orig = TC.Enemies.spawnDirector;
    TC.Enemies.spawnDirector = function (dt) {
      const ov = Biomes.getSpawnOverride();
      if (ov && TC.CONST && TC.CONST.SPAWN) {
        const savedDay = TC.CONST.SPAWN.day, savedNight = TC.CONST.SPAWN.night;
        const isDay = TC.Sky && typeof TC.Sky.isDay === 'function' ? TC.Sky.isDay() : true;
        // temporarily swap the active table so director picks from biome set
        if (isDay) TC.CONST.SPAWN.day = ov;
        else TC.CONST.SPAWN.night = ov;
        const r = orig.call(this, dt);
        TC.CONST.SPAWN.day = savedDay; TC.CONST.SPAWN.night = savedNight;
        return r;
      }
      return orig.call(this, dt);
    };
    return true;
  }

  function patchFlow() {
    if (typeof TC.newGame === 'function' && !TC.__biomesFlowPatched) {
      TC.__biomesFlowPatched = true;
      const origNew = TC.newGame;
      TC.newGame = function (seed) { Biomes.reset(); return origNew.call(TC, seed); };
    }
    if (typeof TC.continueGame === 'function' && !TC.__biomesFlowPatched2) {
      TC.__biomesFlowPatched2 = true;
      const origCont = TC.continueGame;
      TC.continueGame = function () { const r = origCont.call(TC); Biomes.reset(); return r; };
    }
  }

  function install() {
    patchSky();
    patchEnemies();
    patchFlow();
    // fallback ticker if Sky never appears (headless tests) or loads later
    if (!TC.Sky || !TC.Sky.__biomesPatched) {
      let last = performance.now();
      (function loop(now) {
        if (TC.Sky && patchSky()) { patchEnemies(); patchFlow(); return; }
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        if (TC.state === 'playing') try { Biomes.update(dt); } catch (e) {}
        requestAnimationFrame(loop);
      })(last);
    }
  }

  if (typeof document === 'undefined' || document.readyState !== 'loading') install();
  else document.addEventListener('DOMContentLoaded', install);
})();

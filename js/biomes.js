/* biomes.js — TC.Biomes: player-centered biome detection, sky tints,
   ambient particles/fog, spawn-table overrides and a music flag.

   Patch-free foundation module — no monkey-patching. The lead drives it:
     - TC.Biomes.update(dt): per-step detection scan (0.25s cadence),
       hysteresis flip (0.85s), tint blend, ambient particles. Call once per
       fixed step while playing — OR let TC.Systems 'environment' run it
       (registered here); pick one path, never both.
     - TC.Biomes.drawOverlay(ctx, viewW, viewH, cam): screen-space biome tint
       + fog. Call AFTER sky+world rendering and BEFORE the lighting overlay.
     - TC.Enemies.spawnDirector consults TC.Biomes.getSpawnOverride()
       directly (pure getter — see the note above SPAWN_OVERRIDE).
   Reset rides the event bus: TC.Events.EVENT.WorldLoaded clears all derived
   state. Nothing here is persisted — every field re-derives from player
   position within ~1s of play, so there is no SaveCore provider.

   Deterministic: no Math.random for state; particle spawns use Math.random
   (visual only).

   Load order: anywhere before main.js; TC.Events / TC.Systems refs guarded.
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
  // Values are arrays of [enemyId, weight], the exact shape of a
  // CONST.SPAWN.day/night entry. getSpawnOverride() hands these to
  // enemies.spawnDirector as the BASE table of the active zone ('day' or
  // 'night'); the 'cave' zone keeps the vanilla table, and a blood-moon
  // night keeps BLOOD_MOON_TABLE precedence (the old CONST-swap was ignored
  // there too).
  const SPAWN_OVERRIDE = {
    ocean: [['cave_bat', 1], ['green_slime', 1]],
    desert: [['green_slime', 2], ['blue_slime', 1]],
    snow: [['blue_slime', 3], ['green_slime', 1]],
    jungle: [['cave_bat', 2], ['blue_slime', 2]],
    underworld: [['demon_eye', 2], ['cave_bat', 2], ['zombie', 1]],
    cave: null // use vanilla cave table
  };
  // W17: post-Wall underworld supplement — ember wraith joins the mix once
  // the Wall falls (condition-gated, not a full replacement).
  const UNDERWORLD_POST_WALL = [['ember_wraith', 1.6]];

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
    // W5: record the discovery milestone once per world (guarded).
    if (TC.Progression && typeof TC.Progression.discoverBiome === 'function') {
      try { TC.Progression.discoverBiome(next); } catch (e) {}
    }
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
    // visual blend; forest stays untinted, cave keeps its faint palette
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

  // ---- screen-space overlay: tint + fog (+ underworld vignette) ----
  // Placement contract: AFTER sky+world/entity rendering, BEFORE lighting.
  // cam is accepted for signature stability; the tint is a full-screen wash.
  function drawOverlay(ctx, w, h, cam) {
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

  // ---- public API ----
  const Biomes = {
    get current() { return current; },
    get raw() { return raw; },
    get blend() { return blend; },
    get musicTag() { return current; },
    // Pure spawn override for enemies.spawnDirector. Returns an array of
    // [enemyId, weight] pairs — the same shape the old CONST.SPAWN swap
    // produced — or null to keep the vanilla table. Caller contract: when
    // non-null, use it AS THE BASE TABLE of the active zone ('day' or
    // 'night'); never apply it to the 'cave' zone; a blood-moon night keeps
    // BLOOD_MOON_TABLE precedence.
    getSpawnOverride: function () {
      if (current === 'forest' || current === 'cave') return null;
      const base = SPAWN_OVERRIDE[current] || null;
      if (current === 'underworld' && base && TC.Progression && typeof TC.Progression.has === 'function') {
        try { if (TC.Progression.has('boss.wall_of_flesh.defeated')) return base.concat(UNDERWORLD_POST_WALL); } catch (e) {}
      }
      return base;
    },
    // Per-step tick: detection scan + hysteresis + tint blend + ambience.
    update: tick,
    // Screen-space tint+fog; see placement contract above.
    drawOverlay: drawOverlay,
    reset: function () {
      current = 'forest'; raw = 'forest'; pending = 'forest'; pendingT = 0;
      blend = 0; scanAcc = 0; curPal = PAL.forest; tgtPal = PAL.forest;
    }
  };
  TC.Biomes = Biomes;

  // ---- foundation wiring ----
  // Update scheduler: the production loop ticks biomes in the 'environment'
  // phase. Gated to live simulation: no detection/ambience on title or while
  // paused.
  if (TC.Systems && typeof TC.Systems.register === 'function') {
    TC.Systems.register('environment', 'biomes', { update: tick }, {
      when: function () { return TC.state === 'playing' && !(TC.UI && TC.UI.paused); }
    });
  }
  // Fresh world => fresh derived biome state (replaces the old newGame/
  // continueGame wraps once the lead emits WorldLoaded there).
  if (TC.Events && TC.Events.EVENT && typeof TC.Events.on === 'function') {
    TC.Events.on(TC.Events.EVENT.WorldLoaded, function () { Biomes.reset(); });
  }
})();

/* lighting.js — flood-fill light propagation + darkness overlay.

   Extras:
   - TC.CONST.LIGHT_QUALITY: 'high' (default, current look) | 'low'
     (half-res overlay sampled from the same field; cheaper fill).
   - Lighting.addDynamic(x, y, r, intensity, ttl): transient light sources
     in WORLD PIXELS merged into the next recompute (pool-capped 64,
     zero per-call allocation). Feed from projectiles/gear/explosions. */
'use strict';
(function () {
  const TC = window.TC;

  const EPS = 0.002; // min improvement before re-propagating a cell
  const DYN_MAX = 64; // hard cap on transient (dynamic) light sources

  const Lighting = {
    world: null,
    x0: 0, y0: 0, w: 0, h: 0, // light window in tile coords
    light: null,              // Float32Array w*h, values 0..1
    queue: [],
    timer: 0,
    dirty: true,
    cvs: null, cctx: null, img: null,
    // half-res overlay used by CONST.LIGHT_QUALITY === 'low'
    lowCvs: null, lowCtx: null, lowImg: null,
    // fixed pool of DYN_MAX transient lights; slots are reused, never grown
    dyn: [], dynCursor: 0
  };

  TC.Lighting = Lighting;

  // Fixed-slot pool: allocated once, reused forever — addDynamic never grows.
  for (let i = 0; i < DYN_MAX; i++) {
    Lighting.dyn.push({ x: 0, y: 0, r: 0, intensity: 0, ttl: 0 });
  }

  Lighting.init = function (world) {
    this.world = world;
    this.light = null;
    this.w = 0; this.h = 0;
    this.queue.length = 0;
    this.timer = 0;
    this.dirty = true;
    this.cvs = null; this.cctx = null; this.img = null;
    for (let i = 0; i < DYN_MAX; i++) this.dyn[i].ttl = 0;
    this.dynCursor = 0;
  };

  Lighting.onTileChanged = function (x, y) {
    this.dirty = true;
  };

  // Register a transient light source; it feeds the NEXT recompute and lives
  // for ttl seconds. Coordinates x, y AND radius r are in WORLD PIXELS
  // (callers like projectiles/gear work in px); intensity is 0..1 light.
  // Pool-capped at DYN_MAX slots: when full, the cursor overwrites the oldest
  // slot. No allocation per call.
  Lighting.addDynamic = function (x, y, r, intensity, ttl) {
    if (!(intensity > 0) || !(r > 0)) return;
    let slot = null;
    for (let i = 0; i < DYN_MAX; i++) {
      if (this.dyn[i].ttl <= 0) { slot = this.dyn[i]; break; }
    }
    if (!slot) slot = this.dyn[this.dynCursor++ % DYN_MAX];
    slot.x = +x || 0;
    slot.y = +y || 0;
    slot.r = Math.min(+r || 0, 24 * TC.CONST.TS); // bound cost per source
    slot.intensity = Math.min(Math.max(+intensity || 0, 0), 1);
    slot.ttl = Math.max(+ttl || 0, 0);
  };

  // Merge alive dynamic sources into the recomputed window. Radial falloff,
  // no wall occlusion — these are cheap transient glows (muzzle flashes,
  // explosions, projectiles), not full propagators.
  function mergeDynamics(L) {
    const dyn = L.dyn, TSz = TC.CONST.TS;
    const light = L.light, w = L.w, h = L.h;
    const x0 = L.x0, y0 = L.y0;
    for (let d = 0; d < DYN_MAX; d++) {
      const s = dyn[d];
      if (s.ttl <= 0 || s.intensity <= 0) continue;
      const tx = s.x / TSz, ty = s.y / TSz, rt = s.r / TSz;
      const cx0 = Math.max(x0, Math.floor(tx - rt));
      const cx1 = Math.min(x0 + w - 1, Math.ceil(tx + rt));
      const cy0 = Math.max(y0, Math.floor(ty - rt));
      const cy1 = Math.min(y0 + h - 1, Math.ceil(ty + rt));
      for (let cy = cy0; cy <= cy1; cy++) {
        const dy = cy - ty, dy2 = dy * dy;
        for (let cx = cx0; cx <= cx1; cx++) {
          const dx = cx - tx;
          const dist = Math.sqrt(dx * dx + dy2);
          if (dist >= rt) continue;
          const fall = 1 - dist / rt;
          const v = s.intensity * fall * (0.4 + 0.6 * fall); // softened edge
          const i = (cy - y0) * w + (cx - x0);
          if (v > light[i]) light[i] = v;
        }
      }
    }
  }

  function skyLevel() {
    const L = TC.CONST.LIGHT;
    let day = 1;
    if (TC.Sky && typeof TC.Sky.daylight === 'function') day = TC.Sky.daylight();
    return L.skyNight + (L.skyDay - L.skyNight) * day;
  }

  // Full recompute of the light window covering the camera view + margin.
  Lighting.recompute = function (cam) {
    const world = this.world;
    if (!world || !cam) return;
    const L = TC.CONST.LIGHT, TS = TC.CONST.TS;
    const zoom = cam.zoom || 1;
    const cw = TC.canvas ? TC.canvas.width : 960;
    const ch = TC.canvas ? TC.canvas.height : 540;

    let x0 = Math.floor(cam.x / TS) - L.margin;
    let y0 = Math.floor(cam.y / TS) - L.margin;
    let x1 = Math.ceil((cam.x + cw / zoom) / TS) + L.margin;
    let y1 = Math.ceil((cam.y + ch / zoom) / TS) + L.margin;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(world.width, x1); y1 = Math.min(world.height, y1);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) { this.light = null; this.w = 0; this.h = 0; return; }

    this.x0 = x0; this.y0 = y0; this.w = w; this.h = h;
    const light = (this.light && this.light.length === w * h) ? this.light : new Float32Array(w * h);
    light.fill(0);
    this.light = light;

    const tiles = world.tiles, defs = TC.TILE_DEFS, ww = world.width;
    const sky = skyLevel();
    const q = this.queue;
    q.length = 0;

    // Seed sky light: per column, air above the first opaque tile.
    for (let x = x0; x < x1; x++) {
      for (let y = 0; y < y1; y++) {
        if (defs[tiles[y * ww + x]].opaque) break;
        if (y >= y0) {
          const i = (y - y0) * w + (x - x0);
          if (sky > light[i]) light[i] = sky;
        }
      }
    }

    // Seed emissive tiles (torch, furnace, ...).
    for (let y = y0; y < y1; y++) {
      const row = y * ww;
      for (let x = x0; x < x1; x++) {
        const emit = defs[tiles[row + x]].light;
        if (emit > 0) {
          const i = (y - y0) * w + (x - x0);
          if (emit > light[i]) light[i] = emit;
        }
      }
    }

    for (let i = 0; i < light.length; i++) if (light[i] > 0) q.push(i);

    // BFS propagation, 4-directional, decay by target tile opacity.
    const decayAir = L.decayAir, decaySolid = L.decaySolid;
    let head = 0;
    while (head < q.length) {
      const i = q[head++];
      const lv = light[i];
      const cx = x0 + (i % w), cy = y0 + ((i / w) | 0);
      for (let n = 0; n < 4; n++) {
        const nx = cx + (n < 2 ? (n === 0 ? -1 : 1) : 0);
        const ny = cy + (n >= 2 ? (n === 2 ? -1 : 1) : 0);
        if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
        const nl = lv - (defs[tiles[ny * ww + nx]].opaque ? decaySolid : decayAir);
        if (nl <= 0) continue;
        const ni = (ny - y0) * w + (nx - x0);
        if (nl > light[ni] + EPS) {
          light[ni] = nl;
          q.push(ni);
        }
      }
    }

    // transient sources ride on top of the propagated field
    mergeDynamics(this);
  };

  Lighting.update = function (dt, cam) {
    if (!this.world) return;
    this.timer += dt;
    for (let i = 0; i < DYN_MAX; i++) {
      if (this.dyn[i].ttl > 0) this.dyn[i].ttl -= dt;
    }
    if (this.dirty || this.timer >= TC.CONST.LIGHT.interval) {
      this.dirty = false;
      this.timer = 0;
      this.recompute(cam);
    }
  };

  // Presentation quality knob: TC.CONST.LIGHT_QUALITY 'high' (default,
  // current look — tile-res buffer bilinearly scaled up) or 'low' (half-res
  // overlay sampled from the same light field — quarter the fill cost).
  Lighting.draw = function (ctx, cam) {
    const w = this.w, h = this.h;
    if (!this.world || !this.light || w <= 0 || h <= 0) return;
    const low = TC.CONST.LIGHT_QUALITY === 'low';

    let cvs, cctx, iw, ih;
    if (low) {
      if (!this.lowCvs) {
        this.lowCvs = document.createElement('canvas');
        this.lowCtx = this.lowCvs.getContext('2d');
      }
      const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
      if (this.lowCvs.width !== hw || this.lowCvs.height !== hh) {
        this.lowCvs.width = hw;
        this.lowCvs.height = hh;
        this.lowImg = null;
      }
      if (!this.lowImg) this.lowImg = this.lowCtx.createImageData(hw, hh);
      cvs = this.lowCvs; cctx = this.lowCtx; iw = hw; ih = hh;
    } else {
      if (!this.cvs) {
        this.cvs = document.createElement('canvas');
        this.cctx = this.cvs.getContext('2d');
      }
      if (this.cvs.width !== w || this.cvs.height !== h) {
        this.cvs.width = w;
        this.cvs.height = h;
        this.img = null;
      }
      if (!this.img) this.img = this.cctx.createImageData(w, h);
      cvs = this.cvs; cctx = this.cctx; iw = w; ih = h;
    }

    // black pixels, alpha encodes darkness ('low' samples every other tile)
    const d = (low ? this.lowImg : this.img).data;
    const light = this.light;
    for (let y = 0; y < ih; y++) {
      const sy = low ? y * 2 : y;
      for (let x = 0; x < iw; x++) {
        const sx = low ? x * 2 : x;
        let a = (1 - light[sy * w + sx]) * 255;
        if (a < 0) a = 0; else if (a > 255) a = 255;
        const j = (y * iw + x) * 4;
        d[j] = 0; d[j + 1] = 0; d[j + 2] = 0;
        d[j + 3] = a | 0;
      }
    }
    cctx.putImageData(low ? this.lowImg : this.img, 0, 0);

    // blit scaled so each tile maps to TS*zoom screen px, aligned to world origin
    const TS = TC.CONST.TS;
    const dx = (this.x0 * TS - cam.x) * cam.zoom;
    const dy = (this.y0 * TS - cam.y) * cam.zoom;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(cvs, dx, dy, w * TS * cam.zoom, h * TS * cam.zoom);
    ctx.restore();
  };

  Lighting.lightAt = function (tx, ty) {
    if (!this.light) return 0;
    const x = tx - this.x0, y = ty - this.y0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    const v = this.light[y * this.w + x];
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
})();

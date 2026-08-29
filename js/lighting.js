/* lighting.js — RGB flood-fill light propagation + colored darkness overlay
   (W21 / LGT-001).

   Model: three Float32 channels (R,G,B) per cell in a camera-following
   window. Seeds are sky/ambient light (authored warm-day / blue-moon
   colors), emissive tiles (per-tile authored colors keyed by frozen
   def.name identity, neutral-white fallback for unmapped emitters) and a
   pooled set of transient dynamic sources (colored since W21 — the legacy
   5-argument addDynamic form still works and maps to neutral white).
   Propagation is 4-directional BFS decaying by target-cell opacity,
   identical for every channel; output = per-cell max(field, dynamics).

   REGION-AWARE INVALIDATION (W21 §6): instead of the legacy "any tile edit
   dirties the whole window", Lighting consumes the shared TC.WorldRegions
   authority through its own cursor. A static edit recomputes only the
   halo-expanded union of the touched regions. The halo (HALO ≥ maximum
   possible propagation distance: intensity ≤ 1 split across ≥ decayAir
   loss per tile) guarantees correctness: any source capable of shining
   into a recompute rect lies inside it, so rect-local BFS with absorbing
   edges reproduces the full-window result exactly for everything the edit
   can influence. Full-window reseeds happen only on: window movement,
   world swap/init, a global daylight quantum step, or missing region
   infrastructure (legacy fallback). Counters prove how much work ran.

   QUALITY PROFILES (W21 §8): low | medium | high scale ONLY presentation —
   the overlay raster sampling step and the dynamic-merge cadence. Field
   values and every query (lightAt / lightRgbAt) are identical across
   profiles, so simulation semantics never change. Selected via
   TC.Lighting.setQuality(); persisted through TC.Settings ('lightingQuality')
   — never inside world saves. Default falls back to TC.CONST.LIGHT_QUALITY.

   BACKWARD COMPATIBILITY:
   - lightAt(tx,ty) keeps returning scalar 0..1 (Rec.709 luminance of the
     RGB field — equals the raw value for neutral sources);
   - lightRgbAt(tx,ty) exposes the additive RGB triple (writes into an
     optional out array to avoid allocation);
   - onTileChanged(x,y) remains a valid hint; with WorldRegions present it
     is advisory only because region revisions carry the real signal;
   - CONST.LIGHT_QUALITY still provides the default profile. */
'use strict';
(function () {
  const TC = window.TC;

  const EPS = 0.002;          // min improvement before re-propagating a cell
  const DYN_MAX = 64;         // hard cap on transient (dynamic) light sources
  // Propagation halo: farthest light can possibly travel in tiles.
  const HALO = Math.ceil(1 / TC.CONST.LIGHT.decayAir) + 2;
  // Window alignment: the light window snaps to this grid so smooth camera
  // motion crosses a boundary every N tiles instead of every tile. Without
  // it, a walk forces a full-window reseed several times per second.
  const WIN_ALIGN = 8;
  const SKY_QUANTUM = 0.02;   // daylight delta that forces an ambient reseed
  const LUM_R = 0.2126, LUM_G = 0.7152, LUM_B = 0.0722;

  // ---- project-authored colors (original palette; nothing copied) ----
  // Emissive tint per tile keyed by the FROZEN def.name identity string.
  // Unmapped emitters fall back to neutral white (legacy scalar behavior).
  const EMISSIVE_RGB = {
    'torch': [1.0, 0.83, 0.45],        // flame yellow
    'furnace': [1.0, 0.58, 0.25],      // ember orange
    'lava': [1.0, 0.42, 0.12],         // molten orange-red
    'gleamstone': [0.45, 0.95, 0.90],  // cavern teal
    'gleam crystal': [0.72, 0.48, 0.95], // violet shimmer
    'life crystal': [1.0, 0.32, 0.36]  // rose red
  };
  const NEUTRAL = [1, 1, 1];
  const SKY_DAY_RGB = [1.0, 0.97, 0.90];   // warm noon white
  const SKY_NIGHT_RGB = [0.10, 0.13, 0.22]; // cool moonlight blue

  const QUALITIES = ['low', 'medium', 'high'];
  // Presentation-only knobs per profile: overlay samples every `step`-th
  // tile; `dynSkip` throttles the dynamic-merge cadence in ticks (moving
  // glows update at 60/30/15 Hz). Field math identical across profiles.
  const PROFILE = {
    low: { step: 3, dynSkip: 3 },
    medium: { step: 2, dynSkip: 1 },
    high: { step: 1, dynSkip: 0 }
  };

  function hexToRgb(hex) {
    // PERF: callers re-register the same '#rrggbb' literals every frame;
    // parse once per distinct string (bounded set of authored colors).
    let hit = HEX_CACHE.get(hex);
    if (hit !== undefined) return hit;
    let h = String(hex == null ? '' : hex).trim();
    if (h.charCodeAt(0) === 35) h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) { hit = null; }
    else {
      const n = parseInt(h, 16);
      hit = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    if (HEX_CACHE.size < 256) HEX_CACHE.set(hex, hit); // bound defensive
    return hit;
  }
  const HEX_CACHE = new Map();

  const Lighting = {
    world: null,
    x0: 0, y0: 0, w: 0, h: 0,   // light window in tile coords
    fieldR: null, fieldG: null, fieldB: null, // propagated static field
    outR: null, outG: null, outB: null,       // display = field ⊕ dynamics
    queue: [],
    dirty: true,                // legacy fallback flag (no WorldRegions)
    fullDirty: true,            // next update reseeds the entire window
    cvs: null, cctx: null, img: null,
    // fixed pool of DYN_MAX transient lights; slots are reused, never grown
    dyn: [], dynCursor: 0,
    _consumer: null,            // WorldRegions cursor ('lighting')
    _lastWinX: 1e9, _lastWinY: 1e9, _lastWinW: -1, _lastWinH: -1,
    _skyQ: -1,                  // quantized daylight already rendered
    _quality: null,             // active profile name
    _dynFrame: 0,               // cadence counter for low-profile merges
    _prevDynBox: null,          // union box of last frame's live dyns
    _mergeSig: null,            // position signature of last merge
    _dirtySinceMerge: true,
    // PERF (W27): draw() used to rebuild the overlay ImageData pixel-by-pixel
    // and re-upload it via putImageData every frame, even on a fully static
    // scene (no field change, no live dynamic lights, camera stationary).
    // This tracks whether outR/outG/outB actually changed since the last
    // upload; draw() still re-blits at the camera's current position every
    // frame (cheap, and required while the camera eases toward the player),
    // it just skips re-deriving and re-uploading identical pixel data.
    _overlayDirty: true
  };
  for (let i = 0; i < DYN_MAX; i++) {
    Lighting.dyn.push({ x: 0, y: 0, r: 0, intensity: 0, ttl: 0, cr: 1, cg: 1, cb: 1 });
  }

  TC.Lighting = Lighting;

  // Lifetime observability — benchmarks/tests prove how much work ran.
  const counters = {
    fullRecomputes: 0,
    rectRecomputes: 0,
    cellsRecomputed: 0,
    regionsObserved: 0,
    dynMerges: 0,
    skyReseeds: 0,
    windowMoves: 0
  };
  Lighting.counters = function () { return Object.assign({}, counters); };

  function storedQuality() {
    try {
      if (TC.Settings && typeof TC.Settings.get === 'function') {
        const q = TC.Settings.get('lightingQuality');
        if (QUALITIES.indexOf(q) >= 0) return q;
      }
    } catch (e) {}
    return (TC.CONST.LIGHT_QUALITY && PROFILE[TC.CONST.LIGHT_QUALITY])
      ? TC.CONST.LIGHT_QUALITY : 'high';
  }
  Lighting.quality = function () { return this._quality || storedQuality(); };
  // Programmatic quality contract (§8): no menu UI ships in W21; persisted
  // via TC.Settings so it survives reloads outside world saves.
  Lighting.setQuality = function (q) {
    if (!q || PROFILE[q] == null) return false;
    this._quality = q;
    try {
      if (TC.Settings && typeof TC.Settings.set === 'function') TC.Settings.set('lightingQuality', q);
    } catch (e) {}
    return true;
  };

  function skyMix() {
    let day = 1;
    if (TC.Sky && typeof TC.Sky.daylight === 'function') day = TC.Sky.daylight();
    return {
      day: day,
      level: TC.CONST.LIGHT.skyNight + (TC.CONST.LIGHT.skyDay - TC.CONST.LIGHT.skyNight) * day,
      r: SKY_NIGHT_RGB[0] + (SKY_DAY_RGB[0] - SKY_NIGHT_RGB[0]) * day,
      g: SKY_NIGHT_RGB[1] + (SKY_DAY_RGB[1] - SKY_NIGHT_RGB[1]) * day,
      b: SKY_NIGHT_RGB[2] + (SKY_DAY_RGB[2] - SKY_NIGHT_RGB[2]) * day
    };
  }

  Lighting.init = function (world) {
    this.world = world;
    this.fieldR = this.fieldG = this.fieldB = null;
    this.outR = this.outG = this.outB = null;
    this.w = 0; this.h = 0;
    this.queue.length = 0;
    this.dirty = true;
    this.fullDirty = true;
    this.cvs = null; this.cctx = null; this.img = null;
    for (let i = 0; i < DYN_MAX; i++) this.dyn[i].ttl = 0;
    this.dynCursor = 0;
    this._lastWinX = 1e9; this._lastWinY = 1e9; this._lastWinW = -1; this._lastWinH = -1;
    this._skyQ = -1;
    this._prevDynBox = null;
    this._mergeSig = null;
    this._dirtySinceMerge = true;
    this._overlayDirty = true;
    this._consumer = (TC.WorldRegions && typeof TC.WorldRegions.consume === 'function' && world)
      ? TC.WorldRegions.consume('lighting') : null;
  };

  // Legacy hint seam: with the region authority present this is advisory —
  // the authoritative signal arrives through region revisions. Without it
  // (bare embeds) the coarse legacy flag still works.
  Lighting.onTileChanged = function (x, y) {
    void x; void y;
    if (!this._consumer) this.dirty = true;
  };

  // Register a transient light source; it feeds the NEXT merge and lives
  // for ttl seconds. Coordinates x/y AND radius r are in WORLD PIXELS;
  // intensity is 0..1. `color` (optional) is '#rrggbb' — omitted keeps the
  // legacy neutral-white behavior exactly.
  Lighting.addDynamic = function (x, y, r, intensity, ttl, color) {
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
    const rgb = hexToRgb(color);
    if (rgb) {
      slot.cr = rgb[0] / 255; slot.cg = rgb[1] / 255; slot.cb = rgb[2] / 255;
    } else {
      slot.cr = slot.cg = slot.cb = 1;
    }
  };

  // ---- window management -------------------------------------------------
  function allocWindow(L, w, h) {
    const n = w * h;
    // Reuse buffers across window moves: only grow when the window got
    // bigger. Index meaning shifts with x0/y0, but every move flags a full
    // reseed, so stale contents never leak into queries.
    if (!L.fieldR || L.fieldR.length < n) {
      L.fieldR = new Float32Array(n); L.fieldG = new Float32Array(n); L.fieldB = new Float32Array(n);
      L.outR = new Float32Array(n); L.outG = new Float32Array(n); L.outB = new Float32Array(n);
    }
  }

  Lighting.ensureWindow = function (cam) {
    const world = this.world;
    if (!world || !cam) return false;
    const L = TC.CONST.LIGHT, TSz = TC.CONST.TS;
    const zoom = cam.zoom || 1;
    const cw = TC.canvas ? TC.canvas.width : 960;
    const ch = TC.canvas ? TC.canvas.height : 540;
    let x0 = Math.floor(cam.x / TSz) - L.margin;
    let y0 = Math.floor(cam.y / TSz) - L.margin;
    let x1 = Math.ceil((cam.x + cw / zoom) / TSz) + L.margin;
    let y1 = Math.ceil((cam.y + ch / zoom) / TSz) + L.margin;
    // snap outward to the alignment grid (larger window, rarer moves)
    x0 = Math.max(0, Math.floor(x0 / WIN_ALIGN) * WIN_ALIGN);
    y0 = Math.max(0, Math.floor(y0 / WIN_ALIGN) * WIN_ALIGN);
    x1 = Math.min(world.width, Math.ceil(x1 / WIN_ALIGN) * WIN_ALIGN);
    y1 = Math.min(world.height, Math.ceil(y1 / WIN_ALIGN) * WIN_ALIGN);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) { this.w = 0; this.h = 0; return false; }
    if (x0 !== this.x0 || y0 !== this.y0 || w !== this.w || h !== this.h) {
      this.x0 = x0; this.y0 = y0; this.w = w; this.h = h;
      allocWindow(this, w, h);
      this.fullDirty = true;
      counters.windowMoves++;
      this._lastWinX = x0; this._lastWinY = y0; this._lastWinW = w; this._lastWinH = h;
    }
    return true;
  };

  // ---- propagation -------------------------------------------------------
  // Recompute field channels inside [rx0..rx1]x[ry0..ry1] (tile coords,
  // clamped to the window) from scratch: sky columns, emissive tiles, BFS.
  // Absorbing rect edges are CORRECT given the caller's halo expansion.
  Lighting.recomputeRect = function (rx0, ry0, rx1, ry1) {
    const w = this.w, h = this.h;
    if (w <= 0 || h <= 0) return;
    rx0 = Math.max(this.x0, rx0); ry0 = Math.max(this.y0, ry0);
    rx1 = Math.min(this.x0 + w - 1, rx1); ry1 = Math.min(this.y0 + h - 1, ry1);
    if (rx1 < rx0 || ry1 < ry0) return;

    const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
    const fR = this.fieldR, fG = this.fieldG, fB = this.fieldB;
    const ww = this.world.width, tiles = this.world.tiles, defs = TC.TILE_DEFS;
    const q = this.queue;
    q.length = 0;
    const sky = skyMix();

    // clear the rect
    for (let y = ry0; y <= ry1; y++) {
      const row = (y - this.y0) * w;
      fR.fill(0, row + (rx0 - this.x0), row + (rx1 - this.x0) + 1);
      fG.fill(0, row + (rx0 - this.x0), row + (rx1 - this.x0) + 1);
      fB.fill(0, row + (rx0 - this.x0), row + (rx1 - this.x0) + 1);
    }

    // Seed sky light: per column, air above the first opaque tile. The scan
    // starts at the world top so a surface edit re-derives the column's
    // open-sky depth honestly.
    for (let x = rx0; x <= rx1; x++) {
      for (let y = 0; y <= ry1; y++) {
        if (defs[tiles[y * ww + x]].opaque) break;
        if (y >= ry0) {
          const i = (y - this.y0) * w + (x - this.x0);
          const v = sky.level;
          if (v > fR[i]) { fR[i] = v * sky.r; fG[i] = v * sky.g; fB[i] = v * sky.b; }
        }
      }
    }

    // Seed emissive tiles (colored; neutral fallback keeps legacy look).
    for (let y = ry0; y <= ry1; y++) {
      const rowT = y * ww, rowL = (y - this.y0) * w;
      for (let x = rx0; x <= rx1; x++) {
        const id = tiles[rowT + x];
        const emit = defs[id].light;
        if (emit > 0) {
          const col = EMISSIVE_RGB[defs[id].name] || NEUTRAL;
          const i = rowL + (x - this.x0);
          const vr = emit * col[0], vg = emit * col[1], vb = emit * col[2];
          if (vr > fR[i]) fR[i] = vr;
          if (vg > fG[i]) fG[i] = vg;
          if (vb > fB[i]) fB[i] = vb;
        }
      }
    }

    for (let y = ry0; y <= ry1; y++) {
      const rowL = (y - this.y0) * w;
      for (let x = rx0; x <= rx1; x++) {
        const i = rowL + (x - this.x0);
        if (fR[i] > 0 || fG[i] > 0 || fB[i] > 0) q.push(i);
      }
    }

    // BFS propagation, 4-directional, decay by target tile opacity. Queue
    // order is fixed => deterministic output for identical inputs.
    const decayAir = TC.CONST.LIGHT.decayAir, decaySolid = TC.CONST.LIGHT.decaySolid;
    let head = 0;
    while (head < q.length) {
      const i = q[head++];
      const lr = fR[i], lg = fG[i], lb = fB[i];
      const cx = this.x0 + (i % w), cy = this.y0 + ((i / w) | 0);
      for (let n = 0; n < 4; n++) {
        const nx = cx + (n < 2 ? (n === 0 ? -1 : 1) : 0);
        const ny = cy + (n >= 2 ? (n === 2 ? -1 : 1) : 0);
        if (nx < rx0 || nx > rx1 || ny < ry0 || ny > ry1) continue; // rect-bounded
        const dec = defs[tiles[ny * ww + nx]].opaque ? decaySolid : decayAir;
        const nr = lr - dec, ng = lg - dec, nb = lb - dec;
        if (nr <= 0 && ng <= 0 && nb <= 0) continue;
        const ni = (ny - this.y0) * w + (nx - this.x0);
        let push = false;
        if (nr > fR[ni] + EPS) { fR[ni] = nr; push = true; }
        if (ng > fG[ni] + EPS) { fG[ni] = ng; push = true; }
        if (nb > fB[ni] + EPS) { fB[ni] = nb; push = true; }
        if (push) q.push(ni);
      }
    }

    counters.rectRecomputes++;
    counters.cellsRecomputed += rw * rh;
  };

  // Legacy full-window entry point (kept for embeds/tests). Writes into
  // out* the same as update()'s fullDirty branch, so it must set
  // _overlayDirty the same way — an embed calling this directly instead of
  // through update() would otherwise leave draw() blitting a stale overlay.
  Lighting.recompute = function (cam) {
    if (!this.ensureWindow(cam)) return;
    this.recomputeRect(this.x0, this.y0, this.x0 + this.w - 1, this.y0 + this.h - 1);
    counters.fullRecomputes++;
    this.syncOut(this.x0, this.y0, this.x0 + this.w - 1, this.y0 + this.h - 1);
    this.fullDirty = false;
    this._overlayDirty = true;
  };

  // Copy field -> out for a rect (display baseline before dynamics).
  Lighting.syncOut = function (rx0, ry0, rx1, ry1) {
    const w = this.w;
    rx0 = Math.max(this.x0, rx0) - this.x0; ry0 = Math.max(this.y0, ry0) - this.y0;
    rx1 = Math.min(this.x0 + this.w - 1, rx1) - this.x0;
    ry1 = Math.min(this.y0 + this.h - 1, ry1) - this.y0;
    for (let y = ry0; y <= ry1; y++) {
      const row = y * w;
      for (let x = rx0; x <= rx1; x++) {
        const i = row + x;
        this.outR[i] = this.fieldR[i];
        this.outG[i] = this.fieldG[i];
        this.outB[i] = this.fieldB[i];
      }
    }
  };

  // Merge alive dynamic sources onto `out` over the union of their boxes.
  // Radial falloff, no occlusion — cheap transient glows, not propagators.
  // Union box of alive dynamic sources + position signature in ONE pass.
  // Writes into L._ubox scratch (no per-frame allocation).
  function dynUnionBox(L) {
    const TSz = TC.CONST.TS;
    const box = L._ubox || (L._ubox = { x0: 0, y0: 0, x1: 0, y1: 0, any: false });
    box.any = false;
    let sig = 0;
    for (let d = 0; d < DYN_MAX; d++) {
      const s = L.dyn[d];
      if (s.ttl <= 0 || s.intensity <= 0) continue;
      const tx = s.x / TSz, ty = s.y / TSz, rt = s.r / TSz;
      const x0 = tx - rt, x1 = tx + rt, y0 = ty - rt, y1 = ty + rt;
      if (!box.any) { box.x0 = x0; box.y0 = y0; box.x1 = x1; box.y1 = y1; box.any = true; }
      else {
        if (x0 < box.x0) box.x0 = x0;
        if (y0 < box.y0) box.y0 = y0;
        if (x1 > box.x1) box.x1 = x1;
        if (y1 > box.y1) box.y1 = y1;
      }
      sig = (sig + s.x * 7 + s.y * 13 + s.r * 29 + d * 101) | 0;
    }
    box.sig = sig;
    return box;
  }

  // Returns whether `out` actually changed (drives Lighting._overlayDirty —
  // W27 — so draw() knows whether the presentation overlay needs a re-blit).
  Lighting.mergeDynamics = function () {
    const w = this.w, h = this.h;
    if (w <= 0 || h <= 0) return false;
    const cur = dynUnionBox(this);
    const sig = cur.sig;
    // Static-scene skip: identical live-source layout on an unchanged field
    // means `out` is already correct (ttl decay does not affect pixels).
    if (!this._dirtySinceMerge && sig === this._mergeSig) return false;
    // Reset the union of PREVIOUS and CURRENT dyn coverage from the pristine
    // field, then stamp current sources — moving/expiring glows leave no
    // residue.
    const prev = this._prevDynBox;
    let ux0 = 1e9, uy0 = 1e9, ux1 = -1e9, uy1 = -1e9;
    if (prev && prev.any) {
      ux0 = prev.x0; uy0 = prev.y0; ux1 = prev.x1; uy1 = prev.y1;
    }
    if (cur.any) {
      if (cur.x0 < ux0) ux0 = cur.x0;
      if (cur.y0 < uy0) uy0 = cur.y0;
      if (cur.x1 > ux1) ux1 = cur.x1;
      if (cur.y1 > uy1) uy1 = cur.y1;
    }
    this._prevDynBox = { x0: cur.x0, y0: cur.y0, x1: cur.x1, y1: cur.y1, any: cur.any };
    const changed = ux1 >= ux0;
    if (changed) {
      // syncOut takes WORLD tile coords and window-offsets internally.
      this.syncOut(Math.floor(ux0), Math.floor(uy0),
                   Math.ceil(ux1), Math.ceil(uy1));
    }
    if (!cur.any) return changed;

    const TSz = TC.CONST.TS;
    const oR = this.outR, oG = this.outG, oB = this.outB;
    const x0 = this.x0, y0 = this.y0;
    for (let d = 0; d < DYN_MAX; d++) {
      const s = this.dyn[d];
      if (s.ttl <= 0 || s.intensity <= 0) continue;
      const tx = s.x / TSz, ty = s.y / TSz, rt = s.r / TSz;
      const cx0 = Math.max(x0, Math.floor(tx - rt));
      const cx1 = Math.min(x0 + w - 1, Math.ceil(tx + rt));
      const cy0 = Math.max(y0, Math.floor(ty - rt));
      const cy1 = Math.min(y0 + h - 1, Math.ceil(ty + rt));
      for (let cy = cy0; cy <= cy1; cy++) {
        const dy = cy - ty, dy2 = dy * dy;
        const rt2 = rt * rt;
        for (let cx = cx0; cx <= cx1; cx++) {
          const dx = cx - tx;
          const d2 = dx * dx + dy2;
          if (d2 >= rt2) continue; // squared early-out skips corner sqrts
          const dist = Math.sqrt(d2);
          const fall = 1 - dist / rt;
          const k = s.intensity * fall * (0.4 + 0.6 * fall); // softened edge
          const vr = k * s.cr, vg = k * s.cg, vb = k * s.cb;
          const i = (cy - y0) * w + (cx - x0);
          if (vr > oR[i]) oR[i] = vr;
          if (vg > oG[i]) oG[i] = vg;
          if (vb > oB[i]) oB[i] = vb;
        }
      }
    }
    counters.dynMerges++;
    this._mergeSig = sig;
    this._dirtySinceMerge = false;
    return true;
  };

  // Structural refresh driven by the shared region authority: expand each
  // stale region intersecting the window by the propagation halo, merge
  // overlapping rects, recompute each once, observe what we consumed.
  // Entries OUTSIDE the window are observed too, deliberately: they cannot
  // affect the current field (halo isolation) and any future reveal runs
  // through a window move, which forces a full reseed of everything shown.
  Lighting.regionRefresh = function () {
    const cons = this._consumer;
    if (!cons) return false;
    const WR = TC.WorldRegions;
    const dirty = cons.dirtyRegions();
    if (!dirty.length) return false;
    const wx1 = this.x0 + this.w - 1, wy1 = this.y0 + this.h - 1;
    const rects = [];
    const observed = [];
    for (let k = 0; k < dirty.length; k++) {
      const idx = dirty[k];
      const cc = WR.chunkCoords(idx);
      const rx0 = cc.cx * WR.CHUNK, ry0 = cc.cy * WR.CHUNK;
      const rx1 = rx0 + WR.CHUNK - 1, ry1 = ry0 + WR.CHUNK - 1;
      if (rx1 < this.x0 - HALO || rx0 > wx1 + HALO ||
          ry1 < this.y0 - HALO || ry0 > wy1 + HALO) {
        // outside view+halo: nothing to recompute now; covered on reveal by
        // the window-move full reseed. Observe so the queue drains.
        cons.observe(idx);
        counters.regionsObserved++;
        continue;
      }
      rects.push({
        x0: Math.max(this.x0, rx0 - HALO),
        y0: Math.max(this.y0, ry0 - HALO),
        x1: Math.min(wx1, rx1 + HALO),
        y1: Math.min(wy1, ry1 + HALO)
      });
      observed.push(idx);
    }
    if (!observed.length) return false;
    // merge overlapping/adjacent rects (sort by x0, fuse when touching on
    // both axes — equal halos keep same-row regions contiguous)
    rects.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
    const merged = [];
    for (const r of rects) {
      const last = merged[merged.length - 1];
      const yTouch = last && r.y0 <= last.y1 + 1 && r.y1 + 1 >= last.y0;
      if (last && r.x0 <= last.x1 + 1 && yTouch) {
        if (r.x1 > last.x1) last.x1 = r.x1;
        if (r.y0 < last.y0) last.y0 = r.y0;
        if (r.y1 > last.y1) last.y1 = r.y1;
      } else merged.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 });
    }
    for (const r of merged) {
      this.recomputeRect(r.x0, r.y0, r.x1, r.y1);
      this.syncOut(r.x0, r.y0, r.x1, r.y1);
    }
    for (const idx of observed) { cons.observe(idx); counters.regionsObserved++; }
    return true;
  };

  Lighting.update = function (dt, cam) {
    if (!this.world) return;
    for (let i = 0; i < DYN_MAX; i++) {
      if (this.dyn[i].ttl > 0) this.dyn[i].ttl -= dt;
    }
    if (!this.ensureWindow(cam)) return;

    // Global ambient change (sun/moon arc): reseed sky-lit columns. The
    // daylight value is quantized so a static scene costs nothing while the
    // sky sits between quanta; dusk/dawn pay one full reseed per step.
    const sky = skyMix();
    const q = Math.round(sky.level / SKY_QUANTUM);
    if (q !== this._skyQ) {
      this._skyQ = q;
      if (!this.fullDirty) counters.skyReseeds++;
      this.fullDirty = true;
    }

    if (this.fullDirty) {
      this.recomputeRect(this.x0, this.y0, this.x0 + this.w - 1, this.y0 + this.h - 1);
      counters.fullRecomputes++;
      this.syncOut(this.x0, this.y0, this.x0 + this.w - 1, this.y0 + this.h - 1);
      // Consume every stale region the full reseed covered (direct scan —
      // the cursor may have already delivered some of these); regions
      // outside the window stay pending for their future reveal.
      if (this._consumer) {
        const WR = TC.WorldRegions;
        const wx1 = this.x0 + this.w - 1, wy1 = this.y0 + this.h - 1;
        for (const idx of this._consumer.staleAll()) {
          const cc = WR.chunkCoords(idx);
          if (cc.cx * WR.CHUNK > wx1 || (cc.cx + 1) * WR.CHUNK - 1 < this.x0 ||
              cc.cy * WR.CHUNK > wy1 || (cc.cy + 1) * WR.CHUNK - 1 < this.y0) continue;
          this._consumer.observe(idx);
          counters.regionsObserved++;
        }
      }
      this.fullDirty = false;
      this.dirty = false;
      this._dirtySinceMerge = true;
      this._overlayDirty = true;
    } else if (this.regionRefresh()) {
      this._dirtySinceMerge = true;
      this._overlayDirty = true;
    } else if (this.dirty) {
      // legacy fallback (no region authority)
      this.recomputeRect(this.x0, this.y0, this.x0 + this.w - 1, this.y0 + this.h - 1);
      counters.fullRecomputes++;
      this.syncOut(this.x0, this.y0, this.x0 + this.w - 1, this.y0 + this.h - 1);
      this.dirty = false;
      this._dirtySinceMerge = true;
      this._overlayDirty = true;
    }

    // Dynamic merge cadence: high/medium every simulated tick with live
    // sources, low every other tick. Presentation-only throttling; field
    // queries are unaffected.
    this._dynFrame++;
    const skip = PROFILE[this.quality()].dynSkip;
    let hasLive = this._prevDynBox != null && this._prevDynBox.any === true;
    if (!hasLive) {
      for (let i = 0; i < DYN_MAX; i++) {
        if (this.dyn[i].ttl > 0) { hasLive = true; break; }
      }
    }
    if (hasLive && (skip === 0 || (this._dynFrame & 1) === 0)) {
      if (this.mergeDynamics()) this._overlayDirty = true;
    }
  };

  // ---- queries ----
  // Scalar luminance (Rec.709) of the RGB field — the legacy 0..1 reading.
  Lighting.lightAt = function (tx, ty) {
    if (!this.outR || this.w <= 0) return 0;
    const x = tx - this.x0, y = ty - this.y0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    const i = y * this.w + x;
    let v = LUM_R * this.outR[i] + LUM_G * this.outG[i] + LUM_B * this.outB[i];
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };

  // Additive RGB query (W21). Writes into `out` (length>=3) when given to
  // avoid allocation, otherwise returns a fresh triple. Channels are NOT
  // clamped to 1 individually here beyond propagation bounds; consumers
  // rendering multiply overlays clamp themselves.
  Lighting.lightRgbAt = function (tx, ty, out) {
    const r = out || [0, 0, 0];
    if (!this.outR || this.w <= 0) { r[0] = r[1] = r[2] = 0; return r; }
    const x = tx - this.x0, y = ty - this.y0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) { r[0] = r[1] = r[2] = 0; return r; }
    const i = y * this.w + x;
    r[0] = this.outR[i]; r[1] = this.outG[i]; r[2] = this.outB[i];
    return r;
  };

  // ---- presentation ------------------------------------------------------
  // Colored multiply overlay: pixel = light color scaled to 0..255. Neutral
  // bright light reproduces the legacy white/no-darkening result; dark caves
  // resolve toward the ambient (night: moonlit blue) instead of pure black.
  Lighting.draw = function (ctx, cam) {
    const w = this.w, h = this.h;
    if (!this.world || !this.outR || w <= 0 || h <= 0) return;
    const prof = PROFILE[this.quality()];
    const step = prof.step;
    const iw = Math.ceil(w / step), ih = Math.ceil(h / step);

    if (!this.cvs) {
      this.cvs = document.createElement('canvas');
      this.cctx = this.cvs.getContext('2d');
    }
    if (this.cvs.width !== iw || this.cvs.height !== ih) {
      this.cvs.width = iw;
      this.cvs.height = ih;
      this.img = null;
      this._overlayDirty = true;
    }
    if (!this.img) { this.img = this.cctx.createImageData(iw, ih); this._overlayDirty = true; }

    // PERF (W27): rebuilding this ImageData is a per-pixel loop and
    // putImageData forces a texture upload — both pure waste on an unchanged
    // scene (Lighting.update sets _overlayDirty only when outR/outG/outB
    // actually changed). The overlay canvas itself persists across frames,
    // so skipping this leaves cctx holding exactly the last uploaded pixels
    // — byte-identical to what a rebuild would produce, since nothing wrote
    // new values into outR/outG/outB in between. The blit below still runs
    // every frame at the camera's current position.
    if (this._overlayDirty) {
      const d = this.img.data;
      const oR = this.outR, oG = this.outG, oB = this.outB;
      for (let y = 0; y < ih; y++) {
        const sy = y * step;
        for (let x = 0; x < iw; x++) {
          const sx = x * step;
          const i = sy * w + sx;
          const j = (y * iw + x) * 4;
          let r = oR[i] * 255; if (r > 255) r = 255; else if (r < 0) r = 0;
          let g = oG[i] * 255; if (g > 255) g = 255; else if (g < 0) g = 0;
          let b = oB[i] * 255; if (b > 255) b = 255; else if (b < 0) b = 0;
          d[j] = r | 0; d[j + 1] = g | 0; d[j + 2] = b | 0; d[j + 3] = 255;
        }
      }
      this.cctx.putImageData(this.img, 0, 0);
      this._overlayDirty = false;
    }

    // blit scaled so each tile maps to TS*zoom screen px, aligned to world origin
    const TSz = TC.CONST.TS;
    const dx = (this.x0 * TSz - cam.x) * cam.zoom;
    const dy = (this.y0 * TSz - cam.y) * cam.zoom;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.cvs, dx, dy, w * TSz * cam.zoom, h * TSz * cam.zoom);
    ctx.restore();
  };
})();

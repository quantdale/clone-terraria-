/* sky.js — day/night cycle: keyframed sky gradients, sun/moon arcs, twinkling
   stars, drifting clouds, biome parallax silhouette layers, underground fade.
   Screen space. Moon runs a 4-phase cycle indexed by day count
   (phase = floor(time / CYCLE) % 4; 0 = full, 1 = waning half, 2 = new,
   3 = waxing half) — derived from the already-persisted Sky.time, no extra
   saved state; see TC.Sky.moonPhase(). Background silhouettes are two depth
   layers (0.15x / 0.35x camera scroll) shaped + tinted by the current biome,
   deterministic per world via TC.worldSeed hashes with cached segment points. */
'use strict';
(function () {
  const TC = window.TC;
  const DAY = TC.CONST.DAY_LENGTH;
  const NIGHT = TC.CONST.NIGHT_LENGTH;
  const CYCLE = DAY + NIGHT;
  const RAMP = CYCLE * 0.04;       // dawn/dusk light ramp width (seconds)
  const TS = TC.CONST.TS;
  const TAU = Math.PI * 2;

  // ---- local math ----
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const mod = (v, m) => ((v % m) + m) % m;

  // ---- seeded helpers (prefer TC.Utils; local fallbacks keep the sky alive
  //      on its own while sibling modules land) ----
  function hash2(x, y, s) {
    const U = TC.Utils;
    if (U && typeof U.hash2 === 'function') return U.hash2(x, y, s);
    let h = ((x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 1440662683) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---- keyframed palettes across one cycle (phase = seconds into cycle) ----
  const KEYS = [
    { p: 0,   top: [88, 100, 160],  bot: [255, 176, 116] },  // sunrise
    { p: 205, top: [92, 158, 222],  bot: [168, 212, 242] },  // clear day
    { p: 385, top: [122, 122, 192], bot: [255, 178, 118] },  // late afternoon
    { p: 420, top: [100, 84, 152],  bot: [255, 132, 84] },   // sunset
    { p: 460, top: [42, 42, 86],    bot: [150, 78, 100] },   // dusk
    { p: 540, top: [8, 10, 28],     bot: [26, 32, 60] },     // midnight
    { p: 622, top: [24, 28, 58],    bot: [68, 56, 96] }      // pre-dawn
  ];

  function paletteAt(p) {
    let i = 0;
    for (let k = 0; k < KEYS.length; k++) { if (KEYS[k].p <= p) i = k; else break; }
    const a = KEYS[i];
    const b = KEYS[(i + 1) % KEYS.length];
    const span = (i + 1 < KEYS.length ? b.p : CYCLE) - a.p;
    const f = smooth(span > 0 ? (p - a.p) / span : 0);
    return [
      Math.round(lerp(a.top[0], b.top[0], f)), Math.round(lerp(a.top[1], b.top[1], f)),
      Math.round(lerp(a.top[2], b.top[2], f)),
      Math.round(lerp(a.bot[0], b.bot[0], f)), Math.round(lerp(a.bot[1], b.bot[1], f)),
      Math.round(lerp(a.bot[2], b.bot[2], f))
    ];
  }

  // ---- fixed star field (seeded, twinkles) ----
  const STAR_SEED = 777, STAR_N = 200;
  let stars = null;
  function starField() {
    if (stars) return stars;
    stars = [];
    for (let i = 0; i < STAR_N; i++) {
      stars.push({
        x: hash2(i, 1, STAR_SEED),
        y: hash2(i, 2, STAR_SEED) * 0.72,
        r: 0.5 + hash2(i, 3, STAR_SEED) * 1.3,
        ph: hash2(i, 4, STAR_SEED) * TAU,
        sp: 0.6 + hash2(i, 5, STAR_SEED) * 1.8
      });
    }
    return stars;
  }

  // ---- drifting cloud puffs (seeded lobes, wrap horizontally) ----
  const CLOUD_SEED = 4242, CLOUD_N = 8;
  let clouds = null;
  function cloudField() {
    if (clouds) return clouds;
    clouds = [];
    for (let i = 0; i < CLOUD_N; i++) {
      const lobes = [];
      for (let j = 0; j < 4; j++) {
        lobes.push({
          dx: (j - 1.5) * 22 + (hash2(i, 20 + j, CLOUD_SEED) - 0.5) * 14,
          dy: (hash2(i, 30 + j, CLOUD_SEED) - 0.5) * 10,
          rx: 16 + hash2(i, 40 + j, CLOUD_SEED) * 16,
          ry: 8 + hash2(i, 50 + j, CLOUD_SEED) * 7
        });
      }
      clouds.push({
        u: hash2(i, 10, CLOUD_SEED),
        v: 0.06 + hash2(i, 11, CLOUD_SEED) * 0.30,
        s: 0.7 + hash2(i, 12, CLOUD_SEED) * 0.9,
        sp: 4 + hash2(i, 13, CLOUD_SEED) * 7,
        lobes
      });
    }
    return clouds;
  }

  // ---- biome parallax silhouette layers ----
  // Two depth layers scrolling at 0.15x / 0.35x of camera x with subtle
  // vertical parallax. Ridge points are cached per world-seed segment
  // (Float32Array of normalized heights), so per-frame cost is a lookup +
  // lerp per screen column. All randomness is hash2(worldSeed-derived) —
  // never Math.random.
  const BG_LAYERS = [
    { par: 0.15, vert: 0.18, base: 0.60, amp: 46, haze: 0.55 },
    { par: 0.35, vert: 0.30, base: 0.74, amp: 64, haze: 0.22 }
  ];
  const SEG_PX = 192;        // screen px covered by one cached segment
  const SEG_SAMPLES = 16;    // cached ridge points per segment (~12 px apart)
  const SEG_CACHE_MAX = 96;  // per-layer cap; oldest segments evicted

  // Per-biome backdrop profile: [farRGB, nearRGB] base colors and a shape id.
  // 'corruption' has no TC.Biomes detector yet — kept for when it lands.
  const BG_BIOMES = {
    forest:     { shape: 'canopy',   far: [92, 130, 96],  near: [56, 88, 64] },
    snow:       { shape: 'peaks',    far: [168, 190, 214], near: [118, 146, 178] },
    desert:     { shape: 'dunes',    far: [198, 166, 104], near: [158, 122, 68] },
    jungle:     { shape: 'twincanopy', far: [52, 118, 66], near: [28, 84, 42] },
    ocean:      { shape: 'lowdunes', far: [110, 150, 170], near: [70, 110, 140], water: true },
    corruption: { shape: 'spires',   far: [96, 70, 130],  near: [58, 40, 88] },
    cave:       { shape: 'stalactites', far: [38, 38, 50], near: [26, 26, 36], top: true },
    underworld: { shape: 'glow',     far: [60, 24, 18],   near: [40, 16, 12], glow: true }
  };

  function bgBiome() {
    try {
      const b = TC.Biomes && typeof TC.Biomes === 'object' ? TC.Biomes.current : null;
      return (b && BG_BIOMES[b]) ? b : 'forest';
    } catch (e) { return 'forest'; }
  }

  // Smooth value noise over the sample grid, seeded per world + layer + salt.
  // g is a global sample index; wl is wavelength in samples. Range [-1, 1].
  function segNoise(g, wl, salt, seed) {
    const x = g / wl;
    const i0 = Math.floor(x);
    const f = smooth(x - i0);
    return lerp(hash2(i0, salt, seed), hash2(i0 + 1, salt, seed), f) * 2 - 1;
  }

  // Normalized ridge height (0..1 above baseline) for one sample point.
  function shapeHeight(shape, k, si, seed) {
    const g = si * SEG_SAMPLES + k;          // global sample index
    const roll = segNoise(g, 10, 11, seed);  // shared gentle rolling base
    if (shape === 'peaks') {
      // jagged linear peaks: coarse control points, no smoothing beyond lerp
      const c = segNoise(g, 3, 23, seed);
      return clamp(0.55 + c * 0.45 + roll * 0.1, 0, 1);
    }
    if (shape === 'dunes') {
      let v = 0.22 + roll * 0.14;
      // occasional pyramid silhouette centered in its own segment
      if (hash2(si, 31, seed) > 0.72) {
        const half = 5.5;
        v += Math.max(0, 1 - Math.abs(k - SEG_SAMPLES / 2) / half) * 0.62;
      }
      return clamp(v, 0, 1);
    }
    if (shape === 'twincanopy') {
      const a = Math.cos(((g % 4) / 4) * Math.PI);
      const b = Math.cos((((g + 2) % 4) / 4) * Math.PI);
      return clamp(0.34 + a * a * 0.32 + b * b * 0.26 + roll * 0.12, 0, 1);
    }
    if (shape === 'lowdunes') return clamp(0.16 + roll * 0.12, 0, 1);
    if (shape === 'spires') {
      let v = 0.1 + roll * 0.05;
      for (let s = 0; s < 2; s++) {
        if (hash2(si, 41 + s, seed) > 0.45) {
          const p = 2 + hash2(si, 45 + s, seed) * (SEG_SAMPLES - 4);
          const wdt = 1.1 + hash2(si, 49 + s, seed) * 0.9;
          const hgt = 0.55 + hash2(si, 53 + s, seed) * 0.45;
          v += Math.max(0, 1 - Math.abs(k - p) / wdt) * hgt;
        }
      }
      return clamp(v, 0, 1);
    }
    if (shape === 'stalactites') {
      // fringe hangs from the top edge; length varies sharply
      const c = segNoise(g, 2, 61, seed);
      return clamp(0.35 + c * 0.65, 0, 1);
    }
    // 'canopy' (forest) and default: rounded oak-like canopy humps
    const bump = Math.cos(((g % 4) / 4) * Math.PI);
    return clamp(0.30 + bump * bump * 0.42 + roll * 0.18, 0, 1);
  }

  // Segment point cache: maps segment index -> Float32Array(SEG_SAMPLES+1).
  // Rebuilt when TC.worldSeed changes; capped so long treks can't grow it.
  const segCache = { seed: null, maps: null };
  function segPoints(li, si, shape, seed) {
    if (segCache.seed !== seed) {
      segCache.seed = seed;
      segCache.maps = [new Map(), new Map()];
    }
    const map = segCache.maps[li];
    let pts = map.get(si);
    if (!pts) {
      if (map.size >= SEG_CACHE_MAX) {
        const drop = map.keys().next().value; // oldest inserted
        map.delete(drop);
      }
      pts = new Float32Array(SEG_SAMPLES + 1);
      for (let k = 0; k <= SEG_SAMPLES; k++) pts[k] = shapeHeight(shape, k, si, seed);
      map.set(si, pts);
    }
    return pts;
  }

  function worldSeedInt() {
    const s = TC.worldSeed;
    return (s == null) ? 0 : (s | 0);
  }

  // One silhouette layer as a single filled path. mode 'ridge' fills down
  // from the ridge line; 'top' hangs a stalactite fringe from the top edge.
  function drawBgLayer(c, li, w, h, cam, pal, dl, surfPx, biomeKey) {
    const L = BG_LAYERS[li];
    const B = BG_BIOMES[biomeKey];
    const zoom = cam.zoom || 1;
    const camMidY = cam.y + (h / zoom) * 0.5;
    const anchor = surfPx == null ? 0 : surfPx - camMidY; // >0 above ground
    const seed = worldSeedInt();
    const col = li === 0 ? B.far : B.near;
    const haze = L.haze * (0.35 + 0.65 * dl); // haze breathes with daylight
    const cr = Math.round(lerp(col[0], pal[3], haze));
    const cg = Math.round(lerp(col[1], pal[4], haze));
    const cb = Math.round(lerp(col[2], pal[5], haze));
    const scrollX = cam.x * L.par;
    const step = 8;

    if (B.top) {
      // stalactite fringe along the top of the screen
      const maxLen = h * 0.16;
      c.fillStyle = 'rgb(' + cr + ',' + cg + ',' + cb + ')';
      c.beginPath();
      c.moveTo(-step, -8);
      for (let sx = -step; sx <= w + step; sx += step) {
        const P = sx + scrollX;
        const si = Math.floor(P / SEG_PX);
        const pts = segPoints(li, si, B.shape, seed);
        const t = (P - si * SEG_PX) / SEG_PX * SEG_SAMPLES;
        const k0 = Math.min(SEG_SAMPLES - 1, Math.max(0, Math.floor(t)));
        const len = lerp(pts[k0], pts[k0 + 1], t - k0) * maxLen;
        c.lineTo(sx, len);
      }
      c.lineTo(w + step, -8);
      c.closePath();
      c.fill();
      return;
    }

    if (B.glow) {
      // underworld: dark floor line plus a warm glow band above it
      const gy = h * L.base + anchor * L.vert;
      const g = c.createLinearGradient(0, gy - h * 0.20, 0, gy);
      g.addColorStop(0, 'rgba(255,96,32,0)');
      g.addColorStop(1, 'rgba(255,110,36,' + (0.16 + 0.14 * (1 - dl)).toFixed(3) + ')');
      c.fillStyle = g;
      c.fillRect(0, gy - h * 0.20, w, h * 0.20);
      c.fillStyle = 'rgb(' + cr + ',' + cg + ',' + cb + ')';
      c.fillRect(0, gy, w, h - gy + 8);
      return;
    }

    const baseY = h * L.base + anchor * L.vert;
    const amp = L.amp;
    c.fillStyle = 'rgb(' + cr + ',' + cg + ',' + cb + ')';
    c.beginPath();
    c.moveTo(-step, h + 8);
    for (let sx = -step; sx <= w + step; sx += step) {
      const P = sx + scrollX;
      const si = Math.floor(P / SEG_PX);
      const pts = segPoints(li, si, B.shape, seed);
      const t = (P - si * SEG_PX) / SEG_PX * SEG_SAMPLES;
      const k0 = Math.min(SEG_SAMPLES - 1, Math.max(0, Math.floor(t)));
      const hh = lerp(pts[k0], pts[k0 + 1], t - k0) * amp;
      c.lineTo(sx, baseY - hh);
    }
    c.lineTo(w + step, h + 8);
    c.closePath();
    c.fill();

    if (B.water) {
      // ocean: translucent water line below the low dune baseline
      c.fillStyle = 'rgba(38,84,140,' + (0.16 + 0.10 * dl).toFixed(3) + ')';
      c.fillRect(0, baseY - amp * 0.1, w, h - baseY + amp * 0.1 + 8);
    }
  }

  // camera-center column of the surface, in world px (null without a world)
  function surfaceUnderCam(cam, w, h) {
    const world = TC.world;
    if (!world || !world.surfaceY) return null;
    const zoom = cam.zoom || 1;
    const col = clamp(Math.floor((cam.x + (w / zoom) * 0.5) / TS), 0, world.width - 1);
    return world.surfaceY[col] * TS;
  }

  function drawOrb(c, w, h, u, isSun, mph) {
    const horizon = h * 0.74;
    const x = w * (0.08 + 0.84 * u);
    const y = horizon - Math.sin(Math.PI * u) * (horizon - h * 0.10);
    const a = clamp(Math.sin(Math.PI * u) * 4, 0, 1); // fade near the horizons
    if (a <= 0.01) return;
    c.save();
    c.globalAlpha = a;
    if (isSun) {
      const g = c.createRadialGradient(x, y, 4, x, y, 90);
      g.addColorStop(0, 'rgba(255,236,180,0.9)');
      g.addColorStop(0.25, 'rgba(255,204,120,0.55)');
      g.addColorStop(1, 'rgba(255,180,90,0)');
      c.fillStyle = g;
      c.fillRect(x - 90, y - 90, 180, 180);
      c.fillStyle = '#ffe9b0';
      c.beginPath(); c.arc(x, y, 17, 0, TAU); c.fill();
      c.fillStyle = '#fff6dc';
      c.beginPath(); c.arc(x, y, 12, 0, TAU); c.fill();
    } else {
      const g = c.createRadialGradient(x, y, 2, x, y, 60);
      g.addColorStop(0, 'rgba(214,224,255,0.5)');
      g.addColorStop(1, 'rgba(214,224,255,0)');
      c.fillStyle = g;
      c.fillRect(x - 60, y - 60, 120, 120);
      c.fillStyle = '#dfe6f5';
      c.beginPath(); c.arc(x, y, 13, 0, TAU); c.fill();
      c.fillStyle = 'rgba(160,172,200,0.7)'; // craters
      c.beginPath(); c.arc(x - 4, y - 3, 2.6, 0, TAU); c.fill();
      c.beginPath(); c.arc(x + 5, y + 4, 2.0, 0, TAU); c.fill();
      c.beginPath(); c.arc(x + 2, y - 6, 1.5, 0, TAU); c.fill();
      // phase shading: shadow disc slides across per day-count phase
      // mph 0 full (shadow off-disc) -> 2 new (fully covered); direction
      // flips for waxing so halves read as waning vs waxing.
      const cover = [0, 0.5, 1, 0.5][mph] || 0;
      if (cover > 0.001) {
        const R = 13;
        const dir = mph === 3 ? -1 : 1;
        c.save(); // shade clipped to the disc
        c.beginPath(); c.arc(x, y, R, 0, TAU); c.clip();
        c.fillStyle = 'rgba(108,122,158,0.45)';
        c.beginPath(); c.arc(x + dir * 2 * R * cover, y - 2, R - 1, 0, TAU); c.fill();
        c.restore();
        if (cover >= 0.999) { // new moon: faint rim so it stays visible
          c.strokeStyle = 'rgba(170,182,210,0.30)';
          c.lineWidth = 1;
          c.beginPath(); c.arc(x, y, R, 0, TAU); c.stroke();
        }
      }
    }
    c.restore();
  }

  function drawClouds(c, w, h, cam, timeNow, dl) {
    const cs = cloudField();
    const span = w + 320;
    c.fillStyle = 'rgba(255,255,255,' + (0.30 + 0.42 * dl).toFixed(3) + ')';
    for (let i = 0; i < cs.length; i++) {
      const cl = cs[i];
      const x = mod(cl.u * span + timeNow * cl.sp - cam.x * 0.15, span) - 160;
      const y = cl.v * h - cam.y * 0.05;
      c.beginPath();
      for (let j = 0; j < cl.lobes.length; j++) {
        const lb = cl.lobes[j];
        const lx = x + lb.dx * cl.s, ly = y + lb.dy * cl.s;
        c.moveTo(lx + lb.rx * cl.s, ly);
        c.ellipse(lx, ly, lb.rx * cl.s, lb.ry * cl.s, 0, 0, TAU);
      }
      c.fill();
    }
  }

  function drawStars(c, w, h, timeNow, sa) {
    const st = starField();
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      const tw = 0.65 + 0.35 * Math.sin(timeNow * s.sp + s.ph);
      c.globalAlpha = sa * tw;
      const r = s.r * 2;
      c.fillRect(s.x * w, s.y * h, r, r);
    }
    c.globalAlpha = 1;
  }

  // ---- public API ----
  TC.Sky = {
    time: DAY * 0.15,              // seconds; persisted by save.js via main.js

    update(dt) { this.time += dt; },

    reset() { this.time = DAY * 0.15; },  // early morning

    phase() { return mod(this.time, CYCLE); },

    isDay() { return this.phase() < DAY; },

    // 4-phase moon strip indexed by day count: 0 full, 1 waning half,
    // 2 new, 3 waxing half. Deterministic from persisted time.
    moonPhase() { return mod(Math.floor(this.time / CYCLE), 4); },

    daylight() {
      const p = this.phase();
      const hf = RAMP * 0.5;
      // dawn ramp centered on p=0, straddling the cycle seam
      if (p <= hf || p >= CYCLE - hf) {
        const dp = p > hf ? p - CYCLE : p;   // map to [-hf, hf]
        return smooth((dp + hf) / RAMP);
      }
      // dusk ramp centered on p=DAY
      if (p >= DAY - hf && p <= DAY + hf) {
        return 1 - smooth((p - (DAY - hf)) / RAMP);
      }
      return p < DAY ? 1 : 0;                // day / night plateaus
    },

    draw(c, cam, w, h) {
      const p = this.phase();
      const dl = this.daylight();
      const pal = paletteAt(p);

      // vertical gradient
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgb(' + pal[0] + ',' + pal[1] + ',' + pal[2] + ')');
      g.addColorStop(1, 'rgb(' + pal[3] + ',' + pal[4] + ',' + pal[5] + ')');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);

      const surfPx = surfaceUnderCam(cam, w, h);
      const biomeKey = bgBiome();

      // far silhouette depth sits behind stars and clouds
      drawBgLayer(c, 0, w, h, cam, pal, dl, surfPx, biomeKey);

      // stars fade in as daylight drops
      const sa = clamp(((1 - dl) - 0.5) / 0.35, 0, 1);
      if (sa > 0.01) drawStars(c, w, h, this.time, sa);

      // sun by day, moon by night, on matching arcs
      if (p < DAY) drawOrb(c, w, h, p / DAY, true, this.moonPhase());
      else drawOrb(c, w, h, (p - DAY) / NIGHT, false, this.moonPhase());

      // near silhouette depth: still behind clouds, occludes stars/orb
      drawBgLayer(c, 1, w, h, cam, pal, dl, surfPx, biomeKey);

      drawClouds(c, w, h, cam, this.time, dl);

      // sink the whole backdrop toward cave black as the camera descends
      // below the surface, so underground feels enclosed
      if (surfPx != null) {
        const zoom = cam.zoom || 1;
        const camMidY = cam.y + (h / zoom) * 0.5;
        const dfac = clamp((camMidY - surfPx - 24) / 360, 0, 1);
        if (dfac > 0.003) {
          c.fillStyle = 'rgba(10,9,13,' + (dfac * 0.97).toFixed(3) + ')';
          c.fillRect(0, 0, w, h);
        }
      }
    }
  };
})();

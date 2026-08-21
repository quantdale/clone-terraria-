/* sky.js — day/night cycle: keyframed sky gradients, sun/moon arcs, stars,
   drifting clouds, parallax hill silhouettes, underground fade. Screen space. */
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

  function makeNoise(seed) {
    const U = TC.Utils;
    if (U && typeof U.Noise2D === 'function') return new U.Noise2D(seed);
    // minimal seeded value-noise fallback, output range [-1, 1]
    const val = (ix, iy) => hash2(ix, iy, seed) * 2 - 1;
    const noise2 = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      return lerp(lerp(val(ix, iy), val(ix + 1, iy), ux),
                  lerp(val(ix, iy + 1), val(ix + 1, iy + 1), ux), uy);
    };
    return {
      noise2,
      fbm2(x, y, oct, lac, gain) {
        let a = 1, f = 1, sum = 0, norm = 0;
        for (let i = 0; i < (oct || 1); i++) {
          sum += noise2(x * f, y * f) * a;
          norm += a;
          a *= gain == null ? 0.5 : gain;
          f *= lac == null ? 2 : lac;
        }
        return norm ? sum / norm : 0;
      }
    };
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

  // ---- silhouette hill layers (fbm ridges) ----
  const HILLS = [
    { par: 0.3, vert: 0.35, base: 0.62, amp: 46, freq: 0.0016, seed: 1013, col: [56, 88, 80],  haze: 0.50 },
    { par: 0.5, vert: 0.55, base: 0.74, amp: 62, freq: 0.0023, seed: 2029, col: [36, 60, 48],  haze: 0.18 }
  ];
  const hillNoise = {};
  function noiseFor(seed) {
    if (!hillNoise[seed]) hillNoise[seed] = makeNoise(seed);
    return hillNoise[seed];
  }

  // camera-center column of the surface, in world px (null without a world)
  function surfaceUnderCam(cam, w, h) {
    const world = TC.world;
    if (!world || !world.surfaceY) return null;
    const zoom = cam.zoom || 1;
    const col = clamp(Math.floor((cam.x + (w / zoom) * 0.5) / TS), 0, world.width - 1);
    return world.surfaceY[col] * TS;
  }

  function drawHills(c, w, h, cam, pal, dl, surfPx) {
    const zoom = cam.zoom || 1;
    const camMidY = cam.y + (h / zoom) * 0.5;
    const anchor = surfPx == null ? 0 : surfPx - camMidY; // >0 above ground, <0 below
    for (let li = 0; li < HILLS.length; li++) {
      const L = HILLS[li];
      const n = noiseFor(L.seed);
      const baseY = h * L.base + anchor * L.vert;
      const haze = L.haze * (0.35 + 0.65 * dl); // atmospheric haze breathes with daylight
      const cr = Math.round(lerp(L.col[0], pal[3], haze));
      const cg = Math.round(lerp(L.col[1], pal[4], haze));
      const cb = Math.round(lerp(L.col[2], pal[5], haze));
      c.fillStyle = 'rgb(' + cr + ',' + cg + ',' + cb + ')';
      c.beginPath();
      c.moveTo(-8, h + 8);
      for (let sx = -8; sx <= w + 8; sx += 8) {
        const nx = (sx + cam.x * L.par) * L.freq;
        c.lineTo(sx, baseY + n.fbm2(nx, 0, 3, 2, 0.5) * L.amp);
      }
      c.lineTo(w + 8, h + 8);
      c.closePath();
      c.fill();
    }
  }

  function drawOrb(c, w, h, u, isSun) {
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
      c.save(); // crescent shade, clipped to the disc
      c.beginPath(); c.arc(x, y, 13, 0, TAU); c.clip();
      c.fillStyle = 'rgba(108,122,158,0.45)';
      c.beginPath(); c.arc(x + 7, y - 4, 12, 0, TAU); c.fill();
      c.restore();
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

      // stars fade in as daylight drops
      const sa = clamp(((1 - dl) - 0.5) / 0.35, 0, 1);
      if (sa > 0.01) drawStars(c, w, h, this.time, sa);

      // sun by day, moon by night, on matching arcs
      if (p < DAY) drawOrb(c, w, h, p / DAY, true);
      else drawOrb(c, w, h, (p - DAY) / NIGHT, false);

      drawClouds(c, w, h, cam, this.time, dl);

      const surfPx = surfaceUnderCam(cam, w, h);
      drawHills(c, w, h, cam, pal, dl, surfPx);

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

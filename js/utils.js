/* utils.js — seeded RNG, math helpers, Perlin-style noise. Pure module, no DOM. */
'use strict';
(function () {
  const TC = (window.TC = window.TC || {});

  // ---- seeded RNG ----

  // mulberry32: fast 32-bit PRNG; returns rng() => [0,1), reproducible from seed
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Deterministic 2D integer hash -> [0,1); same (x,y,s) always yields same value
  function hash2(x, y, s) {
    let h = (Math.imul(x | 0, 374761393) +
             Math.imul(y | 0, 668265263) +
             Math.imul(s | 0, 1440662683)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // ---- rng-driven helpers (pass an rng from mulberry32) ----

  function randRange(rng, a, b) { return a + rng() * (b - a); }
  function randInt(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); } // inclusive
  function choose(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  // ---- scalar math ----

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // ---- Perlin-style gradient noise ----

  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  function grad(h, x, y) {
    switch (h & 7) {
      case 0: return  x + y;
      case 1: return  x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return  x;
      case 5: return -x;
      case 6: return  y;
      default: return -y;
    }
  }

  class Noise2D {
    constructor(seed) {
      const rng = mulberry32(seed);
      const p = new Uint8Array(256);
      for (let i = 0; i < 256; i++) p[i] = i;
      for (let i = 255; i > 0; i--) { // Fisher-Yates shuffle from seeded rng
        const j = Math.floor(rng() * (i + 1));
        const t = p[i]; p[i] = p[j]; p[j] = t;
      }
      this.perm = new Uint8Array(512);
      for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    }

    // Smooth 2D gradient noise, roughly [-1,1]
    noise2(x, y) {
      const fx = Math.floor(x), fy = Math.floor(y);
      const X = fx & 255, Y = fy & 255;
      x -= fx; y -= fy;
      const u = fade(x), v = fade(y);
      const p = this.perm;
      const aa = p[p[X] + Y],       ba = p[p[X + 1] + Y];
      const ab = p[p[X] + Y + 1],   bb = p[p[X + 1] + Y + 1];
      return lerp(
        lerp(grad(aa, x, y),     grad(ba, x - 1, y),     u),
        lerp(grad(ab, x, y - 1), grad(bb, x - 1, y - 1), u),
        v
      );
    }

    // Fractal Brownian motion: summed octaves, normalized back to roughly [-1,1]
    fbm2(x, y, octaves, lacunarity, gain) {
      let sum = 0, amp = 1, freq = 1, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * this.noise2(x * freq, y * freq);
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      return norm > 0 ? sum / norm : 0;
    }
  }

  TC.Utils = { mulberry32, hash2, randRange, randInt, choose, clamp, lerp, aabb, Noise2D };
})();

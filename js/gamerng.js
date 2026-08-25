/* gamerng.js — TC.GameRng: THE deterministic gameplay-runtime RNG authority
   (W23 / deterministic-authority campaign).

   WHY: enemy AI, spawning, loot rolls, crit/variance and drop physics all
   used bare Math.random, which made authoritative replay (same seed + same
   command/input trace → identical state) impossible outside worldgen and
   excluded enemy AI from session digests. This module puts every
   gameplay-affecting runtime decision under named seeded streams:

     'ai'      enemy/boss behavior randomness (archetype decisions)
     'spawn'   spawn director placement/zoning/event rolls
     'loot'    drop tables, coins, blood shards, entity loot
     'combat'  damage variance, crits, thrown-gear scatter
     'misc'    remaining authoritative physics (drop scatter, NPC wander)

   CONTRACT:
     - GameRng.reset(seed) re-derives every stream deterministically from the
       given 32-bit seed (mulberry32 states derived via FNV mix of name);
     - WorldLoaded resets from TC.worldSeed automatically (event-bus
       convention shared with Biomes/Fishing/Commands);
     - state()/restore()/digest() expose exact stream state for replay tests;
     - presentation-only randomness (particles, blink timers, trails) and
       worldgen (own seeded passes) intentionally stay OUT of this service;
     - joined clients never run authoritative simulation, so they never draw
       from these streams — server truth arrives replicated.

   Headless-safe: zero DOM/Canvas dependency. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const STREAMS = Object.freeze(['ai', 'spawn', 'loot', 'combat', 'misc']);

  const overrides = new Map();   // name -> fn(): fixed float (test seam only)

  let baseSeed = 0 >>> 0;
  const handles = new Map();   // name -> stream handle

  // mulberry32 step over an explicit mutable state cell so snapshots work.
  function step(ref) {
    let a = (ref.a + 0x6D2B79F5) | 0;
    ref.a = a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // FNV-1a-style mix of the stream name into the base seed.
  function deriveSeed(base, name) {
    let h = base >>> 0;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
      h = (h + 0x6D2B79F5) | 0;
    }
    h ^= h >>> 16;
    return h >>> 0;
  }

  function makeStream(name) {
    const ref = { a: deriveSeed(baseSeed, name) };
    const draws = { n: 0 };
    function float() {
      // Test/verification seam: a pinned stream returns fixed values without
      // consuming state (used by suites that need exact outcome math).
      const ov = overrides.get(name);
      if (ov) return ov();
      draws.n++;
      return step(ref);
    }
    return {
      name: name,
      float: float,
      range: function (a, b) { return a + float() * (b - a); },
      int: function (a, b) { return a + Math.floor(float() * (b - a + 1)); },
      chance: function (p) { return float() < p; },
      pick: function (arr) { return arr[Math.floor(float() * arr.length)]; },
      sign: function () { return float() < 0.5 ? -1 : 1; },
      state: function () { return { a: ref.a >>> 0, draws: draws.n }; },
      setState: function (s) {
        if (!s || typeof s.a !== 'number') return;
        ref.a = s.a >>> 0;
        draws.n = (typeof s.draws === 'number') ? (s.draws | 0) : 0;
      }
    };
  }

  function reset(seed) {
    baseSeed = (seed == null || !isFinite(seed)) ? 0 : (seed | 0) >>> 0;
    handles.clear();
    overrides.clear();
    for (const name of STREAMS) handles.set(name, makeStream(name));
  }

  // Pin one/all streams to a fixed value source (deterministic tests).
  function override(name, fn) {
    if (typeof fn !== 'function') { overrides.delete(name); return; }
    if (name == null) { for (const n of STREAMS) overrides.set(n, fn); return; }
    overrides.set(stream(name).name, fn);
  }
  function clearOverrides() { overrides.clear(); }

  function stream(name) {
    return handles.get(name) || handles.get('misc');
  }

  function state() {
    const out = { seed: baseSeed, streams: {} };
    for (const name of STREAMS) out.streams[name] = stream(name).state();
    return out;
  }

  function restore(snap) {
    if (!snap || !snap.streams) return;
    baseSeed = (snap.seed | 0) >>> 0;
    handles.clear();
    for (const name of STREAMS) {
      const h = makeStream(name);
      h.setState(snap.streams[name]);
      handles.set(name, h);
    }
  }

  // FNV-1a digest over seed + per-stream state/draw counters in canonical
  // order — two realms that drew identically produce identical digests.
  function digest() {
    let h = 0x811c9dc5;
    function mixU32(v) {
      v = v >>> 0;
      for (let i = 0; i < 4; i++) {
        h ^= (v >>> (i * 8)) & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    mixU32(baseSeed);
    for (const name of STREAMS) {
      for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i) & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      const s = stream(name).state();
      mixU32(s.a);
      mixU32(s.draws);
    }
    return h >>> 0;
  }

  reset(0);

  TC.GameRng = {
    STREAMS: STREAMS,
    reset: reset,
    stream: stream,
    state: state,
    restore: restore,
    digest: digest,
    override: override,
    clearOverrides: clearOverrides,
    seedOf: function () { return baseSeed; }
  };

  // Event-bus reset convention: every world transition reseeds from the new
  // world's seed (guarded — events may be absent in stripped embeds).
  if (TC.Events && typeof TC.Events.on === 'function' && TC.Events.EVENT &&
      TC.Events.EVENT.WorldLoaded) {
    try {
      TC.Events.on(TC.Events.EVENT.WorldLoaded, function () {
        reset((typeof TC.worldSeed === 'number') ? TC.worldSeed : 0);
      });
    } catch (e) {}
  }
})();

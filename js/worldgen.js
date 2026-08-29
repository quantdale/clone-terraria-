/* worldgen.js — deterministic procedural world generation. Owns TC.WorldGen.
   Expands the classic pipeline with edge oceans (beach slope + water volume),
   overhauled deserts (cactus scrub + buried pyramids), a corruption/crimson
   evil strip (ebonstone/shadewood), a surface dungeon, and furnished hell
   temples. Its extension tiles/walls/items now live in constants.js (promoted
   from the former load-time extendTables append, ids and order unchanged), so
   this module no longer mutates shared tables at script-load time.
   Wave 4 (v3) deepening: 'deep-caves' pass (large multi-worm caverns, layer
   shafts, winding tunnels, underground water lakes, lava caverns at the
   underworld rim), 'micro-biomes' pass (crystal cavern, mushroom grotto,
   granite chamber, marble chamber, moss cave), silver + crystal ore tiers,
   surface cabins / underground shrines / desert ruins, and a repair-first
   validation pass. */
'use strict';
(function () {
  const TC = window.TC;

  // Ordered generation passes; generate() runs each against a shared context.
  var PASSES = ['terrain','surface-biomes','caves','deep-caves','ores','micro-biomes',
    'structures','decor','validation'];

  // ------------------------------------------------------------------
  // The extension tables this module once appended at load time
  // (CACTUS..SANDSTONE_BRICK tiles, SAND/EBON/DUNGEON/HELL walls and their
  // items) were promoted verbatim into constants.js: same keys, same numeric
  // ids, same order. No module may mutate shared content tables at script
  // load — new content belongs in constants.js or an explicit Registry.define.
  // ------------------------------------------------------------------

  // Expansion tuning (candidates for CONST.GEN; kept here to avoid edits
  // to lead-owned constants.js). Seed-independent, shared by all passes.
  const XG = {
    ocean:  { width: 110, beach: 26, seaLevelOff: 6, deepMin: 10, deepVar: 12, floodDepth: 48 },
    cactus: { spacing: 4, chance: 0.6, hMin: 2, hVar: 3 },
    pyramid:{ chance: 0.8, baseMin: 20, baseVar: 12 },
    evil:   { widthMin: 70, widthVar: 60, chasms: 3, chasmRad: 2.6, veins: 80, veinSize: 5 },
    dungeon:{ roomW: 15, roomH: 9, rooms: 4 },
    hell:   { temples: 3, tW: 23, tH: 13, lavaPoolsDeep: 14 },
    // Wave 4 subterranean budgets (sized for a 1200x400 world). depthMin
    // keeps all deep carving clear of the oceans and root-zone caves.
    deep:   {
      caverns: 9, wormMin: 3, wormVar: 3, len: 50, lenVar: 45,
      rad: 6.5, radVar: 6, depthMin: 150,
      shafts: 14, shaftLenMin: 55, shaftLenVar: 90, shaftRad: 1.7,
      tunnels: 16, tunnelSteps: 85, tunnelStepsVar: 70, tunnelRad: 2.2,
      lakes: 8, lakeMaxTiles: 520, lakeYMin: 235,
      lavaRooms: 5, lavaRoomRad: 8, lavaMaxTiles: 420
    },
    // micro-biome chamber sizing (12-26 tiles wide per spec)
    micro:  { wMin: 12, wVar: 15, hMin: 8, hVar: 4, yMin: 210 },
    // ore tiers added on top of lead-owned GEN.ores (same config shape)
    ores:   {
      silver:  { veins: 130, sizeMin: 3, sizeVar: 4, minYAbs: 200, maxYAbs: 330 },
      crystal: { veins: 26, sizeMin: 2, sizeVar: 3, minYAbs: 300, maxYAbs: 351 }
    }
  };

  // Deterministic per-pass RNG stream seed keyed by world seed + pass name.
  const passSeed = (seed, name) =>
    (TC.Utils.hash2(seed | 0, ((name.length * 2654435761) ^ (seed | 0)) | 0, 0) * 4294967296) >>> 0;

  const PASS_FNS = {
    'terrain': passTerrain,
    'surface-biomes': passSurfaceBiomes,
    'caves': passCaves,
    'deep-caves': passDeepCaves,
    'ores': passOres,
    'micro-biomes': passMicroBiomes,
    'structures': passStructures,
    'decor': passDecor,
    'validation': passValidation
  };

  TC.WorldGen = {

    // Fully deterministic from seed: seeded RNG + seeded noise only, no Math.random.
    // Allocates the world buffers, builds the shared pass context
    // c = {seed,width,height,tiles,walls,surfaceY,hSurf,stoneTop,wallJobs,rng},
    // runs every PASSES entry in order via a name-keyed mulberry32 stream,
    // and times each pass into gen.timings (ms).
    generate(seed) {
      const U = TC.Utils;
      if (!U || typeof U.mulberry32 !== 'function' || typeof U.Noise2D !== 'function' || !TC.WALL) {
        throw new Error('WorldGen.generate requires TC.Utils (mulberry32, Noise2D) and TC.WALL');
      }
      const W = TC.CONST.WORLD_W, H = TC.CONST.WORLD_H;
      const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? () => performance.now() : () => Date.now();
      const timings = {};
      const c = {
        seed: seed | 0,
        width: W,
        height: H,
        tiles: new Uint8Array(W * H),
        walls: new Uint8Array(W * H),
        surfaceY: new Int16Array(W),
        hSurf: new Int16Array(W),     // heightmap: row of the ground tile
        stoneTop: new Int16Array(W),  // first stone row per column
        wallJobs: [],                 // rects wanting a background wall (stamped by validation)
        rng: null                     // replaced per pass with a name-keyed stream
      };
      for (const name of PASSES) {
        c.rng = U.mulberry32(passSeed(c.seed, name));
        const t0 = now();
        PASS_FNS[name](c);
        timings[name] = now() - t0;
      }
      return { width: W, height: H, tiles: c.tiles, walls: c.walls, surfaceY: c.surfaceY,
        spawnX: c.spawnX, spawnY: c.spawnY, timings: timings, stats: c.stats };
    },

    // Run one named generation pass against a context shaped like c above.
    runPass(name, c) {
      const fn = PASS_FNS[name];
      if (!fn) throw new Error('Unknown generation pass: ' + name);
      return fn(c);
    },

    // v3 — wave-4 deepening: the new deep-caves/micro-biomes passes, silver +
    // crystal ore tiers, extra structures and the repair-first validation all
    // change generated bytes, so pristine baselines regenerate under v3.
    // Old saves stay loadable across the bump because saves persist absolute
    // tile/wall diffs rather than replaying the seed (see save.js).
    GENERATION_VERSION: 3,
    CONFIG: { deepCaves: true, microBiomes: true, richOres: true }
  };

  // ---- Pass: terrain — heightmap (+ edge oceans) and soil columns ----
  function passTerrain(c) {
    const U = TC.Utils, G = TC.CONST.GEN, T = TC.TILE;
    const W = c.width, H = c.height;
    const tiles = c.tiles, hSurf = c.hSurf, stoneTop = c.stoneTop;
    const rng = c.rng;
    const idx = (x, y) => y * W + x;
    const ri = (n) => (rng() * n) | 0;  // int in [0, n)
    const surfN = new U.Noise2D(c.seed);
    const oceanN = new U.Noise2D((c.seed ^ 0x1F123BB5) | 0);

      // ---- 1. surface heightmap (+ ocean profiles at both edges) ----
      for (let x = 0; x < W; x++) {
        const n = Math.max(-1, Math.min(1, surfN.fbm2(x * G.surfaceFreq, 0.5, 4, 2, 0.5)));
        hSurf[x] = Math.max(6, Math.min(H >> 1, Math.round(G.baseSurface + n * G.surfaceAmplitude)));
      }
      // Oceans: sea level, sandy seabed sloping down toward each edge, then a
      // beach shelf blending back into the inland terrain.
      const SEA = G.baseSurface + XG.ocean.seaLevelOff;
      const OCW = Math.min(XG.ocean.width, W >> 3);
      const BCH = XG.ocean.beach;
      const inlandLo = OCW + BCH + 8;      // biome/desert placement bounds
      const inlandHi = W - inlandLo;
      const natSurf = new Int16Array(hSurf); // pristine heightmap for blending
      const oceanProfile = (x) => {          // seabed row for an edge column
        const t = (x < OCW ? x : W - 1 - x) / OCW;   // 0 at the map edge -> 1 inland
        const wobble = oceanN.fbm2(x * 0.05, 3.7, 2, 2, 0.5) * 2.5 * (1 - t);
        const deep = XG.ocean.deepMin + ri(XG.ocean.deepVar);
        return Math.max(SEA + 1, Math.round(SEA + U.lerp(deep, 1, t * t) + wobble));
      };
      for (let x = 0; x < OCW; x++) hSurf[x] = oceanProfile(x);
      for (let x = W - OCW; x < W; x++) hSurf[x] = oceanProfile(x);
      for (let x = OCW; x < OCW + BCH; x++) {          // left beach shelf
        const b = (x - OCW) / BCH, e = b * b * (3 - 2 * b);
        hSurf[x] = Math.round(U.lerp(SEA - 1, Math.min(natSurf[x], SEA - 1), e));
      }
      for (let x = W - OCW - BCH; x < W - OCW; x++) {  // right beach shelf
        const b = (W - OCW - x) / BCH, e = b * b * (3 - 2 * b);
        hSurf[x] = Math.round(U.lerp(SEA - 1, Math.min(natSurf[x], SEA - 1), e));
      }

      // ---- 2. soil columns: grass / dirt / stone ----
      for (let x = 0; x < W; x++) {
        const s = hSurf[x];
        const dd = G.dirtDepthMin + ri(G.dirtDepthVar);
        stoneTop[x] = s + dd;
        tiles[idx(x, s)] = T.GRASS;
        for (let y = s + 1; y < stoneTop[x]; y++) tiles[idx(x, y)] = T.DIRT;
        for (let y = stoneTop[x]; y < H; y++) tiles[idx(x, y)] = T.STONE;
      }
    }

    // ---- Pass: surface biomes — deserts, snow/jungle bands, evil strip ----
    function passSurfaceBiomes(c) {
      const G = TC.CONST.GEN, T = TC.TILE;
      const W = c.width, H = c.height;
      const tiles = c.tiles, hSurf = c.hSurf, stoneTop = c.stoneTop;
      const rng = c.rng;
      const idx = (x, y) => y * W + x;
      const ri = (n) => (rng() * n) | 0;  // int in [0, n)
      const BR = G.bedrockRows;
      const Y_TOP = 1, Y_BOT = H - BR - 1;   // rows open to carving
      // Inland placement bounds (rng-free; matches terrain's ocean/beach widths).
      const inlandLo = Math.min(XG.ocean.width, W >> 3) + XG.ocean.beach + 8;
      const inlandHi = W - inlandLo;
      const deserts = c.deserts = [];        // reused by structures (pyramids, dungeon site)

      // ---- 3. deserts: sand down to stone ----
      for (let d = 0, guard = 0; d < G.desertCount && guard < 200; guard++) {
        const wd = G.desertWidthMin + ri(G.desertWidthVar);
        const x0 = inlandLo + ri(Math.max(1, inlandHi - inlandLo - wd));
        let hit = false;
        for (const dr of deserts) {
          if (x0 < dr[1] + 8 && x0 + wd > dr[0] - 8) { hit = true; break; }
        }
        if (hit) continue;
        deserts.push([x0, x0 + wd]);
        d++;
      }
      for (const dr of deserts) {
        for (let x = dr[0]; x < dr[1] && x < W; x++) {
          for (let y = hSurf[x]; y < stoneTop[x]; y++) {
            const t = tiles[idx(x, y)];
            if (t === T.GRASS || t === T.DIRT) tiles[idx(x, y)] = T.SAND;
          }
        }
      }

      // ---- 3b. snow & jungle biome ranges (avoid deserts, each other, spawn) ----
      const biomes = c.biomes = [];          // reused by structures (dungeon site)
      const biomeKinds = [
        { count: G.biomes.snowCount, wMin: G.biomes.snowWidthMin, wVar: G.biomes.snowWidthVar, tile: T.SNOW },
        { count: G.biomes.jungleCount, wMin: G.biomes.jungleWidthMin, wVar: G.biomes.jungleWidthVar, tile: T.JGRASS }
      ];
      for (const bk of biomeKinds) {
        for (let b = 0, guard = 0; b < bk.count && guard < 200; guard++) {
          const wd = bk.wMin + ri(bk.wVar);
          const x0 = inlandLo + ri(Math.max(1, inlandHi - inlandLo - wd));
          const x1 = x0 + wd;
          let hit = x0 <= (W >> 1) + 30 && x1 >= (W >> 1) - 30; // keep spawn column clear
          for (let i = 0; i < deserts.length && !hit; i++) {
            if (x0 < deserts[i][1] + 8 && x1 > deserts[i][0] - 8) hit = true;
          }
          for (let i = 0; i < biomes.length && !hit; i++) {
            if (x0 < biomes[i][1] + 8 && x1 > biomes[i][0] - 8) hit = true;
          }
          if (hit) continue;
          biomes.push([x0, x1, bk.tile]);
          b++;
        }
      }
      for (const bm of biomes) {
        for (let x = Math.max(0, bm[0]); x < Math.min(W, bm[1]); x++) {
          const s = hSurf[x];
          if (tiles[idx(x, s)] !== T.GRASS) continue; // desert sand stays sand
          tiles[idx(x, s)] = bm[2];
          if (bm[2] === T.SNOW) {
            const deep = 3 + ri(2); // pack 3-4 dirt rows under the snow cap
            for (let y = s + 1; y < Math.min(stoneTop[x], s + 1 + deep); y++) {
              if (tiles[idx(x, y)] === T.DIRT) tiles[idx(x, y)] = T.SNOW;
            }
          }
        }
      }

      // circle carver shared by tunnels and evil chasms
      const carveCircle = (cx, cy, r) => {
        const x0 = Math.max(1, Math.floor(cx - r)), x1 = Math.min(W - 2, Math.ceil(cx + r));
        const y0 = Math.max(Y_TOP, Math.floor(cy - r)), y1 = Math.min(Y_BOT, Math.ceil(cy + r));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy <= r * r && tiles[idx(x, y)] !== T.BEDROCK) {
              tiles[idx(x, y)] = T.AIR;
            }
          }
        }
      };

      // ---- 3c. evil strip: corruption or crimson, full depth ----
      // Variant picked once per seed; both share the corrupt-grass cap.
      const crimson = rng() < 0.5;
      const eStone = crimson ? T.CRIMSTONE : T.EBONSTONE;
      let evilRange = null;
      for (let guard = 0; guard < 200 && !evilRange; guard++) {
        const wd = XG.evil.widthMin + ri(XG.evil.widthVar);
        const x0 = inlandLo + ri(Math.max(1, inlandHi - inlandLo - wd));
        const x1 = x0 + wd;
        if (x0 <= (W >> 1) + 40 && x1 >= (W >> 1) - 40) continue; // keep spawn clear
        let hit = false;
        for (const dr of deserts) {
          if (x0 < dr[1] + 10 && x1 > dr[0] - 10) { hit = true; break; }
        }
        for (const bm of biomes) {
          if (!hit && x0 < bm[1] + 10 && x1 > bm[0] - 10) { hit = true; break; }
        }
        if (!hit) evilRange = [x0, x1];
      }
      if (evilRange) {
        for (let x = evilRange[0]; x < evilRange[1] && x < W; x++) {
          for (let y = hSurf[x]; y <= Y_BOT; y++) {
            const t = tiles[idx(x, y)];
            if (t === T.STONE) tiles[idx(x, y)] = eStone;
            else if (t === T.GRASS) tiles[idx(x, y)] = T.EBONGRASS;
          }
        }
        // shadewood veins threading the tainted stone
        for (let v = 0; v < XG.evil.veins; v++) {
          const x = evilRange[0] + ri(evilRange[1] - evilRange[0]);
          let vx = x, vy = stoneTop[x] + ri(Math.max(1, Y_BOT - stoneTop[x]));
          const n = 2 + ri(XG.evil.veinSize);
          for (let i = 0; i < n; i++) {
            if (vx >= evilRange[0] && vx < evilRange[1] && vy <= Y_BOT &&
                tiles[idx(vx, vy)] === eStone) tiles[idx(vx, vy)] = T.SHADEWOOD;
            vx += ri(3) - 1;
            vy += ri(3) - 1;
            vx = Math.max(evilRange[0], Math.min(evilRange[1] - 1, vx));
            vy = Math.max(stoneTop[x], Math.min(Y_BOT, vy));
          }
        }
        // chasms: ragged surface cracks widening as they drop
        for (let c = 0; c < XG.evil.chasms; c++) {
          let chx = evilRange[0] + 8 + ri(Math.max(1, evilRange[1] - evilRange[0] - 16));
          let chy = hSurf[Math.min(W - 1, chx)];
          const len = 40 + ri(30);
          for (let s = 0; s < len; s++) {
            carveCircle(chx, chy, XG.evil.chasmRad + (s / len) * 1.6);
            chx += (rng() - 0.5) * 1.2;
            chy += 1.1;
            chx = Math.max(evilRange[0] + 3, Math.min(evilRange[1] - 3, chx));
            if (chy > Y_BOT - 4) break;
          }
        }
      }
      c.evilRange = evilRange;             // consumed by structures + validation
    }

    // ---- Pass: caves — cheese caverns, worm tunnels, ocean water/sealing,
    // underworld caverns + lava fields + hell temples ----
    function passCaves(c) {
      const U = TC.Utils, G = TC.CONST.GEN, T = TC.TILE, WALL = TC.WALL;
      const W = c.width, H = c.height;
      const tiles = c.tiles, hSurf = c.hSurf, stoneTop = c.stoneTop;
      const rng = c.rng;
      const idx = (x, y) => y * W + x;
      const inB = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
      const ri = (n) => (rng() * n) | 0;  // int in [0, n)
      const BR = G.bedrockRows;
      const Y_TOP = 1, Y_BOT = H - BR - 1;   // rows open to carving
      const caveN = new U.Noise2D((c.seed ^ 0x5bd1e995) | 0);
      const underN = new U.Noise2D((c.seed ^ 0xA5A5A5) | 0);
      // Ocean geometry recomputed deterministically (rng-free) for 5a below.
      const SEA = G.baseSurface + XG.ocean.seaLevelOff;
      const OCW = Math.min(XG.ocean.width, W >> 3);
      const BCH = XG.ocean.beach;
      // Rects stamped here that want a matching background wall (temples).
      const wallJobs = c.wallJobs;

      // solid LUT from tile defs (used by the liquid pool filler)
      const DEFS = TC.TILE_DEFS;
      const SOLID = new Uint8Array(DEFS.length);
      for (let i = 0; i < DEFS.length; i++) {
        SOLID[i] = DEFS[i].solid ? 1 : 0;
      }

      // circle carver shared by tunnels and evil chasms
      const carveCircle = (cx, cy, r) => {
        const x0 = Math.max(1, Math.floor(cx - r)), x1 = Math.min(W - 2, Math.ceil(cx + r));
        const y0 = Math.max(Y_TOP, Math.floor(cy - r)), y1 = Math.min(Y_BOT, Math.ceil(cy + r));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy <= r * r && tiles[idx(x, y)] !== T.BEDROCK) {
              tiles[idx(x, y)] = T.AIR;
            }
          }
        }
      };

      // ---- 4. cheese caves ----
      for (let x = 0; x < W; x++) {
        const y0 = hSurf[x] + G.caveStartDepth;
        for (let y = y0; y <= Y_BOT; y++) {
          if (caveN.fbm2(x * G.caveFreq, y * G.caveFreq, 3, 2, 0.5) > G.caveThreshold) {
            tiles[idx(x, y)] = T.AIR;
          }
        }
      }

      // ---- 5. worm tunnels ----
      for (let w = 0; w < G.worms; w++) {
        let wx = 4 + rng() * (W - 8);
        let wy = hSurf[Math.min(W - 1, wx | 0)] + G.caveStartDepth + rng() * 60;
        wy = Math.min(wy, Y_BOT - 2);
        const len = G.wormLenMin + rng() * G.wormLenVar;
        const rad = G.wormRadMin + rng() * G.wormRadVar;
        let ang = rng() * Math.PI * 2;
        for (let s = 0; s < len; s++) {
          carveCircle(wx, wy, rad);
          ang += (rng() - 0.5) * 0.85;
          wx += Math.cos(ang);
          wy += Math.sin(ang) * 0.75;
          if (wx < 3) wx = 3; else if (wx > W - 4) wx = W - 4;
          if (wy < Y_TOP + 2) wy = Y_TOP + 2; else if (wy > Y_BOT - 1) wy = Y_BOT - 1;
        }
      }

      // ---- 5a. ocean water: fill volumes, cap shores, seal breaches ----
      const inOceanX = (x) => x < OCW + BCH || x >= W - OCW - BCH;
      for (let x = 0; x < OCW; x++) {
        for (let y = SEA; y < hSurf[x]; y++) tiles[idx(x, y)] = T.WATER;
      }
      for (let x = W - OCW; x < W; x++) {
        for (let y = SEA; y < hSurf[x]; y++) tiles[idx(x, y)] = T.WATER;
      }
      for (let x = 0; x < OCW + BCH; x++) {            // seabed + beach sand caps
        const s = hSurf[x], cap = 3 + ri(2);
        for (let y = s; y < Math.min(stoneTop[x], s + cap); y++) {
          const t = tiles[idx(x, y)];
          if (t === T.GRASS || t === T.DIRT) tiles[idx(x, y)] = T.SAND;
        }
      }
      for (let x = W - OCW - BCH; x < W; x++) {
        const s = hSurf[x], cap = 3 + ri(2);
        for (let y = s; y < Math.min(stoneTop[x], s + cap); y++) {
          const t = tiles[idx(x, y)];
          if (t === T.GRASS || t === T.DIRT) tiles[idx(x, y)] = T.SAND;
        }
      }
      // Flood any carving that breached the seabed: BFS from the placed water
      // into AIR, bounded in depth so a deep tunnel doesn't drain the sea.
      {
        const yCap = SEA + XG.ocean.floodDepth;
        const sealQ = [];
        for (let x = 0; x < W; x++) {
          if (!inOceanX(x)) continue;
          for (let y = SEA; y < Math.min(hSurf[x], H - 1); y++) {
            if (tiles[idx(x, y)] === T.WATER) sealQ.push(idx(x, y));
          }
        }
        let head = 0;
        while (head < sealQ.length) {
          const ci = sealQ[head++];
          const cxx = ci % W, cyy = (ci / W) | 0;
          if (cxx > 0 && inOceanX(cxx - 1)) {
            const ni = ci - 1;
            if (tiles[ni] === T.AIR && cyy <= yCap) { tiles[ni] = T.WATER; sealQ.push(ni); }
          }
          if (cxx < W - 1 && inOceanX(cxx + 1)) {
            const ni = ci + 1;
            if (tiles[ni] === T.AIR && cyy <= yCap) { tiles[ni] = T.WATER; sealQ.push(ni); }
          }
          if (cyy + 1 < H && cyy + 1 <= yCap) {
            const ni = ci + W;
            if (tiles[ni] === T.AIR) { tiles[ni] = T.WATER; sealQ.push(ni); }
          }
        }
      }

      // ---- 5b. underworld: big caverns + lava fields + hell temples ----
      const UW = G.underworld;
      for (let y = UW.startY; y <= Y_BOT; y++) {
        for (let x = 0; x < W; x++) {
          if (tiles[idx(x, y)] !== T.BEDROCK &&
              underN.fbm2(x * UW.cavernFreq, y * UW.cavernFreq, 2, 2, 0.5) > UW.cavernThreshold) {
            tiles[idx(x, y)] = T.AIR;
          }
        }
      }
      // Flood-fill a liquid pool from a cave floor cell; returns tiles placed.
      const liqStamp = new Uint32Array(W * H);
      let liqCur = 0;
      const pool = (sx, sy, id, maxTiles) => {
        if (!inB(sx, sy + 1) || tiles[idx(sx, sy)] !== T.AIR) return 0;
        if (SOLID[tiles[idx(sx, sy + 1)]] !== 1) return 0; // must start on a floor
        liqCur++;
        const q = [idx(sx, sy)];
        let head = 0, filled = 0;
        while (head < q.length && filled < maxTiles) {
          const ci = q[head++];
          if (liqStamp[ci] === liqCur) continue;
          liqStamp[ci] = liqCur;
          if (tiles[ci] !== T.AIR) continue;
          tiles[ci] = id;
          filled++;
          const cxx = ci % W, cyy = (ci / W) | 0;
          if (cxx > 0) q.push(ci - 1);
          if (cxx < W - 1) q.push(ci + 1);
          if (cyy > 0) q.push(ci - W);
          if (cyy < H - 1) q.push(ci + W);
        }
        return filled;
      };
      const lavaField = (count, yLo, yHi) => {
        let done = 0, tries = 0;
        while (done < count && tries < count * 60) {
          tries++;
          if (pool(2 + ri(W - 4), yLo + ri(Math.max(1, yHi - yLo)), T.LAVA, UW.lavaMaxTiles) > 0) done++;
        }
      };
      lavaField(UW.lavaPools, UW.startY, Y_BOT - 1);
      // extra pools biased to the infernal bottom rows
      lavaField(XG.hell.lavaPoolsDeep,
        UW.startY + (((Y_BOT - UW.startY) * 2 / 3) | 0), Y_BOT - 2);
      // hell temples: brick vaults sunk into the cavern layer, stamped after
      // the lava fields so their interiors stay dry apart from the channel.
      const stampTemple = (tx0, ty0) => {
        const tw = XG.hell.tW, th = XG.hell.tH;
        const x1 = tx0 + tw - 1, y1 = ty0 + th - 1;
        for (let y = ty0; y <= y1; y++) {
          for (let x = tx0; x <= x1; x++) {
            const edge = x === tx0 || x === x1 || y === ty0 || y === y1;
            tiles[idx(x, y)] = edge ? T.HELL_BRICK : T.AIR;
          }
        }
        const fy = y1 - 1;                              // dry shelves flank a lava channel
        const mx0 = tx0 + ((tw / 3) | 0), mx1 = x1 - ((tw / 3) | 0);
        for (let x = mx0; x <= mx1; x++) tiles[idx(x, fy)] = T.LAVA;
        for (const px of [mx0 - 2, mx1 + 2]) {          // floor-to-ceiling pillars
          for (let y = ty0 + 1; y <= fy; y++) tiles[idx(px, y)] = T.HELL_BRICK;
        }
        tiles[idx(tx0 + 2, fy)] = T.HELL_BRICK;         // treasure pedestal
        tiles[idx(tx0 + 2, fy - 1)] = T.CHEST;          // looted via TC.Chests on open
        tiles[idx(tx0 + 1, ty0 + 2)] = T.TORCH;         // wall torches (brick beside)
        tiles[idx(x1 - 1, ty0 + 2)] = T.TORCH;
        wallJobs.push({ x0: tx0, x1: x1, y0: ty0, y1: y1, w: WALL.HELL });
      };
      for (let ti = 0; ti < XG.hell.temples; ti++) {
        const jx = Math.round((rng() - 0.5) * 80);
        const tx0 = Math.max(8, Math.min(W - 9 - XG.hell.tW,
          Math.round(((ti + 0.5) * W) / XG.hell.temples - XG.hell.tW / 2) + jx));
        const ty0 = UW.startY + 4 + ri(Math.max(1, Y_BOT - XG.hell.tH - 6 - UW.startY));
        stampTemple(tx0, ty0);
      }
    }

    // ---- Pass: deep caves — large multi-worm caverns, vertical shafts
    // linking the cave layers, winding random-walk tunnels, underground water
    // lakes, and lava caverns along the underworld rim. Runs only when
    // CONFIG.deepCaves is set (default on as of v3). ----
    function passDeepCaves(c) {
      if (!TC.WorldGen.CONFIG.deepCaves) return;
      const G = TC.CONST.GEN, T = TC.TILE;
      const W = c.width, H = c.height;
      const tiles = c.tiles;
      const rng = c.rng;
      const idx = (x, y) => y * W + x;
      const inB = (x, y) => x >= 1 && x < W - 1 && y >= 1 && y < H - 1;
      const ri = (n) => (rng() * n) | 0;  // int in [0, n)
      const BR = G.bedrockRows;
      const Y_BOT = H - BR - 1;           // deepest carveable row
      const UW = G.underworld.startY;
      const D = XG.deep;

      // solid LUT for the basin filler
      const DEFS = TC.TILE_DEFS;
      const SOLID = new Uint8Array(DEFS.length);
      for (let i = 0; i < DEFS.length; i++) SOLID[i] = DEFS[i].solid ? 1 : 0;

      // Carving never rises above depthMin: oceans and root-zone caves are
      // fully handled upstream and stay untouched.
      const carveCircle = (cx, cy, r) => {
        const x0 = Math.max(1, Math.floor(cx - r)), x1 = Math.min(W - 2, Math.ceil(cx + r));
        const y0 = Math.max(D.depthMin, Math.floor(cy - r)), y1 = Math.min(Y_BOT, Math.ceil(cy + r));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy <= r * r && tiles[idx(x, y)] !== T.BEDROCK) {
              tiles[idx(x, y)] = T.AIR;
            }
          }
        }
      };

      // ---- large caverns: chains of fat, overlapping wandering worms ----
      for (let k = 0; k < D.caverns; k++) {
        const ccx = 30 + ri(W - 60);
        const ccy = 185 + ri(Math.max(1, UW - 25 - 185));
        const worms = D.wormMin + ri(D.wormVar);
        for (let wi = 0; wi < worms; wi++) {
          let wx = ccx + ri(21) - 10, wy = ccy + ri(15) - 7;
          let ang = rng() * Math.PI * 2;
          const rad = D.rad + rng() * D.radVar;
          const len = D.len + ri(D.lenVar);
          for (let s = 0; s < len; s++) {
            carveCircle(wx, wy, rad * (0.72 + 0.28 * Math.sin(s * 0.11 + wi)));
            ang += (rng() - 0.5) * 0.65;
            wx += Math.cos(ang) * 1.7;
            wy += Math.sin(ang) * 0.95;
            if (wx < 24) wx = 24; else if (wx > W - 25) wx = W - 25;
            if (wy < D.depthMin) wy = D.depthMin; else if (wy > Y_BOT - 4) wy = Y_BOT - 4;
          }
        }
      }

      // ---- vertical shafts connecting the cave layers ----
      for (let k = 0; k < D.shafts; k++) {
        let sx = 26 + ri(W - 52);
        let sy = D.depthMin + ri(30);
        const len = D.shaftLenMin + ri(D.shaftLenVar);
        for (let s = 0; s < len && sy < Y_BOT - 3; s++) {
          carveCircle(sx, sy, D.shaftRad);
          if (s % 5 === 4) sx += ri(3) - 1;         // occasional jiggle
          sy++;
          if (sx < 20) sx = 20; else if (sx > W - 21) sx = W - 21;
        }
      }

      // ---- winding tunnels: direction-biased random walks ----
      for (let k = 0; k < D.tunnels; k++) {
        let tx = 26 + ri(W - 52);
        let ty = D.depthMin + 10 + ri(Math.max(1, UW - 40 - D.depthMin));
        let dir = ri(4);                             // 0 E, 1 S, 2 W, 3 N
        const steps = D.tunnelSteps + ri(D.tunnelStepsVar);
        for (let s = 0; s < steps; s++) {
          carveCircle(tx, ty, D.tunnelRad);
          if (rng() < 0.3) dir = ri(4);
          if (dir === 0) tx++; else if (dir === 1) ty++;
          else if (dir === 2) tx--; else ty--;
          if (tx < 22) { tx = 22; dir = 0; } else if (tx > W - 23) { tx = W - 23; dir = 2; }
          if (ty < D.depthMin) { ty = D.depthMin; dir = 1; }
          else if (ty > Y_BOT - 3) { ty = Y_BOT - 3; dir = 3; }
        }
      }

      // ---- liquid basins: flood AIR pockets up to a level line ----
      const stamp = new Uint32Array(W * H);
      let stampCur = 0;
      const probeFloor = (x, y0, y1) => {
        for (let y = Math.max(D.depthMin, y0); y <= Math.min(Y_BOT - 1, y1); y++) {
          if (tiles[idx(x, y)] === T.AIR && SOLID[tiles[idx(x, y + 1)]] === 1) return y;
        }
        return -1;
      };
      const basin = (sx, sy, id, wl, maxTiles) => {
        if (!inB(sx, sy) || tiles[idx(sx, sy)] !== T.AIR) return 0;
        if (SOLID[tiles[idx(sx, sy + 1)]] !== 1) return 0; // must rest on a floor
        stampCur++;
        const q = [idx(sx, sy)];
        let head = 0, filled = 0;
        while (head < q.length && filled < maxTiles) {
          const ci = q[head++];
          if (stamp[ci] === stampCur) continue;
          stamp[ci] = stampCur;
          if (tiles[ci] !== T.AIR) continue;
          tiles[ci] = id;
          filled++;
          const cxx = ci % W, cyy = (ci / W) | 0;
          if (cxx > 1) q.push(ci - 1);
          if (cxx < W - 2) q.push(ci + 1);
          if (cyy < Y_BOT) q.push(ci + W);                   // settles downward
          if (cyy > D.depthMin && cyy <= wl) q.push(ci - W); // rises to the line
        }
        return filled;
      };

      // ---- underground water lakes in carved basins ----
      for (let k = 0; k < D.lakes; k++) {
        const lx = 26 + ri(W - 52);
        const ly = D.lakeYMin + ri(Math.max(1, Y_BOT - 12 - D.lakeYMin));
        const fy = probeFloor(lx, ly, ly + 70);
        if (fy > 0) basin(lx, fy, T.WATER, fy + ri(4), D.lakeMaxTiles);
      }

      // ---- lava caverns hugging the underworld boundary ----
      for (let k = 0; k < D.lavaRooms; k++) {
        const lx = 40 + ri(W - 80);
        const ly = UW - 34 + ri(26);
        const rr = D.lavaRoomRad + ri(4);
        carveCircle(lx, ly, rr);
        carveCircle(lx - rr, ly + 2, rr * 0.7);
        carveCircle(lx + rr, ly + 2, rr * 0.7);
        const fy = probeFloor(lx, ly - rr, ly + rr);
        if (fy > 0) basin(lx, fy, T.LAVA, fy + 2 + ri(3), D.lavaMaxTiles);
      }
    }

    // ---- Pass: micro biomes — five distinct signature chambers deep
    // underground (below y≈210, safely above the underworld rim): crystal
    // cavern, mushroom grotto, granite chamber, marble chamber, moss cave.
    // One chamber per fifth of the inland width, jittered inside its band.
    // Runs only when CONFIG.microBiomes is set (default on as of v3). ----
    function passMicroBiomes(c) {
      if (!TC.WorldGen.CONFIG.microBiomes) return;
      const G = TC.CONST.GEN, T = TC.TILE, WALL = TC.WALL;
      const W = c.width, H = c.height;
      const tiles = c.tiles;
      const rng = c.rng;
      const idx = (x, y) => y * W + x;
      const inB = (x, y) => x >= 1 && x < W - 1 && y >= 1 && y < H - 1;
      const ri = (n) => (rng() * n) | 0;  // int in [0, n)
      const M = XG.micro;
      const UW = G.underworld.startY;
      const wallJobs = c.wallJobs;

      // one chamber per horizontal band across the inland width
      const lo = Math.min(XG.ocean.width, W >> 3) + XG.ocean.beach + 12;
      const hi = W - lo;
      const bandW = (hi - lo) / 5;

      // ellipse pocket carver; leaves bedrock and liquids untouched
      const carveBlob = (cx, cy, rx, ry) => {
        for (let y = cy - ry; y <= cy + ry; y++) {
          for (let x = cx - rx; x <= cx + rx; x++) {
            if (!inB(x, y)) continue;
            const t = tiles[idx(x, y)];
            if (t === T.BEDROCK || t === T.WATER || t === T.LAVA) continue;
            const dx = (x - cx) / rx, dy = (y - cy) / ry;
            if (dx * dx + dy * dy <= 1) tiles[idx(x, y)] = T.AIR;
          }
        }
      };
      // small random-walk vein confined to a box, replacing solid ground only
      const vein = (x, y, x0, y0, x1, y1, id, size) => {
        for (let i = 0; i < size; i++) {
          const t = inB(x, y) ? tiles[idx(x, y)] : T.BEDROCK;
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1 &&
              t !== T.AIR && t !== T.WATER && t !== T.LAVA && t !== T.BEDROCK) {
            tiles[idx(x, y)] = id;
          }
          x += ri(3) - 1;
          y += ri(3) - 1;
          if (x < x0) x = x0; else if (x > x1) x = x1;
          if (y < y0) y = y0; else if (y > y1) y = y1;
        }
      };
      // crystallize/moss AIR cells that touch solids (wall + floor lining)
      const crust = (cx, cy, rx, ry, id, chance, yTopOff) => {
        for (let y = cy + yTopOff; y <= cy + ry + 1; y++) {
          for (let x = cx - rx - 1; x <= cx + rx + 1; x++) {
            if (!inB(x, y) || tiles[idx(x, y)] !== T.AIR) continue;
            const nb = tiles[idx(x, y - 1)] !== T.AIR || tiles[idx(x, y + 1)] !== T.AIR ||
                       tiles[idx(x - 1, y)] !== T.AIR || tiles[idx(x + 1, y)] !== T.AIR;
            if (nb && rng() < chance) tiles[idx(x, y)] = id;
          }
        }
      };
      // turn the walkable floor strip of a carved pocket into id
      const turfFloor = (cx, cy, rx, ry, id) => {
        for (let x = cx - rx + 1; x <= cx + rx - 1; x++) {
          for (let y = cy; y <= cy + ry + 1; y++) {
            if (!inB(x, y) || y + 1 >= H || tiles[idx(x, y)] !== T.AIR) continue;
            const below = tiles[idx(x, y + 1)];
            if (below !== T.AIR && below !== T.BEDROCK) {
              tiles[idx(x, y)] = id;
              break;
            }
          }
        }
      };

      for (let b = 0; b < 5; b++) {
        const cx = Math.round(lo + bandW * (b + 0.2)) + ri(Math.max(1, Math.round(bandW * 0.6)));
        const w = M.wMin + ri(M.wVar);               // 12..26 wide
        const h = M.hMin + ri(M.hVar);
        const rx = w >> 1, ry = h >> 1;
        const cy = M.yMin + ry + ri(Math.max(1, UW - 16 - M.yMin - h));
        switch (b) {
          case 0:                                    // crystal cavern
            carveBlob(cx, cy, rx, ry);
            crust(cx, cy, rx, ry, T.GLEAM, 0.4, -ry - 1);
            for (let vI = 0, nv = 1 + ri(3); vI < nv; vI++) {
              vein(cx - rx + 2 + ri(Math.max(1, w - 4)), cy - ry + ri(h),
                   cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1,
                   T.CRYSTAL_ORE, 3 + ri(4));
            }
            wallJobs.push({ x0: cx - rx - 1, x1: cx + rx + 1, y0: cy - ry - 1,
              y1: cy + ry + 1, w: WALL.GLEAM });
            break;
          case 1:                                    // mushroom grotto
            carveBlob(cx, cy, rx, ry);
            turfFloor(cx, cy, rx, ry, T.MUSHGRASS);
            for (let pI = 0, clusters = 2 + ri(3); pI < clusters; pI++) {
              const px = cx - rx + 2 + ri(Math.max(1, w - 4));
              const ph = 2 + ri(3);
              for (let y = cy; y <= cy + ry; y++) {  // first grounding row
                if (!inB(px, y) || tiles[idx(px, y)] !== T.AIR) continue;
                if (y + 1 >= H || tiles[idx(px, y + 1)] === T.AIR) continue;
                for (let k2 = 0; k2 < ph && y - k2 >= cy - ry; k2++) {
                  if (tiles[idx(px, y - k2)] === T.AIR) tiles[idx(px, y - k2)] = T.MUSHSTEM;
                }
                break;
              }
            }
            wallJobs.push({ x0: cx - rx - 1, x1: cx + rx + 1, y0: cy - ry - 1,
              y1: cy + ry + 1, w: WALL.MOSS });
            break;
          case 2:                                    // granite shell chamber
          case 3: {                                  // marble shell chamber
            const mat = b === 2 ? T.GRANITE : T.MARBLE;
            const wl = b === 2 ? WALL.GRANITE : WALL.MARBLE;
            for (let y = cy - ry; y <= cy + ry; y++) {
              for (let x = cx - rx; x <= cx + rx; x++) {
                if (!inB(x, y)) continue;
                const t = tiles[idx(x, y)];
                if (t === T.BEDROCK || t === T.WATER || t === T.LAVA) continue;
                tiles[idx(x, y)] = mat;
              }
            }
            for (let y = cy - ry + 2; y <= cy + ry - 2; y++) {   // hollow core
              for (let x = cx - rx + 2; x <= cx + rx - 2; x++) tiles[idx(x, y)] = T.AIR;
            }
            wallJobs.push({ x0: cx - rx - 1, x1: cx + rx + 1, y0: cy - ry - 1,
              y1: cy + ry + 1, w: wl });
            break;
          }
          default:                                   // moss cave
            carveBlob(cx, cy, rx, ry);
            turfFloor(cx, cy, rx, ry, T.MOSSSTONE);
            crust(cx, cy, rx, ry, T.MOSSSTONE, 0.5, -(ry >> 1));
            wallJobs.push({ x0: cx - rx - 1, x1: cx + rx + 1, y0: cy - ry - 1,
              y1: cy + ry + 1, w: WALL.MOSS });
        }
      }
    }

    // ---- Pass: ores — copper/iron/gold veins in stone ----
    function passOres(c) {
      const G = TC.CONST.GEN, T = TC.TILE;
      const W = c.width, H = c.height;
      const tiles = c.tiles, hSurf = c.hSurf;
      const rng = c.rng;
      const idx = (x, y) => y * W + x;
      const ri = (n) => (rng() * n) | 0;  // int in [0, n)
      const BR = G.bedrockRows;
      const Y_BOT = H - BR - 1;           // deepest carveable row

      // ---- 6. ore veins (replace STONE only, inside depth windows) ----
      // Silver bridges iron and gold in the 200-330 band; crystal is rare,
      // small, and anchored only near open cave space in the deep zone.
      // richOres raises every tier's vein count modestly.
      const mult = TC.WorldGen.CONFIG.richOres ? 1.25 : 1;
      const scaled = (o) => ({
        veins: Math.round(o.veins * mult),
        sizeMin: o.sizeMin, sizeVar: o.sizeVar,
        minYOff: o.minYOff, maxYOff: o.maxYOff,
        minYAbs: o.minYAbs, maxYAbs: o.maxYAbs
      });
      const oreKinds = [
        [T.COPPER_ORE, scaled(G.ores.copper)],
        [T.IRON_ORE, scaled(G.ores.iron)],
        [T.GOLD_ORE, scaled(G.ores.gold)],
        [T.SILVER_ORE, scaled(XG.ores.silver)],
        [T.CRYSTAL_ORE, scaled(XG.ores.crystal)]
      ];
      for (const pair of oreKinds) {
        const id = pair[0], o = pair[1];
        const abs = o.minYAbs != null;
        for (let v = 0; v < o.veins; v++) {
          const x = 2 + ri(W - 4);
          let yLo, yHi;
          if (abs) { yLo = o.minYAbs; yHi = Math.min(o.maxYAbs, Y_BOT); }
          else { yLo = hSurf[x] + o.minYOff; yHi = Math.min(hSurf[x] + o.maxYOff, Y_BOT); }
          if (yHi <= yLo) continue;
          let vx = x, vy = yLo + ri(yHi - yLo);
          if (id === T.CRYSTAL_ORE) {
            // deep cavern zones only: require open space near the anchor
            let nearAir = false;
            for (let oy = -5; oy <= 5 && !nearAir; oy += 2) {
              for (let ox = -5; ox <= 5 && !nearAir; ox += 2) {
                const nx = x + ox, ny = vy + oy;
                if (nx >= 1 && nx < W - 1 && ny >= 1 && ny < H - 1 &&
                    tiles[idx(nx, ny)] === T.AIR) nearAir = true;
              }
            }
            if (!nearAir) continue;
          }
          const size = o.sizeMin + ri(o.sizeVar);
          for (let i = 0; i < size; i++) {
            if (vx >= 1 && vx < W - 1 && vy >= yLo && vy <= yHi &&
                tiles[idx(vx, vy)] === T.STONE) tiles[idx(vx, vy)] = id;
            vx += ri(3) - 1;
            vy += ri(3) - 1;
            if (vx < 1) vx = 1; else if (vx > W - 2) vx = W - 2;
            if (vy < 1) vy = 1; else if (vy > Y_BOT) vy = Y_BOT;
          }
        }
      }
    }

    // ---- Pass: structures — bedrock floor, buried pyramids + cactus scrub,
    // surface dungeon keep ----
    function passStructures(c) {
      const G = TC.CONST.GEN, T = TC.TILE, WALL = TC.WALL;
      const W = c.width, H = c.height;
      const tiles = c.tiles, hSurf = c.hSurf;
      const rng = c.rng;
      const idx = (x, y) => y * W + x;
      const inB = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
      const ri = (n) => (rng() * n) | 0;  // int in [0, n)
      const BR = G.bedrockRows;
      const Y_TOP = 1, Y_BOT = H - BR - 1;   // rows open to carving
      // Inland placement bounds (rng-free; matches terrain's ocean/beach widths).
      const inlandLo = Math.min(XG.ocean.width, W >> 3) + XG.ocean.beach + 8;
      const inlandHi = W - inlandLo;
      const deserts = c.deserts;             // placed by surface-biomes
      const biomes = c.biomes;               // placed by surface-biomes
      const evilRange = c.evilRange;         // placed by surface-biomes
      // Rects stamped here that want a matching background wall.
      const wallJobs = c.wallJobs;

      // Reusable room primitive: material outline, hollow AIR interior,
      // optional distinct floor material + background-wall job.
      const buildRoom = (x, y, w, h, opt) => {
        opt = opt || {};
        const mat = opt.material != null ? opt.material : T.STONE;
        const x1 = x + w - 1, y1 = y + h - 1;
        for (let yy = y; yy <= y1; yy++) {
          for (let xx = x; xx <= x1; xx++) {
            const edge = xx === x || xx === x1 || yy === y || yy === y1;
            tiles[idx(xx, yy)] = edge ? mat : T.AIR;
          }
        }
        if (opt.floor != null) {
          for (let xx = x + 1; xx <= x1 - 1; xx++) tiles[idx(xx, y1)] = opt.floor;
        }
        if (opt.wall != null) {
          wallJobs.push({ x0: x, x1: x1, y0: y, y1: y1, w: opt.wall });
        }
      };

      // ---- 7. bedrock floor (+ noisy third row) ----
      for (let x = 0; x < W; x++) {
        for (let k = 0; k < BR; k++) tiles[idx(x, H - 1 - k)] = T.BEDROCK;
        if (rng() < 0.45) tiles[idx(x, H - BR - 1)] = T.BEDROCK;
      }

      // ---- 7b. desert decoration: buried pyramids + cactus scrub ----
      // Built after carving so the structures stay intact.
      for (const dr of deserts) {
        const dw = dr[1] - dr[0];
        if (dw < 18 || rng() > XG.pyramid.chance) continue;
        const bw = Math.min(dw - 6, XG.pyramid.baseMin + ri(XG.pyramid.baseVar));
        const pcx = dr[0] + (bw >> 1) + 2 + ri(Math.max(1, dw - bw - 4));
        const baseY = hSurf[Math.min(W - 1, pcx)] + 3;
        const ph = bw >> 1;
        if (baseY - ph < Y_TOP + 4) continue;
        for (let r = 0; r < ph; r++) {                 // stepped brick shell
          const y = baseY - r, hw = (bw >> 1) - r;
          for (let x = pcx - hw; x <= pcx + hw; x++) {
            if (inB(x, y)) tiles[idx(x, y)] = T.SANDSTONE_BRICK;
          }
        }
        for (let y = baseY - 4; y <= baseY - 1; y++) { // hidden burial chamber
          for (let x = pcx - 3; x <= pcx + 3; x++) tiles[idx(x, y)] = T.AIR;
        }
        tiles[idx(pcx, baseY - 1)] = T.CHEST;          // floor row baseY is brick
        tiles[idx(pcx - 2, baseY - 1)] = T.TORCH;
        tiles[idx(pcx + 2, baseY - 1)] = T.TORCH;
        for (let k = 0; k < 6; k++) {                  // gold seams in the masonry
          const gx = pcx - 3 + ri(7), gy = baseY + 1 + ri(2);
          if (inB(gx, gy) && tiles[idx(gx, gy)] === T.SANDSTONE_BRICK) tiles[idx(gx, gy)] = T.GOLD_ORE;
        }
        wallJobs.push({ x0: pcx - (bw >> 1) - 1, x1: pcx + (bw >> 1) + 1, y0: baseY - ph - 1, y1: baseY + 2, w: WALL.SAND });
      }
      for (const dr of deserts) {                      // cactus scrub on open sand
        for (let x = dr[0] + 1; x < dr[1] - 1; x += XG.cactus.spacing + ri(3)) {
          if (rng() > XG.cactus.chance) continue;
          const s = hSurf[x];
          if (tiles[idx(x, s)] !== T.SAND || tiles[idx(x, s - 1)] !== T.AIR) continue;
          const ch = XG.cactus.hMin + ri(XG.cactus.hVar);
          for (let k = 1; k <= ch && s - k >= Y_TOP; k++) {
            if (tiles[idx(x, s - k)] !== T.AIR) break;
            tiles[idx(x, s - k)] = T.CACTUS;
          }
        }
      }

      // ---- 7c. dungeon: surface keep, lined shaft, side rooms ----
      const dungeonSite = () => {
        const offs = [300, -300, 380, -380, 230, -230, 450, -450];
        for (const off of offs) {
          const x = (W >> 1) + off;
          if (x - 12 < inlandLo || x + 12 >= inlandHi) continue;
          let hit = false;
          for (const dr of deserts) {
            if (x - 14 < dr[1] && x + 14 > dr[0]) { hit = true; break; }
          }
          if (!hit && evilRange && x - 14 < evilRange[1] && x + 14 > evilRange[0]) hit = true;
          for (const bm of biomes) {
            if (!hit && x - 14 < bm[1] && x + 14 > bm[0]) { hit = true; break; }
          }
          if (!hit) return x;
        }
        return -1;
      };
      const dgx = dungeonSite();
      if (dgx > 0) {
        const rw = XG.dungeon.roomW, rh = XG.dungeon.roomH;
        const roomGap = rh + 8;
        const topY = hSurf[dgx];
        const botY = Math.min(Y_BOT - 40, topY + 26 + (XG.dungeon.rooms - 1) * roomGap);
        for (let y = topY - 4; y <= topY - 1; y++) {   // keep interior
          for (let x = dgx - 4; x <= dgx + 4; x++) tiles[idx(x, y)] = T.AIR;
        }
        for (let x = dgx - 5; x <= dgx + 5; x++) tiles[idx(x, topY)] = T.DUNGEON_BRICK;
        for (let x = dgx - 1; x <= dgx + 1; x++) tiles[idx(x, topY)] = T.AIR; // shaft mouth
        tiles[idx(dgx - 4, topY - 1)] = T.TORCH;
        tiles[idx(dgx + 4, topY - 1)] = T.TORCH;
        for (let y = topY; y <= botY; y++) {           // brick-lined shaft
          for (let x = dgx - 2; x <= dgx + 2; x++) {
            tiles[idx(x, y)] = (x === dgx - 2 || x === dgx + 2) ? T.DUNGEON_BRICK : T.AIR;
          }
          if (y > topY && (y - topY) % 7 === 0) tiles[idx(dgx - 1, y)] = T.TORCH;
        }
        for (let r = 0; r < XG.dungeon.rooms; r++) {   // rooms off the shaft
          const ry = topY + 26 + r * roomGap;          // room floor row
          const side = (r % 2 === 0) ? -1 : 1;
          const rx0 = side < 0 ? dgx - 4 - rw : dgx + 4;
          for (let y = ry - rh; y <= ry; y++) {
            for (let x = rx0; x <= rx0 + rw - 1; x++) {
              const edge = x === rx0 || x === rx0 + rw - 1 || y === ry - rh || y === ry;
              tiles[idx(x, y)] = edge ? T.DUNGEON_BRICK : T.AIR;
            }
          }
          const cy = ry - (rh >> 1);                   // corridor to the shaft
          const wx = side < 0 ? rx0 + rw - 1 : rx0;
          for (let x = Math.min(dgx, wx); x <= Math.max(dgx, wx); x++) {
            tiles[idx(x, cy)] = T.AIR;
            tiles[idx(x, cy - 1)] = T.AIR;
          }
          const fx = side < 0 ? rx0 + 2 : rx0 + rw - 3;
          tiles[idx(fx, ry - 1)] = T.CHEST;
          tiles[idx(fx + (side < 0 ? 1 : -1), ry - 1)] = T.TORCH;
          tiles[idx(side < 0 ? rx0 + 1 : rx0 + rw - 2, ry - rh + 1)] = T.TORCH;
          wallJobs.push({ x0: rx0, x1: rx0 + rw - 1, y0: ry - rh, y1: ry, w: WALL.DUNGEON });
        }
        wallJobs.push({ x0: dgx - 5, x1: dgx + 5, y0: topY - 5, y1: botY, w: WALL.DUNGEON });
      }

      // ---- 7d. surface cabins near the spawn region (wood, door gap,
      // torch + chest using the same CHEST-tile mechanism as above) ----
      const cabinSite = (x, tol) => {
        if (x - 6 < inlandLo || x + 6 >= inlandHi) return false;
        let mn = 32767, mx = -32768;
        for (let dx = -5; dx <= 5; dx++) {
          const h2 = hSurf[x + dx];
          const g2 = tiles[idx(x + dx, h2)];
          if (g2 !== T.GRASS && g2 !== T.SNOW && g2 !== T.JGRASS) return false;
          if (h2 < mn) mn = h2;
          if (h2 > mx) mx = h2;
        }
        return mx - mn <= tol;
      };
      let cabins = 0;
      for (const off of [80, 125, 170, 215, 260]) {
        if (cabins >= 3) break;
        for (const sgn of [1, -1]) {
          const bx = (W >> 1) + sgn * off + ri(31) - 15;
          if (!cabinSite(bx, 4)) continue;
          const gy = hSurf[bx];                        // ground / floor row
          const cw = 9, chH = 6;
          const x0 = bx - ((cw / 2) | 0);
          buildRoom(x0, gy - chH + 1, cw, chH, { material: T.WOOD });
          const doorX = sgn > 0 ? x0 + cw - 1 : x0;    // gap in the near wall
          if (inB(doorX, gy)) { tiles[idx(doorX, gy)] = T.AIR; tiles[idx(doorX, gy - 1)] = T.AIR; }
          if (inB(x0 + 2, gy - 1)) tiles[idx(x0 + 2, gy - 1)] = T.TORCH;
          if (inB(x0 + cw - 3, gy - 1)) tiles[idx(x0 + cw - 3, gy - 1)] = T.CHEST;
          cabins++;
          break;
        }
      }

      // ---- 7e. underground shrine rooms (stone brick vaults, torch +
      // chest), spread across the map at staggered depths ----
      const UWs = G.underworld.startY;
      for (let si = 0; si < 3; si++) {
        const sw = 13, sh = 9;
        const scx = Math.round(((si + 0.5) * W) / 3) + ri(61) - 30;
        const sy1 = 242 + si * 42 + ri(15);            // floor row
        const x0 = scx - ((sw / 2) | 0);
        if (sy1 + 1 >= UWs - 6 || x0 < inlandLo || x0 + sw >= inlandHi) continue;
        buildRoom(x0, sy1 - sh + 1, sw, sh,
          { material: T.DUNGEON_BRICK, wall: WALL.DUNGEON, floor: T.DUNGEON_BRICK });
        tiles[idx(x0 + 2, sy1 - 1)] = T.TORCH;
        tiles[idx(x0 + sw - 3, sy1 - 1)] = T.TORCH;
        tiles[idx(scx, sy1 - 1)] = T.CHEST;
      }

      // ---- 7f. desert ruins: weathered sandstone-brick shells ----
      let ruins = 0;
      for (const dr of deserts) {
        if (ruins >= 2 || dr[1] - dr[0] < 30) continue;
        const rx0 = dr[0] + 6 + ri(Math.max(1, dr[1] - dr[0] - 24));
        const ry0 = hSurf[Math.min(W - 1, rx0 + 6)] + 1;   // sunk foundation
        const rw = 13, rh = 7;
        for (let yy = 0; yy < rh; yy++) {
          for (let xx = 0; xx < rw; xx++) {
            const x = rx0 + xx, y = ry0 - yy;
            if (!inB(x, y) || y < Y_TOP + 1) continue;
            const edge = xx === 0 || xx === rw - 1 || yy === 0 || yy === rh - 1;
            if (!edge) continue;
            // weathering: upper courses crumble away
            if (yy >= rh - 3 && rng() < 0.55) continue;
            if (rng() < 0.12) continue;
            tiles[idx(x, y)] = T.SANDSTONE_BRICK;
          }
        }
        wallJobs.push({ x0: rx0 - 1, x1: rx0 + rw, y0: ry0 - rh, y1: ry0 + 1, w: WALL.SAND });
        ruins++;
      }
    }

    // ---- Pass: decor — spawn point, trees, flowers, cave water pools,
    // spawn clearing ----
    function passDecor(c) {
      const G = TC.CONST.GEN, T = TC.TILE;
      const W = c.width, H = c.height;
      const tiles = c.tiles, hSurf = c.hSurf;
      const rng = c.rng;
      const idx = (x, y) => y * W + x;
      const inB = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
      const ri = (n) => (rng() * n) | 0;  // int in [0, n)
      const BR = G.bedrockRows;
      const Y_TOP = 1, Y_BOT = H - BR - 1; // top placeable / deepest carveable row

      // solid LUT from tile defs (spawn check + pool filler)
      const DEFS = TC.TILE_DEFS;
      const SOLID = new Uint8Array(DEFS.length);
      for (let i = 0; i < DEFS.length; i++) {
        SOLID[i] = DEFS[i].solid ? 1 : 0;
      }

      // Flood-fill a liquid pool from a cave floor cell; returns tiles placed.
      const liqStamp = new Uint32Array(W * H);
      let liqCur = 0;
      const pool = (sx, sy, id, maxTiles) => {
        if (!inB(sx, sy + 1) || tiles[idx(sx, sy)] !== T.AIR) return 0;
        if (SOLID[tiles[idx(sx, sy + 1)]] !== 1) return 0; // must start on a floor
        liqCur++;
        const q = [idx(sx, sy)];
        let head = 0, filled = 0;
        while (head < q.length && filled < maxTiles) {
          const ci = q[head++];
          if (liqStamp[ci] === liqCur) continue;
          liqStamp[ci] = liqCur;
          if (tiles[ci] !== T.AIR) continue;
          tiles[ci] = id;
          filled++;
          const cxx = ci % W, cyy = (ci / W) | 0;
          if (cxx > 0) q.push(ci - 1);
          if (cxx < W - 1) q.push(ci + 1);
          if (cyy > 0) q.push(ci - W);
          if (cyy < H - 1) q.push(ci + W);
        }
        return filled;
      };

      // ---- 8. spawn: flat grass near world center ----
      const spawnFlat = (x, tol) => {
        if (x < 3 || x >= W - 3) return false;
        let mn = 32767, mx = -32768;
        for (let dx = -2; dx <= 2; dx++) {
          const h = hSurf[x + dx];
          if (tiles[idx(x + dx, h)] !== T.GRASS) return false;
          if (h < mn) mn = h;
          if (h > mx) mx = h;
        }
        if (mx - mn > tol) return false;
        return SOLID[tiles[idx(x, hSurf[x] + 1)]] === 1;
      };
      const cx = W >> 1;
      let spawnX = -1;
      outer:
      for (const tol of [1, 2, 4]) {
        for (let off = 0; off <= 320; off++) {
          if (spawnFlat(cx + off, tol)) { spawnX = cx + off; break outer; }
          if (off !== 0 && spawnFlat(cx - off, tol)) { spawnX = cx - off; break outer; }
        }
      }
      if (spawnX < 0) spawnX = cx; // last resort, vanishingly unlikely
      const spawnGround = hSurf[spawnX];

      // ---- 9. trees on grass/snow/jungle grass (skip deserts & spawn area) ----
      let nextX = 0;
      for (let x = 2; x < W - 2; x++) {
        if (x < nextX || Math.abs(x - spawnX) <= 4) continue;
        const s = hSurf[x];
        const ground = tiles[idx(x, s)];
        if (ground !== T.GRASS && ground !== T.SNOW && ground !== T.JGRASS &&
            ground !== T.EBONGRASS) continue;
        if (ground === T.EBONGRASS) { // dead shadewood tree: bare trunk, no canopy
          const th = G.trees.hMin + 2 + ri(G.trees.hVar);
          if (s - th < Y_TOP) continue;
          for (let y = s - 1; y >= s - th; y--) tiles[idx(x, y)] = T.SHADEWOOD;
          nextX = x + G.trees.minSpacing + ri(G.trees.varSpacing);
          continue;
        }
        const jungle = ground === T.JGRASS; // thick jungle: half the spacing
        const th = G.trees.hMin + ri(G.trees.hVar);
        const lr = G.trees.leafRadMin + rng() * G.trees.leafRadVar;
        const top = s - th, R = Math.ceil(lr);
        if (top - R < Y_TOP) continue;
        for (let y = s - 1; y >= top; y--) tiles[idx(x, y)] = T.TRUNK;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy > lr * lr + 0.5) continue;
            const lx = x + dx, ly = top + dy;
            if (lx < 0 || lx >= W || ly < 0) continue;
            if (tiles[idx(lx, ly)] === T.AIR) tiles[idx(lx, ly)] = T.LEAVES;
          }
        }
        nextX = x + (jungle ? (G.trees.minSpacing >> 1) : G.trees.minSpacing)
                  + ri(jungle ? Math.max(1, G.trees.varSpacing >> 1) : G.trees.varSpacing);
      }

      // ---- 10. tall grass & flowers on remaining grass ----
      for (let x = 0; x < W; x++) {
        if (Math.abs(x - spawnX) <= 2) continue;
        const s = hSurf[x];
        if (tiles[idx(x, s)] !== T.GRASS || tiles[idx(x, s - 1)] !== T.AIR) continue;
        const roll = rng();
        if (roll < G.flowerChance) {
          tiles[idx(x, s - 1)] = rng() < 0.5 ? T.FLOWER_RED : T.FLOWER_YELLOW;
        } else if (roll < G.flowerChance + G.tallGrassChance) {
          tiles[idx(x, s - 1)] = T.TALLGRASS;
        }
      }

      // ---- 11. static water pools in deep caves ----
      {
        let pools = 0, tries = 0;
        const yLoW = G.waterMinY, yHiW = Y_BOT - 1;
        while (pools < G.waterPools && tries < G.waterPools * 60) {
          tries++;
          if (pool(2 + ri(W - 4), yLoW + ri(Math.max(1, yHiW - yLoW)), T.WATER, G.waterMaxTiles) > 0) pools++;
        }
      }

      // ---- 12. clear the spawn area ----
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = 1; dy <= 5; dy++) {
          const x = spawnX + dx, y = spawnGround - dy;
          if (x >= 0 && x < W && y >= 0 && tiles[idx(x, y)] !== T.BEDROCK) {
            tiles[idx(x, y)] = T.AIR;
          }
        }
      }
      c.spawnX = spawnX;                   // consumed by validation
    }

    // ---- Pass: validation — repair-first sweep (invalid ids -> AIR/NONE,
    // bedrock floor integrity, dry + flat spawn area), landmark census,
    // final surface scan, background walls. Deterministic: consumes no rng.
    function passValidation(c) {
      const T = TC.TILE, WALL = TC.WALL;
      const W = c.width, H = c.height;
      const tiles = c.tiles, stoneTop = c.stoneTop;
      const idx = (x, y) => y * W + x;
      // Ocean geometry recomputed deterministically (rng-free).
      const G = TC.CONST.GEN;
      const SEA = G.baseSurface + XG.ocean.seaLevelOff;
      const OCW = Math.min(XG.ocean.width, W >> 3);
      const BCH = XG.ocean.beach;
      const inOceanX = (x) => x < OCW + BCH || x >= W - OCW - BCH;
      // opaque/solid LUTs from tile defs
      const DEFS = TC.TILE_DEFS, WALL_DEFS = TC.WALL_DEFS;
      const OPQ = new Uint8Array(DEFS.length);
      const SOLID = new Uint8Array(DEFS.length);
      for (let i = 0; i < DEFS.length; i++) {
        OPQ[i] = DEFS[i].opaque ? 1 : 0;
        SOLID[i] = DEFS[i].solid ? 1 : 0;
      }
      const evilRange = c.evilRange;         // placed by surface-biomes
      const spawnX = c.spawnX;               // chosen by decor
      const walls = c.walls;                 // repaired in 13a, stamped in 13e
      // Structural wall jobs pushed by caves/structures/micro-biomes win over
      // column walls.
      const wallJobs = c.wallJobs;
      const stats = c.stats = {
        invalidTiles: 0, invalidWalls: 0, bedrockFixes: 0,
        spawnLiquidCleared: 0, spawnGroundPatched: 0, landmarks: {}
      };

      // ---- 13a. repair out-of-range ids + landmark census ----
      const nT = DEFS.length, nW = WALL_DEFS ? WALL_DEFS.length : 256;
      let dgBrick = 0, hellBrick = 0, sandBrick = 0, chests = 0;
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (t >= nT) { tiles[i] = T.AIR; stats.invalidTiles++; continue; }
        if (t === T.DUNGEON_BRICK) dgBrick++;
        else if (t === T.HELL_BRICK) hellBrick++;
        else if (t === T.SANDSTONE_BRICK) sandBrick++;
        else if (t === T.CHEST) chests++;
      }
      for (let i = 0; i < walls.length; i++) {
        if (walls[i] >= nW) { walls[i] = WALL.NONE; stats.invalidWalls++; }
      }
      stats.landmarks = {
        dungeonBrick: dgBrick, hellBrick: hellBrick,
        sandstoneBrick: sandBrick, chests: chests
      };

      // ---- 13b. bedrock floor integrity ----
      const BR = G.bedrockRows;
      for (let x = 0; x < W; x++) {
        for (let k = 0; k < BR; k++) {
          if (tiles[idx(x, H - 1 - k)] !== T.BEDROCK) {
            tiles[idx(x, H - 1 - k)] = T.BEDROCK;
            stats.bedrockFixes++;
          }
        }
      }

      // ---- 13c. spawn safety: dry the area, guarantee air-over-solid ----
      const sx = Math.max(3, Math.min(W - 4, spawnX));
      let g = -1;
      for (let y = 2; y < H - BR; y++) {
        if (SOLID[tiles[idx(sx, y)]]) { g = y; break; }
      }
      if (g < 0) g = G.baseSurface;
      for (let dx = -3; dx <= 3; dx++) {
        const x = sx + dx;
        for (let y = Math.max(1, g - 6), yEnd = Math.min(H - BR - 1, g + 6); y <= yEnd; y++) {
          const t2 = tiles[idx(x, y)];
          if (t2 === T.WATER || t2 === T.LAVA) {
            tiles[idx(x, y)] = T.AIR;
            stats.spawnLiquidCleared++;
          }
        }
        for (let y = Math.max(1, g - 6); y <= g - 1; y++) {
          if (tiles[idx(x, y)] !== T.BEDROCK) tiles[idx(x, y)] = T.AIR;
        }
        if (!SOLID[tiles[idx(x, g)]]) {
          let s2 = -1;
          for (let y = g + 1; y <= Math.min(H - BR - 1, g + 8); y++) {
            if (SOLID[tiles[idx(x, y)]]) { s2 = y; break; }
          }
          const fillTo = s2 > 0 ? s2 - 1 : g + 2;
          for (let y = g; y <= fillTo; y++) tiles[idx(x, y)] = T.DIRT;
          stats.spawnGroundPatched++;
        }
      }

      // ---- 13d. final surface scan + spawn row ----
      const surfaceY = c.surfaceY;
      for (let x = 0; x < W; x++) {
        let y = 0;
        while (y < H && !OPQ[tiles[idx(x, y)]]) y++;
        surfaceY[x] = y; // H when the column has no opaque tile
      }
      const spawnY = surfaceY[sx];

      // ---- 13e. background walls: dirt above the stone line, stone below ----
      // Ocean/evil columns carry their own backdrop; structural wallJobs
      // (dungeon, temples, pyramids, micro-biomes, shrines, ruins) are
      // stamped last, winning over columns.
      const isEvilCol = (x) => !!evilRange && x >= evilRange[0] && x < evilRange[1];
      for (let x = 0; x < W; x++) {
        const st = stoneTop[x];
        const oc = inOceanX(x);
        const ev = isEvilCol(x);
        const start = oc ? SEA : surfaceY[x] + 2; // oceans wall up from sea level
        for (let y = Math.max(0, start); y < H; y++) {
          if (ev) walls[idx(x, y)] = WALL.EBON;
          else if (oc) walls[idx(x, y)] = y < st ? WALL.SAND : WALL.STONE;
          else walls[idx(x, y)] = y < st ? WALL.DIRT : WALL.STONE;
        }
      }
      for (const job of wallJobs) {
        for (let y = Math.max(0, job.y0); y <= Math.min(H - 1, job.y1); y++) {
          for (let x = Math.max(0, job.x0); x <= Math.min(W - 1, job.x1); x++) {
            walls[idx(x, y)] = job.w;
          }
        }
      }
      c.spawnY = surfaceY[sx];             // spawn row from the final scan
    }
  })();

/* worldgen.js — deterministic procedural world generation. Owns TC.WorldGen.
   Expands the classic pipeline with edge oceans (beach slope + water volume),
   overhauled deserts (cactus scrub + buried pyramids), a corruption/crimson
   evil strip (ebonstone/shadewood), a surface dungeon, and furnished hell
   temples. Extension tile/wall/item ids are appended to the shared tables at
   load time (see extendTables below) — promote them into constants.js if
   those ids are ever formalized there. */
'use strict';
(function () {
  const TC = window.TC;

  // ------------------------------------------------------------------
  // Extension tables. New ids continue the lead-owned constants.js
  // numbering. Every consumer (tiles.js, lighting.js, minimap.js,
  // items.js, save.js) is data-driven from these tables, so appended
  // entries render, mine, light and save exactly like native ones.
  // Guards make this idempotent and forward-compatible: if constants.js
  // later defines a key, its id wins and nothing is duplicated here.
  // ------------------------------------------------------------------
  (function extendTables() {
    if (!TC.TILE || !TC.TILE_DEFS) return;   // constants.js missing; bail out
    let nextTile = TC.TILE_DEFS.length;
    const addTile = (key, def) => {
      if (TC.TILE[key] == null) {
        TC.TILE[key] = nextTile++;
        TC.TILE_DEFS.push(def);
      }
    };
    addTile('CACTUS',          { name: 'cactus',           hardness: 0.3,  tool: 'any',  drop: 'cactus',          pattern: 'leafy',  needsSupport: 'below', colors: ['#3f8f43', '#35793a', '#4da04f'] });
    addTile('EBONSTONE',       { name: 'ebonstone',        solid: true, opaque: true, hardness: 0.6,  tool: 'pick', drop: 'ebonstone',       pattern: 'speckle', colors: ['#565064', '#484254', '#645e72'] });
    addTile('CRIMSTONE',       { name: 'crimstone',        solid: true, opaque: true, hardness: 0.6,  tool: 'pick', drop: 'crimstone',       pattern: 'speckle', colors: ['#6e4646', '#5e3a3a', '#7e5252'] });
    addTile('EBONGRASS',       { name: 'corrupt grass',    solid: true, opaque: true, hardness: 0.3,  tool: 'pick', drop: 'dirt',            pattern: 'grass',   colors: ['#4e4254', '#8a5cba'] });
    addTile('SHADEWOOD',       { name: 'shadewood',        solid: true, opaque: true, hardness: 0.35, tool: 'any',  drop: 'shadewood',       pattern: 'plank',   colors: ['#4a3550', '#372740'] });
    addTile('DUNGEON_BRICK',   { name: 'dungeon brick',    solid: true, opaque: true, hardness: 0.55, tool: 'pick', drop: 'dungeon_brick',   pattern: 'plank',   colors: ['#4e5f7d', '#3c4a63'] });
    addTile('HELL_BRICK',      { name: 'hell brick',       solid: true, opaque: true, hardness: 0.55, tool: 'pick', drop: 'hell_brick',      pattern: 'plank',   colors: ['#66302a', '#4e241f'] });
    addTile('SANDSTONE_BRICK', { name: 'sandstone brick',  solid: true, opaque: true, hardness: 0.4,  tool: 'pick', drop: 'sandstone_brick', pattern: 'plank',   colors: ['#c9ae6e', '#ad9257'] });

    if (TC.WALL && TC.WALL_DEFS) {
      let nextWall = TC.WALL_DEFS.length;
      const addWall = (key, def) => {
        if (TC.WALL[key] == null) {
          TC.WALL[key] = nextWall++;
          TC.WALL_DEFS.push(def);
        }
      };
      addWall('SAND',    { name: 'sand wall',       color: '#b09a58', hardness: 0.25 });
      addWall('EBON',    { name: 'ebonstone wall',  color: '#3a3444', hardness: 0.4 });
      addWall('DUNGEON', { name: 'dungeon wall',    color: '#333f54', hardness: 0.45 });
      addWall('HELL',    { name: 'hell brick wall', color: '#401d18', hardness: 0.45 });
    }

    if (!TC.ITEM_DEFS) TC.ITEM_DEFS = {};
    const addItem = (id, name, tile) => {
      if (!TC.ITEM_DEFS[id]) TC.ITEM_DEFS[id] = { name: name, kind: 'block', maxStack: 999, tile: tile };
    };
    addItem('cactus', 'Cactus', TC.TILE.CACTUS);
    addItem('ebonstone', 'Ebonstone Block', TC.TILE.EBONSTONE);
    addItem('crimstone', 'Crimstone Block', TC.TILE.CRIMSTONE);
    addItem('shadewood', 'Shadewood Block', TC.TILE.SHADEWOOD);
    addItem('dungeon_brick', 'Dungeon Brick', TC.TILE.DUNGEON_BRICK);
    addItem('hell_brick', 'Hell Brick', TC.TILE.HELL_BRICK);
    addItem('sandstone_brick', 'Sandstone Brick', TC.TILE.SANDSTONE_BRICK);
  })();

  TC.WorldGen = {

    // Fully deterministic from seed: seeded RNG + seeded noise only, no Math.random.
    generate(seed) {
      const U = TC.Utils;
      if (!U || typeof U.mulberry32 !== 'function' || typeof U.Noise2D !== 'function' || !TC.WALL) {
        throw new Error('WorldGen.generate requires TC.Utils (mulberry32, Noise2D) and TC.WALL');
      }
      const C = TC.CONST, G = C.GEN, T = TC.TILE, DEFS = TC.TILE_DEFS, WALL = TC.WALL;
      const W = C.WORLD_W, H = C.WORLD_H, BR = G.bedrockRows;
      const Y_TOP = 1, Y_BOT = H - BR - 1;   // rows open to carving
      const rng = U.mulberry32(seed | 0);

      const surfN = new U.Noise2D(seed | 0);
      const caveN = new U.Noise2D((seed ^ 0x5bd1e995) | 0);
      const underN = new U.Noise2D((seed ^ 0xA5A5A5) | 0);
      const oceanN = new U.Noise2D((seed ^ 0x1F123BB5) | 0);

      const tiles = new Uint8Array(W * H);
      const hSurf = new Int16Array(W);    // heightmap: row of the ground tile
      const stoneTop = new Int16Array(W); // first stone row per column

      const idx = (x, y) => y * W + x;
      const inB = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
      const ri = (n) => (rng() * n) | 0;  // int in [0, n)

      // opaque/solid LUTs from tile defs
      const OPQ = new Uint8Array(DEFS.length), SOLID = new Uint8Array(DEFS.length);
      for (let i = 0; i < DEFS.length; i++) {
        OPQ[i] = DEFS[i].opaque ? 1 : 0;
        SOLID[i] = DEFS[i].solid ? 1 : 0;
      }

      // Expansion tuning (candidates for CONST.GEN; kept here to avoid edits
      // to lead-owned constants.js).
      const XG = {
        ocean:  { width: 110, beach: 26, seaLevelOff: 6, deepMin: 10, deepVar: 12, floodDepth: 48 },
        cactus: { spacing: 4, chance: 0.6, hMin: 2, hVar: 3 },
        pyramid:{ chance: 0.8, baseMin: 20, baseVar: 12 },
        evil:   { widthMin: 70, widthVar: 60, chasms: 3, chasmRad: 2.6, veins: 80, veinSize: 5 },
        dungeon:{ roomW: 15, roomH: 9, rooms: 4 },
        hell:   { temples: 3, tW: 23, tH: 13, lavaPoolsDeep: 14 }
      };

      // Rects that get a matching background wall after the terrain pass.
      const wallJobs = [];

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

      // ---- 3. deserts: sand down to stone ----
      const deserts = [];
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
      const biomes = [];
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

      // ---- 6. ore veins (replace STONE only, inside depth windows) ----
      const oreKinds = [['copper', T.COPPER_ORE], ['iron', T.IRON_ORE], ['gold', T.GOLD_ORE]];
      for (const pair of oreKinds) {
        const key = pair[0], id = pair[1];
        const o = G.ores[key];
        const abs = o.minYAbs != null;
        for (let v = 0; v < o.veins; v++) {
          const x = 2 + ri(W - 4);
          let yLo, yHi;
          if (abs) { yLo = o.minYAbs; yHi = Math.min(o.maxYAbs, Y_BOT); }
          else { yLo = hSurf[x] + o.minYOff; yHi = Math.min(hSurf[x] + o.maxYOff, Y_BOT); }
          if (yHi <= yLo) continue;
          let vx = x, vy = yLo + ri(yHi - yLo);
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

      // ---- 13. final surface scan + spawn row ----
      const surfaceY = new Int16Array(W);
      for (let x = 0; x < W; x++) {
        let y = 0;
        while (y < H && !OPQ[tiles[idx(x, y)]]) y++;
        surfaceY[x] = y; // H when the column has no opaque tile
      }
      const spawnY = surfaceY[spawnX];

      // ---- 14. background walls: dirt above the stone line, stone below ----
      // Ocean/evil columns carry their own backdrop; structural wallJobs
      // (dungeon, temples, pyramids) are stamped last, winning over columns.
      const walls = new Uint8Array(W * H);
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

      return { width: W, height: H, tiles: tiles, walls: walls, surfaceY: surfaceY, spawnX: spawnX, spawnY: spawnY };
    }
  };
})();

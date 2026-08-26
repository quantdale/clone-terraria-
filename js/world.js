/* world.js — tile world container: edits, support-pop rules, mining damage
   (tiles + background walls), hammer shapes + paint slots (parallel state
   layers), furniture open/close toggling, wire actuation hooks, flowing
   water (active-set cellular sim), chunked rendering. Owns the authoritative
   tile and wall grids built by WorldGen. */
"use strict";
(function () {
  const TC = window.TC;
  const TS = TC.CONST.TS;
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  // ---- tile shape vocabulary (PHY-001 / roadmap M3.1) ----
  // Shape metadata is a parallel layer beside tile content (this.shapes), so
  // tile ids stay plain for lighting/minimap. Local coords lx/ly are fractions
  // of one tile, x grows east, y grows down (ly=0 top edge, ly=1 bottom edge).
  // Slopes are named for the corner holding their right angle:
  //   SLOPE_NE solid {(0,0),(1,0),(1,1)}  hypotenuse "\"  walkable top ly = lx
  //   SLOPE_NW solid {(0,0),(1,0),(0,1)}  hypotenuse "/"  walkable top ly = 1-lx
  //   SLOPE_SE solid {(1,0),(0,1),(1,1)}  hypotenuse "/"  walkable top ly = 1-lx
  //   SLOPE_SW solid {(0,0),(0,1),(1,1)}  hypotenuse "\"  walkable top ly = lx
  // SE/SW sit on the ground (solid below their hypotenuse); NE/NW hug the
  // ceiling side and exist for corner smoothing.
  const SHAPES = {
    FULL: 0,
    PLATFORM: 1,
    HALF: 2,
    SLOPE_NE: 3,
    SLOPE_NW: 4,
    SLOPE_SE: 5,
    SLOPE_SW: 6,

    // Is the point at local fraction (lx, ly) inside solid matter?
    // PLATFORM never blocks here — it is one-way, see World.shapeSolidQuery.
    solidAt(shape, lx, ly) {
      switch (shape) {
        case 2:
          return ly >= 0.5; // HALF: lower half only
        case 3:
          return ly <= lx; // SLOPE_NE
        case 4:
          return lx + ly <= 1; // SLOPE_NW
        case 5:
          return lx + ly >= 1; // SLOPE_SE
        case 6:
          return ly >= lx; // SLOPE_SW
        default:
          return shape === 0; // FULL yes, PLATFORM no
      }
    },

    // Height fraction of the walkable top at local x (slopes vary with lx,
    // default midpoint when omitted).
    topSurfaceY(shape, lx) {
      if (lx == null) lx = 0.5;
      switch (shape) {
        case 5:
          return 1 - lx; // SLOPE_SE rises eastward
        case 6:
          return lx; // SLOPE_SW falls eastward
        default:
          return shape === 2 ? 0.5 : 0; // HALF mid, others flat top
      }
    },

    blocksMovement(shape) {
      return shape !== 1;
    }, // PLATFORM is pass-through

    // Unit-space render descriptor: polygon vertices the renderer clips to.
    // FULL needs no clip -> poly null.
    renderPath(shape) {
      switch (shape) {
        case 1:
          return {
            kind: "platform",
            poly: [
              [0, 5 / 16],
              [1, 5 / 16],
              [1, 8 / 16],
              [0, 8 / 16],
            ],
          };
        case 2:
          return {
            kind: "half",
            poly: [
              [0, 0.5],
              [1, 0.5],
              [1, 1],
              [0, 1],
            ],
          };
        case 3:
          return {
            kind: "slope",
            poly: [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
          };
        case 4:
          return {
            kind: "slope",
            poly: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
          };
        case 5:
          return {
            kind: "slope",
            poly: [
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          };
        case 6:
          return {
            kind: "slope",
            poly: [
              [0, 0],
              [1, 1],
              [0, 1],
            ],
          };
        default:
          return { kind: "full", poly: null };
      }
    },
  };
  TC.Shapes = SHAPES;

  // ---- flowing water ----
  // REMOVED (W1 liquid migration): the legacy WATER-tile active-set mover
  // lived here. TC.Liquids is now the single runtime liquid authority — every
  // world is imported into its volume layer at build time and these tile ids
  // never simulate. Edits wake the layer via TC.Liquids.wake below; solid
  // placements displace layer liquid through TC.Liquids.displace.

  // Open/closed furniture pairs: closed tile id -> open tile id and back.
  // Doors register here; new two-state furniture adds one line each way.
  let furnPairsCache = null;
  function furnPairs() {
    if (furnPairsCache) return furnPairsCache;
    const m = new Map();
    const T = TC.TILE;
    if (T.DOOR_CLOSED != null && T.DOOR_OPEN != null) {
      m.set(T.DOOR_CLOSED, T.DOOR_OPEN);
      m.set(T.DOOR_OPEN, T.DOOR_CLOSED);
    }
    furnPairsCache = m;
    return m;
  }

  class World {
    constructor(gen) {
      this.width = gen.width;
      this.height = gen.height;
      this.tiles = gen.tiles; // Uint8Array of tile ids, row-major
      this.surfaceY = gen.surfaceY; // Int16Array, first solid tile per column
      this.walls = gen.walls || new Uint8Array(this.width * this.height); // wall ids, row-major
      this.damage = new Map(); // tileIndex -> mining progress 0..1
      this.wallDamage = new Map(); // tileIndex -> wall mining progress 0..1
      this.shapes = new Uint8Array(this.width * this.height); // hammer shape per tile (TC.Shapes)
      this.paints = new Map(); // tileIndex -> paint slot (compatibility stub)
      this.CHUNK = 32; // chunk size in tiles (shared with TC.WorldRegions)
      this.chunksX = Math.ceil(this.width / this.CHUNK);
      this.chunksY = Math.ceil(this.height / this.CHUNK);
      this.chunks = new Map(); // chunkKey -> { cv, ctx } canvas cache (bounded, see evictFarChunks)
      // W21: dirty tracking is OWNED by TC.WorldRegions (PERF-004). This
      // renderer is just one consumer of the shared revision authority; its
      // legacy private Set is gone so lighting/minimap/persistence observe
      // invalidations independently. Bind first, then flag every region so
      // the first frames rebuild what the camera needs.
      this._regions = null;
      if (TC.WorldRegions && typeof TC.WorldRegions.init === "function") {
        TC.WorldRegions.init(this);
        this._regions = TC.WorldRegions.consume("renderer");
      }
      this._rstats = {
        rebuilt: 0,
        maxBacklog: 0,
        skipped: 0,
        lastBudgetUsed: 0,
        liquidOnly: 0,
      };
      if (!this._regions) this.markAllDirty();
    }

    // ---- grid helpers ----
    idx(x, y) {
      return y * this.width + x;
    }
    inB(x, y) {
      return x >= 0 && y >= 0 && x < this.width && y < this.height;
    }
    get(x, y) {
      return this.inB(x, y) ? this.tiles[this.idx(x, y)] : TC.TILE.BEDROCK;
    }
    // Movement solidity for CURRENT physics: only full-solid tile defs block.
    // Shape metadata does NOT participate here — HALF/slopes/platforms keep
    // old behaviour until player.js migrates to World.shapeSolidQuery.
    isSolid(x, y) {
      if (!TC.TILE_DEFS[this.get(x, y)].solid) return false;
      return !(
        TC.Wiring &&
        typeof TC.Wiring.isGhost === "function" &&
        TC.Wiring.isGhost(x, y)
      );
    }
    solidAtPixel(px, py) {
      return this.isSolid(Math.floor(px / TS), Math.floor(py / TS));
    }
    opaqueAt(x, y) {
      return TC.TILE_DEFS[this.get(x, y)].opaque;
    }

    // ---- editing ----
    // Full edit path: write, rescan surface, dirty chunks, relight, support-pop.
    set(x, y, id) {
      if (!this.inB(x, y)) return;
      const i = this.idx(x, y);
      const prevId = this.tiles[i];
      this.tiles[i] = id;
      this.damage.delete(i); // a rewritten tile loses its crack state
      this.shapes[i] = 0; // ...and any hammer shape / paint on it
      this.paints.delete(i);
      // A solid/opaque placement buries any layer liquid in the cell.
      if (
        id !== TC.TILE.AIR &&
        TC.TILE_DEFS[id].solid &&
        TC.Liquids &&
        typeof TC.Liquids.displace === "function"
      ) {
        try {
          TC.Liquids.displace(x, y);
        } catch (e) {}
      }
      if (prevId === TC.TILE.WATER || prevId === TC.TILE.LAVA) {
        // Overwriting a legacy liquid tile by hand claims nothing — clear the
        // layer cell too so the invariant can never break from this side.
        if (TC.Liquids && typeof TC.Liquids.displace === "function") {
          try {
            TC.Liquids.displace(x, y);
          } catch (e) {}
        }
      }
      this.rescanSurface(x);
      this.markDirtyAt(x, y, "tile");
      if (TC.Lighting) TC.Lighting.onTileChanged(x, y);
      this.checkSupport(x, y);
      if (TC.Liquids && typeof TC.Liquids.wake === "function") {
        try {
          TC.Liquids.wake(x, y);
        } catch (e) {}
      }
      if (TC.Events) {
        try {
          TC.Events.emit(TC.Events.EVENT.TileChanged, { tx: x, ty: y, id: id });
        } catch (e) {}
      }
    }

    // Raw write for save-load and tree felling: no rescan/relight/pops.
    // Regions still invalidate ('bulk') so presentation catches up.
    setRaw(x, y, id) {
      if (!this.inB(x, y)) return;
      const i = this.idx(x, y);
      this.tiles[i] = id;
      this.damage.delete(i);
      this.shapes[i] = 0; // a rewritten tile loses shape/paint state
      this.paints.delete(i);
      this.markDirtyAt(x, y, "bulk");
      // Tree felling / bulk writes can open cells under liquid — wake the
      // layer around the change so pools react on the next settle step.
      if (id === TC.TILE.AIR && TC.Liquids && typeof TC.Liquids.wake === "function") {
        try {
          TC.Liquids.wake(x, y);
        } catch (e) {}
      }
      if (TC.Events) {
        try {
          TC.Events.emit(TC.Events.EVENT.TileChanged, { tx: x, ty: y, id: id });
        } catch (e) {}
      }
    }

    // First solid tile per column (== height when the column is all air).
    rescanSurface(x) {
      let y = 0;
      while (y < this.height && !TC.TILE_DEFS[this.tiles[this.idx(x, y)]].solid)
        y++;
      this.surfaceY[x] = y;
    }

    // Pop neighbours that lost their anchor after the tile at (x, y) changed.
    checkSupport(x, y) {
      const ay = y - 1;
      if (
        this.inB(x, ay) &&
        TC.TILE_DEFS[this.tiles[this.idx(x, ay)]].needsSupport === "below" &&
        !this.isSolid(x, y)
      ) {
        this.popTile(x, ay); // set(AIR) inside re-runs this check upward
      }
      // Free-standing tiles (torches): need at least one non-air orthogonal
      // neighbour to hang on.
      for (let k = 0; k < 4; k++) {
        const nx = x + DIRS[k][0],
          ny = y + DIRS[k][1];
        if (!this.inB(nx, ny)) continue;
        const def = TC.TILE_DEFS[this.tiles[this.idx(nx, ny)]];
        if (def.needsSupport === "any" && !this.hasOrthoTile(nx, ny)) {
          this.popTile(nx, ny);
        }
      }
    }

    hasOrthoTile(x, y) {
      return (
        this.get(x + 1, y) !== TC.TILE.AIR ||
        this.get(x - 1, y) !== TC.TILE.AIR ||
        this.get(x, y + 1) !== TC.TILE.AIR ||
        this.get(x, y - 1) !== TC.TILE.AIR
      );
    }

    // Remove a tile, dropping its item; goes through set() so cascades propagate.
    popTile(x, y) {
      const def = TC.TILE_DEFS[this.get(x, y)];
      if (def.drop && TC.Items) {
        TC.Items.spawnDrop((x + 0.5) * TS, (y + 0.5) * TS, def.drop, 1);
      }
      this.set(x, y, TC.TILE.AIR);
    }

    // ---- mining damage ----
    // Adds mining progress; returns true once the tile accumulates >= 1
    // (the entry is cleared so the caller can break it).
    applyMineDamage(tx, ty, amt) {
      if (!this.inB(tx, ty)) return false;
      const i = this.idx(tx, ty);
      const d = (this.damage.get(i) || 0) + amt;
      if (d >= 1) {
        this.damage.delete(i);
        return true;
      }
      this.damage.set(i, d);
      return false;
    }

    clearDamage(tx, ty) {
      this.damage.delete(this.idx(tx, ty));
    }

    // ---- background walls ----
    getWall(x, y) {
      return this.inB(x, y) ? this.walls[this.idx(x, y)] : TC.WALL.NONE;
    }

    // Full edit path for walls: write, dirty chunks, relight.
    setWall(x, y, id) {
      if (!this.inB(x, y)) return;
      const i = this.idx(x, y);
      this.walls[i] = id;
      this.wallDamage.delete(i); // a rewritten wall loses its crack state
      this.markDirtyAt(x, y, "wall");
      if (TC.Lighting) TC.Lighting.onTileChanged(x, y);
    }

    // Raw write for save-load: write + dirty chunks only.
    setRawWall(x, y, id) {
      if (!this.inB(x, y)) return;
      this.walls[this.idx(x, y)] = id;
      this.markDirtyAt(x, y, "bulk");
    }

    // Adds wall mining progress; returns true once the wall accumulates >= 1
    // (the entry is cleared so the caller can break it).
    applyWallDamage(tx, ty, amt) {
      if (!this.inB(tx, ty)) return false;
      const i = this.idx(tx, ty);
      const d = (this.wallDamage.get(i) || 0) + amt;
      if (d >= 1) {
        this.wallDamage.delete(i);
        return true;
      }
      this.wallDamage.set(i, d);
      return false;
    }

    clearWallDamage(tx, ty) {
      this.wallDamage.delete(this.idx(tx, ty));
    }

    // ---- hammer shapes / paint / actuation ----
    // Hammer state lives in a parallel layer (this.shapes) rather than in the
    // tile ids: lighting.js and minimap.js read the raw tiles array, so ids
    // must stay plain. Shapes are session-only until Save adopts the
    // serializeShapes/loadShapes hooks below.
    shapeAt(x, y) {
      const s = this.inB(x, y) ? this.shapes[this.idx(x, y)] : 0;
      if (s === 7) return SHAPES.FULL; // sentinel: explicit FULL over a defaultShape
      if (s) return s;
      const def = TC.TILE_DEFS[this.get(x, y)];
      return (def && def.defaultShape) || 0; // e.g. PLATFORM tiles default to shaped
    }

    // Shape write: dirty chunk + crack reset, no event (set() owns TileChanged).
    setShape(x, y, s) {
      if (!this.inB(x, y)) return false;
      const i = this.idx(x, y);
      s = (s | 0) & 7;
      if (this.shapes[i] === s) return false;
      this.shapes[i] = s;
      this.damage.delete(i); // reshaping clears mining progress
      this.markDirtyAt(x, y, "shape");
      return true;
    }

    // May a hammer act on this tile? Rejects air/liquids/bedrock and anything
    // support-anchored: plants, torches, chests, doors, crafting stations.
    canShape(x, y) {
      if (!this.inB(x, y)) return false;
      const id = this.tiles[this.idx(x, y)];
      const def = TC.TILE_DEFS[id];
      if (!def) return false;
      if (id === TC.TILE.AIR) return false;
      if (def.needsSupport || def.replaceable) return false;
      if (!def.hammerable && !def.solid) return false;
      if (def.hardness >= 9999) return false; // unmineable blocks stay whole
      return !(
        TC.Wiring &&
        typeof TC.Wiring.isGhost === "function" &&
        TC.Wiring.isGhost(x, y)
      );
    }

    // May a hammer act on this tile? Rejects air/liquids/bedrock and support-
    // anchored decor or furniture (plants, torches, chests, doors, stations);
    // platforms pass despite their 'any' anchor because they are hammerable.
    canShape(x, y) {
      if (!this.inB(x, y)) return false;
      const id = this.tiles[this.idx(x, y)];
      const def = TC.TILE_DEFS[id];
      if (!def) return false;
      if (id === TC.TILE.AIR) return false;
      if (def.replaceable) return false;
      if (!def.hammerable && !def.solid) return false;
      if (def.needsSupport === "below") return false;
      if (def.hardness >= 9999) return false; // unmineable blocks stay whole
      return !(
        TC.Wiring &&
        typeof TC.Wiring.isGhost === "function" &&
        TC.Wiring.isGhost(x, y)
      );
    }

    // Movement query shim for the player physics port (M3.2). dy is the
    // sample's pixel depth below the tile top; fromAbove says the mover
    // approaches the top face. PLATFORM-shaped tiles land only from above,
    // whether their def is solid or not. Slope solidity uses the mid-tile
    // surface until swept collision passes exact local x.
    shapeSolidQuery(tx, ty, fromAbove, dy) {
      const out = { solid: false, platform: false };
      if (
        TC.Wiring &&
        typeof TC.Wiring.isGhost === "function" &&
        TC.Wiring.isGhost(tx, ty)
      )
        return out;
      const s = this.shapeAt(tx, ty);
      if (s === SHAPES.PLATFORM) {
        out.platform = true;
        out.solid = !!fromAbove; // land on it, never blocked from below
        return out;
      }
      const def = TC.TILE_DEFS[this.get(tx, ty)];
      if (!def.solid) return out;
      if (s === SHAPES.FULL) {
        out.solid = true;
        return out;
      }
      const d = dy == null ? 0 : dy;
      if (s === SHAPES.HALF) out.solid = d >= TS / 2;
      else out.solid = d >= SHAPES.topSurfaceY(s) * TS;
      return out;
    }

    // Hammer tool hook: shapes the hit tile. nextShape (optional) forces an
    // exact TC.Shapes id; otherwise cycles FULL -> PLATFORM -> HALF ->
    // SLOPE_NE -> NW -> SE -> SW -> FULL for terrain, or flips platform decks
    // between deck and full-block states (stored 7 = explicit FULL, since a
    // plain 0 would read back as the tile's default shape). Returns true when
    // something changed so callers can fall back to mining when false.
    // Player integration: route held items whose def.tool === 'hammer' here
    // instead of doMine.
    hammer(tx, ty, nextShape) {
      if (!this.canShape(tx, ty)) return false;
      const def = TC.TILE_DEFS[this.get(tx, ty)];
      if (nextShape != null) return this.setShape(tx, ty, nextShape);
      if (def.hammerable) {
        // platform decks toggle, never slope
        return this.setShape(
          tx,
          ty,
          this.shapes[this.idx(tx, ty)] === 7 ? SHAPES.PLATFORM : 7,
        );
      }
      const cur = this.shapeAt(tx, ty);
      const next = cur >= SHAPES.SLOPE_SW ? SHAPES.FULL : cur + 1;
      return this.setShape(tx, ty, next);
    }

    // Paint compatibility stub: stores a paint slot per position; chunk
    // rendering forwards it to TC.Tiles.drawTile, whose tint table is empty
    // until paint items ship. Slot 0 (or <=0) clears.
    getPaint(x, y) {
      return this.inB(x, y) ? this.paints.get(this.idx(x, y)) || 0 : 0;
    }

    setPaint(x, y, c) {
      if (!this.inB(x, y)) return false;
      const i = this.idx(x, y);
      c = c | 0;
      if (c > 0) this.paints.set(i, c);
      else this.paints.delete(i);
      this.markDirtyAt(x, y, "paint");
      return true;
    }

    // Flip a two-state furniture tile (doors). Goes through set() so support
    // pops and relighting run. Returns true when the tile toggled.
    toggleFurniture(x, y) {
      const next = furnPairs().get(this.get(x, y));
      if (next == null) return false;
      this.set(x, y, next);
      return true;
    }

    // Wire-capable actuation entry point for a future wiring module: flips an
    // actuable tile's state — furniture open/close, platform ramp toggle.
    // Call from the wire-tick path per powered tile, or use actuateRegion.
    actuate(x, y) {
      if (!this.inB(x, y)) return false;
      if (this.toggleFurniture(x, y)) return true;
      const def = TC.TILE_DEFS[this.get(x, y)];
      if (def && def.hammerable) {
        // platforms respond to wires too
        return this.setShape(
          x,
          y,
          this.shapes[this.idx(x, y)] === 7 ? SHAPES.PLATFORM : 7,
        );
      }
      return false;
    }

    actuateRegion(x0, y0, x1, y1) {
      let n = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (this.actuate(x, y)) n++;
        }
      }
      return n;
    }

    // Sparse [tileIndex, value] snapshots for save.js to adopt; shapes/paints
    // are not persisted until that module calls these.
    serializeShapes() {
      const out = [];
      for (let i = 0; i < this.shapes.length; i++) {
        if (this.shapes[i]) out.push([i, this.shapes[i]]);
      }
      return out;
    }

    loadShapes(list) {
      if (!Array.isArray(list)) return;
      for (let k = 0; k < list.length; k++) {
        const e = list[k];
        if (Array.isArray(e) && e[0] >= 0 && e[0] < this.shapes.length) {
          this.shapes[e[0]] = (e[1] | 0) & 7;
          this.markDirtyAt(e[0] % this.width, (e[0] / this.width) | 0);
        }
      }
    }

    serializePaints() {
      const out = [];
      for (const entry of this.paints) out.push([entry[0], entry[1]]);
      return out;
    }

    loadPaints(list) {
      if (!Array.isArray(list)) return;
      for (let k = 0; k < list.length; k++) {
        const e = list[k];
        if (
          Array.isArray(e) &&
          e[0] >= 0 &&
          e[0] < this.shapes.length &&
          (e[1] | 0) > 0
        ) {
          this.paints.set(e[0], e[1] | 0);
          this.markDirtyAt(e[0] % this.width, (e[0] / this.width) | 0);
        }
      }
    }

    // ---- flowing water ----
    // (legacy tile-water sim removed — see module comment near the top of
    // this class's file section; TC.Liquids owns all runtime liquid)

    // Water-sim write kept for TC.Liquids' water+lava -> stone contact and
    // other raw internal writes: dirty chunks only. No rescan/relight/
    // support-pop/drops and no seeding.
    rawSetTile(x, y, id) {
      const i = this.idx(x, y);
      this.tiles[i] = id;
      this.damage.delete(i);
      this.shapes[i] = 0; // a rewritten tile loses shape/paint state
      this.paints.delete(i);
      this.markDirtyAt(x, y, "tile");
    }

    // ---- chunk rendering ----
    // W21: all marking delegates to TC.WorldRegions (shared multi-consumer
    // revision authority). Reasons classify the change kind for stats and
    // future replication consumers.
    markAllDirty() {
      if (TC.WorldRegions && typeof TC.WorldRegions.markAll === "function") {
        TC.WorldRegions.markAll("bulk");
      }
    }

    // Mark the chunk holding (x, y); border tiles also dirty the adjacent
    // chunk because tile edge masks read across the boundary. The fan-out
    // rule lives in WorldRegions.markTile.
    markDirtyAt(x, y, reason) {
      if (TC.WorldRegions && typeof TC.WorldRegions.markTile === "function") {
        TC.WorldRegions.markTile(x, y, reason || "tile");
      }
    }

    // Rebuild up to 3 dirty chunks per frame, nearest the camera first.
    // Dirty state comes from THIS consumer's cursor into the shared region
    // authority — draining it never hides invalidations from lighting,
    // minimap or any other consumer (W21 PERF-004/VIS-002).
    //
    // PERF: regions whose pending kinds are liquid-only are observed and
    // skipped — chunk canvases hold walls+tiles only; liquid renders live
    // through TC.Liquids.draw each frame (and the minimap keeps its own
    // consumer). Without this, settling pools force max-budget chunk
    // rebuilds every tick even while nothing visual changes here.
    update(dt) {
      const cons = this._regions;
      if (!cons || !TC.Tiles) return;
      const BUDGET = 3;
      const backlog = cons.pendingCount();
      if (backlog > this._rstats.maxBacklog)
        this._rstats.maxBacklog = backlog;
      if (backlog === 0) {
        this._rstats.skipped++;
        this._rstats.lastBudgetUsed = 0;
        return;
      }
      const span = this.CHUNK * TS;
      const cam = TC.camera;
      let order = cons.dirtyRegions();
      const LIQ = TC.WorldRegions ? TC.WorldRegions.LIQUID_BIT : 0;
      if (LIQ && typeof cons.pendingKinds === "function" && order.length) {
        let kept = 0;
        for (let i = 0; i < order.length; i++) {
          const idx = order[i];
          if ((cons.pendingKinds(idx) & ~LIQ) === 0) {
            cons.observe(idx); // handled: nothing to repaint in chunk canvases
            this._rstats.liquidOnly++;
          } else {
            order[kept++] = idx;
          }
        }
        order.length = kept;
      }
      if (cam && order.length > BUDGET) {
        const cxc = cam.x / span,
          cyc = cam.y / span;
        const d2 = (key) => {
          const dx = (key % this.chunksX) * this.CHUNK + this.CHUNK / 2 - cxc;
          const dy = (((key / this.chunksX) | 0) * this.CHUNK) + this.CHUNK / 2 - cyc;
          return dx * dx + dy * dy;
        };
        order = order.slice().sort((a, b) => d2(a) - d2(b));
      }
      const n = Math.min(BUDGET, order.length);
      for (let i = 0; i < n; i++) {
        const key = order[i];
        cons.observe(key); // this consumer only — others stay stale
        this.rebuildChunk(key);
        this._rstats.rebuilt++;
      }
      this._rstats.lastBudgetUsed = n;
    }

    // MEMORY: chunk canvases are CHUNK*TS square (~1MB raster each at the
    // default sizes). Long sessions that travel widely used to retain every
    // chunk ever revealed (hundreds of MB). Keep a bounded cache: when over
    // capacity, drop farthest-from-camera chunks first (never ones currently
    // on screen). A dropped chunk whose area becomes visible again is rebuilt
    // synchronously by draw() — no other consumer is disturbed. Hysteresis
    // avoids thrash.
    evictFarChunks() {
      const CAP = 160;
      const FLOOR = 120;
      if (this.chunks.size <= CAP) return;
      const zoom = (TC.camera && TC.camera.zoom) || 1;
      const viewW = (TC.canvas ? TC.canvas.width : 960) / zoom;
      const viewH = (TC.canvas ? TC.canvas.height : 540) / zoom;
      const span = this.CHUNK * TS;
      const camX = TC.camera ? TC.camera.x : 0;
      const camY = TC.camera ? TC.camera.y : 0;
      const ccxPx = camX + viewW / 2; // camera centre, world px
      const ccyPx = camY + viewH / 2;
      const ccx = Math.floor(ccxPx / span); // centre chunk
      const ccy = Math.floor(ccyPx / span);
      const hw = Math.ceil(viewW / span / 2) + 1; // visible half-span (+margin)
      const vh = Math.ceil(viewH / span / 2) + 1;
      const cand = [];
      for (const key of this.chunks.keys()) {
        const cx = key % this.chunksX,
          cy = (key / this.chunksX) | 0;
        if (Math.abs(cx - ccx) <= hw && Math.abs(cy - ccy) <= vh) continue; // on screen
        const dx = cx + 0.5 - ccxPx / span;
        const dy = cy + 0.5 - ccyPx / span;
        cand.push([key, dx * dx + dy * dy]);
      }
      cand.sort((a, b) => b[1] - a[1]); // farthest first
      let target = FLOOR;
      for (let i = 0; i < cand.length && this.chunks.size > target; i++) {
        this.chunks.delete(cand[i][0]);
        this._rstats.evicted = (this._rstats.evicted || 0) + 1;
      }
    }

    // VIS-002 instrumentation: lifetime rebuilds, current/high-water dirty
    // backlog, idle skips, last-frame budget usage.
    regionStats() {
      return {
        rebuilt: this._rstats.rebuilt,
        backlog: this._regions ? this._regions.pendingCount() : 0,
        maxBacklog: this._rstats.maxBacklog,
        skippedCurrent: this._rstats.skipped,
        budgetPerFrame: 3,
        budgetUsedLastFrame: this._rstats.lastBudgetUsed,
        liquidOnlySkipped: this._rstats.liquidOnly || 0,
        chunkCacheSize: this.chunks.size,
        chunksEvicted: this._rstats.evicted || 0
      };
    }

    rebuildChunk(key) {
      const cx = key % this.chunksX,
        cy = (key / this.chunksX) | 0;
      let rec = this.chunks.get(key);
      if (!rec) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = this.CHUNK * TS;
        rec = { cv, ctx: cv.getContext("2d") };
        this.chunks.set(key, rec);
      }
      const c = rec.ctx;
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, rec.cv.width, rec.cv.height);
      const x0 = cx * this.CHUNK,
        y0 = cy * this.CHUNK;
      const x1 = Math.min(x0 + this.CHUNK, this.width);
      const y1 = Math.min(y0 + this.CHUNK, this.height);
      for (let ty = y0; ty < y1; ty++) {
        for (let tx = x0; tx < x1; tx++) {
          const i = this.idx(tx, ty);
          const wall = this.walls[i];
          if (wall !== TC.WALL.NONE && TC.Tiles.drawWall) {
            // walls render under tiles
            TC.Tiles.drawWall(
              c,
              wall,
              (tx - x0) * TS,
              (ty - y0) * TS,
              TS,
              tx,
              ty,
            );
          }
          const id = this.tiles[i];
          if (id === TC.TILE.AIR) continue;
          const mask =
            (this.opaqueAt(tx, ty - 1) ? 1 : 0) |
            (this.opaqueAt(tx + 1, ty) ? 2 : 0) |
            (this.opaqueAt(tx, ty + 1) ? 4 : 0) |
            (this.opaqueAt(tx - 1, ty) ? 8 : 0);
          // extra args (older tiles.js ignores them): hammer shape + paint slot
          TC.Tiles.drawTile(
            c,
            id,
            (tx - x0) * TS,
            (ty - y0) * TS,
            TS,
            tx,
            ty,
            mask,
            this.shapes[i],
            this.paints.get(i) || 0,
          );
        }
      }
    }

    // Called with the world-space camera transform already applied (main.js).
    draw(ctx, cam) {
      const span = this.CHUNK * TS;
      ctx.imageSmoothingEnabled = false;
      const viewW = ctx.canvas.width / cam.zoom;
      const viewH = ctx.canvas.height / cam.zoom;
      const cx0 = Math.max(0, Math.floor(cam.x / span));
      const cy0 = Math.max(0, Math.floor(cam.y / span));
      const cx1 = Math.min(
        this.chunksX - 1,
        Math.floor((cam.x + viewW) / span),
      );
      const cy1 = Math.min(
        this.chunksY - 1,
        Math.floor((cam.y + viewH) / span),
      );
      // PERF + correctness: a visible chunk whose canvas was evicted (or not
      // yet built) is rebuilt synchronously here — the visible set is small
      // and this is the only place a hole would actually show.
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cy * this.chunksX + cx;
          if (!this.chunks.has(key)) this.rebuildChunk(key);
          const rec = this.chunks.get(key);
          if (rec) ctx.drawImage(rec.cv, cx * span, cy * span);
        }
      }
      this.evictFarChunks();
      // Crack overlays for tiles and exposed walls currently being mined.
      if (TC.Tiles && (this.damage.size || this.wallDamage.size)) {
        const tx0 = Math.floor(cam.x / TS) - 1,
          ty0 = Math.floor(cam.y / TS) - 1;
        const tx1 = Math.ceil((cam.x + viewW) / TS) + 1;
        const ty1 = Math.ceil((cam.y + viewH) / TS) + 1;
        for (const entry of this.damage) {
          const i = entry[0],
            d = entry[1];
          const tx = i % this.width,
            ty = (i / this.width) | 0;
          if (tx < tx0 || tx > tx1 || ty < ty0 || ty > ty1) continue;
          TC.Tiles.drawCracks(
            ctx,
            tx * TS,
            ty * TS,
            TS,
            Math.min(3, Math.floor(d * 4)),
          );
        }
        for (const entry of this.wallDamage) {
          const i = entry[0],
            d = entry[1];
          const tx = i % this.width,
            ty = (i / this.width) | 0;
          if (tx < tx0 || tx > tx1 || ty < ty0 || ty > ty1) continue;
          if (this.tiles[i] !== TC.TILE.AIR || !this.walls[i]) continue; // hidden behind a tile
          TC.Tiles.drawCracks(
            ctx,
            tx * TS,
            ty * TS,
            TS,
            Math.min(3, Math.floor(d * 4)),
          );
        }
      }
    }
  }

  TC.World = World;
})();

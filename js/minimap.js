/* minimap.js — offscreen 1px-per-tile world map drawn as a top-right overlay
   centered on the player. Toggle: N.

   W21: repainting is REGION-DRIVEN through TC.WorldRegions (PERF-004) —
   no more round-robin column strips while visible:
     - new world / reset / import -> authority marks every region ('world')
       so the next open paints a full initial map;
     - hidden map -> zero repaint work AND zero cursor advancement, so edits
       accumulate; reopening catches up exactly once per stale region;
     - terrain edits, wall edits and liquid motion invalidate only their own
       regions (liquids mark through the Liquids change seam);
     - the player marker/viewport are drawn per frame and never depend on
       terrain repaints.
   Biome classification consumes authoritative queries instead of private
   constants: the Underworld depth cutoff comes from
   TC.Biomes.underworldTopPx()/isUnderworldAt (W19 shared authority) and the
   ocean margin from TC.Biomes.oceanEdge(). Pixels stay tinted by biome
   region and the W20 localized label renders under the panel. */
'use strict';
(function () {
  const TC = window.TC;
  const TS = TC.CONST.TS;
  const T = TC.TILE || {};

  const PANEL_W = 200, PANEL_H = 150;  // overlay size in tiles/px (1 tile = 1 px)
  const MARGIN = 16;
  const SKY_RGB = [127, 184, 232];     // #7fb8e8, air above the surface line
  const CAVE_RGB = [16, 16, 16];       // #101010, air below it
  const DARKEN = 0.75;                 // ~25% darker tile colors
  const CATCHUP_PER_FRAME = 24;        // max stale regions repainted per tick

  // ---- biome region tinting ----
  const BIOME_TINT = {                // null = leave untinted
    forest: null,
    ocean: [42, 96, 150],
    desert: [216, 186, 100],
    snow: [222, 234, 246],
    jungle: [46, 138, 74],
    underworld: [168, 52, 30],
    cave: null
  };
  const UNDER_TINT = BIOME_TINT.underworld;
  const UNDER_AIR = [44, 14, 10];      // cavern air below the underworld line
  const AIR_MIX = 0.4;                 // how strongly air pixels take the tint
  const TILE_MIX = 0.18;               // how strongly ground pixels take it

  function oceanEdge() {
    try {
      if (TC.Biomes && typeof TC.Biomes.oceanEdge === 'function') return TC.Biomes.oceanEdge();
    } catch (e) {}
    return 55;
  }
  // Authoritative Underworld cutoff (W19 shared boundary): tiles at/under the
  // lava line minus Biomes' 4-tile enter slack dominate by depth.
  function underStartTy() {
    try {
      if (TC.Biomes && typeof TC.Biomes.underworldTopPx === 'function') {
        return Math.round(TC.Biomes.underworldTopPx() / TS) - 4;
      }
    } catch (e) {}
    const gen = TC.CONST.GEN || {};
    return ((gen.underworld && gen.underworld.startY) || 355) - 4;
  }

  // Column-level surface-biome guess. Depth zones (cave/underworld) are
  // applied per pixel in paintRegion via the shared boundary query.
  function classifyColumn(world, tx) {
    const W = world.width;
    const edge = oceanEdge();
    if (tx < edge || tx >= W - edge) return 'ocean';
    let snow = 0, sand = 0, jg = 0;
    const x0 = Math.max(0, tx - 6), x1 = Math.min(W - 1, tx + 6);
    for (let x = x0; x <= x1; x++) {
      const id = world.tiles[(world.surfaceY[x] | 0) * W + x];
      if (id === T.SNOW) snow++;
      else if (id === T.SAND) sand++;
      else if (id === T.JGRASS) jg++;
    }
    if (snow > 3) return 'snow';
    if (sand > 3) return 'desert';
    if (jg > 3) return 'jungle';
    return 'forest';
  }

  const mini = {
    visible: false,
    cv: null, mctx: null, img: null,   // offscreen map canvas + its ImageData
    cw: 0, ch: 0,                      // canvas size in tiles
    worldRef: null,                    // detects world swaps -> full repaint
    ptx: 0, pty: 0,                    // player position in tile coords
    colorCache: new Map(),             // hex -> [r,g,b]
    _regions: null,                    // WorldRegions cursor ('minimap')
    _stats: { fullPaints: 0, regionsPainted: 0, pixelsPainted: 0, catchups: 0 },

    stats() { return Object.assign({}, this._stats); },

    parseColor(hex) {
      const cached = this.colorCache.get(hex);
      if (cached) return cached;
      let rgb = CAVE_RGB;
      if (typeof hex === 'string' && hex.length >= 7) {
        const n = parseInt(hex.slice(1, 7), 16);
        if (!isNaN(n)) rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      this.colorCache.set(hex, rgb);
      return rgb;
    },

    // (Re)create the offscreen canvas when a world of a new size appears.
    ensureCanvas(world) {
      if (this.cv && this.cw === world.width && this.ch === world.height) return true;
      const cv = document.createElement('canvas');
      cv.width = world.width;
      cv.height = world.height;
      const mctx = cv.getContext('2d');
      if (!mctx) return false;
      this.cv = cv;
      this.mctx = mctx;
      this.cw = world.width;
      this.ch = world.height;
      this.img = mctx.createImageData(world.width, world.height);
      return true;
    },

    ensureConsumer() {
      if (!this._regions && TC.WorldRegions && typeof TC.WorldRegions.consume === 'function') {
        this._regions = TC.WorldRegions.consume('minimap');
      }
      return this._regions;
    },

    // Repaint one 32-column region block starting at tile x0 into the map.
    paintRegion(x0, cols) {
      const world = TC.world;
      const w = this.cw, h = this.ch;
      const data = this.img.data;
      const defs = TC.TILE_DEFS;
      const AIR = TC.TILE.AIR, WATER = TC.TILE.WATER;
      const underStart = underStartTy();
      const x1 = Math.min(w, x0 + cols);
      for (let tx = x0; tx < x1; tx++) {
        const surf = world.surfaceY[tx] | 0;
        const tint = BIOME_TINT[classifyColumn(world, tx)] || null;
        // Pre-mix this column's sky color so the inner loop stays cheap.
        let skyR = SKY_RGB[0], skyG = SKY_RGB[1], skyB = SKY_RGB[2];
        if (tint) {
          skyR += (tint[0] - skyR) * AIR_MIX;
          skyG += (tint[1] - skyG) * AIR_MIX;
          skyB += (tint[2] - skyB) * AIR_MIX;
        }
        for (let ty = 0; ty < h; ty++) {
          const id = world.tiles[ty * w + tx];
          const under = ty >= underStart;           // underworld dominates by depth
          let r, g, b;
          // Layer liquid (TC.Liquids, W1 authority) paints over air cells.
          let liquidRgb = null;
          if (id === AIR && TC.Liquids && typeof TC.Liquids.queryAt === 'function') {
            const q = TC.Liquids.queryAt(tx, ty);
            if (q.amount > 0 && q.type > 0) {
              const lc = q.type === 1 ? '#3a6ea8' : q.type === 2 ? '#e85a1a' : '#d18a1f';
              liquidRgb = this.parseColor(lc);
            }
          }
          if (id === AIR && liquidRgb) {
            r = liquidRgb[0]; g = liquidRgb[1]; b = liquidRgb[2];
          } else if (id === AIR) {
            if (under) { r = UNDER_AIR[0]; g = UNDER_AIR[1]; b = UNDER_AIR[2]; }
            else if (ty < surf) { r = skyR; g = skyG; b = skyB; }
            else { r = CAVE_RGB[0]; g = CAVE_RGB[1]; b = CAVE_RGB[2]; }
          } else {
            const def = defs[id];
            const rgb = this.parseColor(def && def.colors && def.colors[0]);
            if (id === WATER) { r = rgb[0]; g = rgb[1]; b = rgb[2]; }
            else {
              r = (rgb[0] * DARKEN) | 0;
              g = (rgb[1] * DARKEN) | 0;
              b = (rgb[2] * DARKEN) | 0;
              const tn = under ? UNDER_TINT : tint; // ground picks up a faint cast
              if (tn) {
                r += (tn[0] - r) * TILE_MIX;
                g += (tn[1] - g) * TILE_MIX;
                b += (tn[2] - b) * TILE_MIX;
              }
            }
          }
          const p = (ty * w + tx) * 4;
          data[p] = r | 0; data[p + 1] = g | 0; data[p + 2] = b | 0; data[p + 3] = 255;
        }
      }
      this.mctx.putImageData(this.img, 0, 0, x0, 0, x1 - x0, h);
      this._stats.regionsPainted++;
      this._stats.pixelsPainted += (x1 - x0) * h;
    },

    // Player's biome label: localized display name for TC.Biomes' stable
    // tag when present (W20), else the column guess at the player's
    // position. The machine tag itself never renders.
    biomeLabel() {
      let tag = null;
      try {
        if (TC.Biomes && typeof TC.Biomes.current === 'string') tag = TC.Biomes.current;
      } catch (e) { /* ignore */ }
      const world = TC.world;
      if (!tag && world) {
        const tx = Math.max(0, Math.min(world.width - 1, Math.round(this.ptx)));
        tag = classifyColumn(world, tx);
      }
      if (!tag) return '';
      try {
        if (TC.Localization && typeof TC.Localization.contentName === 'function') {
          return TC.Localization.contentName('biome', tag);
        }
      } catch (e) { /* fall through */ }
      return tag.charAt(0).toUpperCase() + tag.slice(1);
    },

    update(dt) {
      void dt;
      if (TC.Input && TC.Input.pressed('KeyN')) {
        this.visible = !this.visible;
      }
      const world = TC.world;
      if (!world || !TC.player) return;
      this.ptx = (TC.player.x + TC.player.w / 2) / TS;
      this.pty = (TC.player.y + TC.player.h / 2) / TS;
      if (!this.ensureCanvas(world)) return;
      const cons = this.ensureConsumer();
      if (!cons) return;
      if (this.worldRef !== world) { this.worldRef = world; } // cursor already reset by WorldRegions.init
      if (!this.visible) return;                 // no repaint work while hidden
      // Paint stale regions only (bounded catch-up per frame).
      const WR = TC.WorldRegions;
      const dirty = cons.dirtyRegions();
      if (!dirty.length) return;
      if (dirty.length >= WR.count) this._stats.fullPaints++;
      else if (dirty.length > CATCHUP_PER_FRAME) this._stats.catchups++;
      const n = Math.min(CATCHUP_PER_FRAME, dirty.length);
      for (let k = 0; k < n; k++) {
        const idx = dirty[k];
        const cc = WR.chunkCoords(idx);
        cons.observe(idx);   // this cursor only — renderer/lighting unaffected
        this.paintRegion(cc.cx * WR.CHUNK, WR.CHUNK);
      }
    },

    // Screen-space overlay: framed map region centered on the player.
    draw(ctx, w, h) {
      if (!this.visible || !this.cv || !this.mctx) return;
      const world = TC.world;
      if (!world || !TC.player) return;
      const sw = Math.min(PANEL_W, world.width);
      const sh = Math.min(PANEL_H, world.height);
      let sx = Math.round(this.ptx) - (sw >> 1);
      let sy = Math.round(this.pty) - (sh >> 1);
      sx = Math.max(0, Math.min(world.width - sw, sx));
      sy = Math.max(0, Math.min(world.height - sh, sy));

      const px = w - MARGIN - PANEL_W;
      const py = MARGIN + 34;                      // below the hearts row
      ctx.save();
      ctx.fillStyle = 'rgba(8,8,12,0.55)';       // slight backing
      ctx.fillRect(px, py, PANEL_W, PANEL_H);
      ctx.drawImage(this.cv, sx, sy, sw, sh, px, py, sw, sh);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#14141a';
      ctx.strokeRect(px + 1, py + 1, PANEL_W - 2, PANEL_H - 2);
      ctx.fillStyle = '#ffffff';                 // player dot at panel center
      ctx.fillRect(px + PANEL_W / 2 - 1.5, py + PANEL_H / 2 - 1.5, 3, 3);
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText((TC.Localization && typeof TC.Localization.t === 'function')
        ? TC.Localization.t('ui.minimap.hint') : '[N] map', px + PANEL_W / 2, py + PANEL_H + 12);
      const bio = this.biomeLabel();
      if (bio) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillText(bio, px + PANEL_W / 2, py + PANEL_H + 24);
      }
      ctx.restore();
    }
  };

  TC.MiniMap = mini;
})();

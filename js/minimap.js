/* minimap.js — offscreen 1px-per-tile world map, lazily repainted in column
   strips, drawn as a top-right overlay centered on the player. Toggle: N.
   Pixels are tinted by biome region (mirroring TC.Biomes' rules, which only
   classify the player's own position) and the current biome is labelled
   under the map. */
'use strict';
(function () {
  const TC = window.TC;
  const TS = TC.CONST.TS;
  const T = TC.TILE || {};

  const STRIP = 60;                    // columns repainted per update tick
  const PANEL_W = 200, PANEL_H = 150;  // overlay size in tiles/px (1 tile = 1 px)
  const MARGIN = 16;
  const SKY_RGB = [127, 184, 232];     // #7fb8e8, air above the surface line
  const CAVE_RGB = [16, 16, 16];       // #101010, air below it
  const DARKEN = 0.75;                 // ~25% darker tile colors

  // ---- biome region tinting (mirrors TC.Biomes' detection rules) ----
  const UNDER_START =
    (TC.CONST.GEN && TC.CONST.GEN.underworld && TC.CONST.GEN.underworld.startY) || 355;
  const OCEAN_EDGE = 55;               // matches TC.Biomes' ocean margin
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

  // Column-level biome guess. TC.Biomes only exposes the player's own tag,
  // so map strips classify themselves with the same region rules: ocean at
  // the world margins, otherwise whichever stamped surface tile (SNOW/SAND/
  // JGRASS) dominates a small window around the column — matching how
  // worldgen marks biome regions. Depth zones (cave/underworld) are applied
  // per pixel in paintColumns.
  function classifyColumn(world, tx) {
    const W = world.width;
    if (tx < OCEAN_EDGE || tx >= W - OCEAN_EDGE) return 'ocean';
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
    nextX: 0,                          // round-robin strip cursor
    fullRefresh: false,
    ptx: 0, pty: 0,                    // player position in tile coords
    colorCache: new Map(),             // hex -> [r,g,b]

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
      this.nextX = 0;
      this.fullRefresh = true;
      return true;
    },

    // Repaint `count` full-height columns starting at x0 into the map canvas.
    paintColumns(x0, count) {
      const world = TC.world;
      const w = this.cw, h = this.ch;
      const data = this.img.data;
      const defs = TC.TILE_DEFS;
      const AIR = TC.TILE.AIR, WATER = TC.TILE.WATER;
      const underStart = UNDER_START - 4;          // TC.Biomes' depth cutoff
      for (let i = 0; i < count; i++) {
        const tx = x0 + i;
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
      this.mctx.putImageData(this.img, 0, 0, x0, 0, count, h);
    },

    // Player's biome label: TC.Biomes' stable tag when present, else the
    // column guess at the player's position.
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
      return tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : '';
    },

    update(dt) {
      if (TC.Input && TC.Input.pressed('KeyN')) {
        this.visible = !this.visible;
        if (this.visible) this.fullRefresh = true; // repaint everything on reveal
      }
      const world = TC.world;
      if (!world || !TC.player) return;
      this.ptx = (TC.player.x + TC.player.w / 2) / TS;
      this.pty = (TC.player.y + TC.player.h / 2) / TS;
      if (!this.ensureCanvas(world)) return;
      if (this.worldRef !== world) { this.worldRef = world; this.fullRefresh = true; }
      if (!this.visible) return;                 // no refresh work while hidden
      if (this.fullRefresh) {
        this.paintColumns(0, world.width);
        this.nextX = 0;
        this.fullRefresh = false;
        return;
      }
      const count = Math.min(STRIP, world.width - this.nextX);
      this.paintColumns(this.nextX, count);
      this.nextX += count;
      if (this.nextX >= world.width) this.nextX = 0;
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
      ctx.fillText('[N] map', px + PANEL_W / 2, py + PANEL_H + 12);
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

/* tiles.js — procedural pixel-art tile rendering with an offscreen variant cache. */
'use strict';
(function () {
  const TC = (window.TC = window.TC || {});

  // Seeded hash drives every per-variant/per-speckle decision (never Math.random).
  const hash2 = (TC.Utils && TC.Utils.hash2) ? TC.Utils.hash2 : function (x, y, s) {
    let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1440662683)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  const BASE = 16;        // canonical cache resolution in world px
  const VARIANTS = 8;     // pre-rendered look variations per tile id
  const cache = new Map(); // numeric key -> HTMLCanvasElement

  // ---- content extensions ----
  // constants.js is lead-owned, so the tile/item/recipe data for this module's
  // features (platforms, ropes/chains, hammer) is appended here instead of
  // editing it. Idempotent: skipped when the ids/items already exist. Appended
  // tile ids stay inside TILE_DEFS.length, so save.js diff validation accepts
  // them unchanged.
  function extendContent() {
    const T = TC.TILE;
    const defs = TC.TILE_DEFS;
    function addTile(key, def) {
      if (T[key] != null && defs[T[key]]) return false;
      const id = defs.length;
      T[key] = id;
      defs.push(Object.assign({
        name: key.toLowerCase(), solid: false, opaque: false, hardness: 0.1,
        tool: 'any', minPower: 0, drop: null, light: 0, pattern: 'empty',
        needsSupport: 'any', replaceable: false
      }, def));
      return true;
    }
    if (addTile('PLATFORM', {
          name: 'wood platform', hardness: 0.15, drop: 'platform',
          pattern: 'platform', hammerable: true,
          defaultShape: 1,               // TC.Shapes.PLATFORM (const hoists below)
          colors: ['#a97d4b', '#7a5230']
        })) {
      TC.ITEM_DEFS.platform = { name: 'Wood Platform', kind: 'block', maxStack: 999, tile: T.PLATFORM };
      TC.RECIPES.push({ out: 'platform', n: 2, station: 'workbench', cost: { wood: 1 } });
    }
    if (addTile('ROPE', {
          name: 'rope', hardness: 0.05, drop: 'rope', pattern: 'rope',
          climbable: true, colors: ['#b08d57', '#8a6a3f']
        })) {
      TC.ITEM_DEFS.rope = { name: 'Rope', kind: 'block', maxStack: 999, tile: T.ROPE };
      TC.RECIPES.push({ out: 'rope', n: 5, station: null, cost: { wood: 1, gel: 1 } });
    }
    if (addTile('CHAIN', {
          name: 'chain', hardness: 0.1, drop: 'chain', pattern: 'chain',
          climbable: true, colors: ['#9a9aa2', '#6a6a72']
        })) {
      TC.ITEM_DEFS.chain = { name: 'Chain', kind: 'block', maxStack: 999, tile: T.CHAIN };
      TC.RECIPES.push({ out: 'chain', n: 5, station: 'anvil', cost: { iron_bar: 1 } });
    }
    if (!TC.ITEM_DEFS.hammer) {
      // Hammer tool: player.js should route kind 'tool' items whose def.tool
      // is 'hammer' to World.hammer(tx,ty) instead of doMine (see world.js).
      TC.ITEM_DEFS.hammer = {
        name: 'Wooden Hammer', kind: 'tool', maxStack: 1,
        tool: 'hammer', power: 35, useTime: 0.35, damage: 5, knockback: 2
      };
      TC.RECIPES.push({ out: 'hammer', n: 1, station: 'workbench', cost: { wood: 8, copper_bar: 2 } });
    }
  }
  extendContent();

  // Hammer/tile-shape vocabulary shared with world.js (TC.Shapes). tiles.js
  // loads first, so fall back to a literal copy of the same ids when world.js
  // is not present yet; by draw time both modules are loaded and agree.
  const SHAPES = TC.Shapes || {
    FULL: 0, PLATFORM: 1, HALF: 2,
    SLOPE_NE: 3, SLOPE_NW: 4, SLOPE_SE: 5, SLOPE_SW: 6,
    solidAt: function () { return false; },
    topSurfaceY: function () { return 0; },
    blocksMovement: function () { return true; },
    renderPath: function () { return { kind: 'full', poly: null }; }
  };

  // ---- color helpers (hex in, css string out) ----
  function toRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) {
    const c = toRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  // t > 0 mixes toward white, t < 0 toward black; returns hex so it can be re-mixed
  function shade(hex, t) {
    const c = toRgb(hex);
    const w = t >= 0 ? 255 : 0;
    const k = Math.min(1, Math.abs(t));
    let out = '#';
    for (let i = 0; i < 3; i++) {
      const v = Math.round(c[i] + (w - c[i]) * k);
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }
  function rect(g, style, x, y, w, h) { g.fillStyle = style; g.fillRect(x, y, w, h); }

  // ---- pattern painters (each paints one 16x16 tile) ----
  // H(k) -> deterministic [0,1) stream for this (id, variant) pair; keep k ranges
  // disjoint within a pattern so features don't correlate.
  const PATTERNS = {

    speckle(g, def, H) {
      rect(g, def.colors[0], 0, 0, 16, 16);
      const extra = def.colors.length - 1;
      for (let k = 0; k < 11; k++) {
        const c = extra > 0 ? def.colors[1 + ((H(k + 40) * extra) | 0)] : shade(def.colors[0], -0.15);
        const s = H(k + 80) < 0.3 ? 2 : 1;
        rect(g, c, (H(k) * 16) | 0, (H(k + 16) * 16) | 0, s, s);
      }
    },

    grass(g, def, H) {
      const dirt = def.colors[0], green = def.colors[1];
      rect(g, dirt, 0, 0, 16, 16);
      for (let k = 0; k < 6; k++) {
        rect(g, shade(dirt, H(k + 20) < 0.5 ? -0.12 : 0.08), (H(k) * 16) | 0, (H(k + 8) * 16) | 0, 1, 1);
      }
      for (let x = 0; x < 16; x++) rect(g, green, x, 0, 1, H(x + 60) < 0.5 ? 3 : 4);
      for (let k = 0; k < 3; k++) { // small lips hanging lower into the dirt
        rect(g, green, (H(k + 90) * 15) | 0, 0, 1, H(k + 94) < 0.5 ? 5 : 6);
      }
    },

    plank(g, def, H) {
      const wood = def.colors[0];
      const dark = def.colors[1] || shade(wood, -0.2);
      rect(g, wood, 0, 0, 16, 16);
      for (let row = 0; row < 3; row++) { // grain lines with gaps
        const y = 3 + row * 5;
        for (let x = 0; x < 16; x++) if (H(row * 16 + x) > 0.15) rect(g, dark, x, y, 1, 1);
      }
      const sx = 3 + ((H(50) * 10) | 0); // plank end joint
      for (let y = 0; y < 16; y++) if (H(60 + y) > 0.2) rect(g, dark, sx, y, 1, 1);
      const light = shade(wood, 0.12);
      for (let k = 0; k < 4; k++) rect(g, light, (H(100 + k) * 14) | 0, (H(112 + k) * 16) | 0, 2, 1);
    },

    trunk(g, def, H) {
      const bark = def.colors[0];
      const dark = def.colors[1] || shade(bark, -0.2);
      rect(g, bark, 0, 0, 16, 16);
      rect(g, dark, 0, 0, 2, 16); // darker edges
      rect(g, dark, 14, 0, 2, 16);
      rect(g, shade(bark, 0.15), 2, 0, 1, 16); // lit inner edge
      for (let k = 0; k < 3; k++) { // vertical grain streaks
        const x = 4 + ((H(k + 170) * 10) | 0);
        const y0 = (H(k + 180) * 8) | 0;
        rect(g, shade(bark, -0.22), x, y0, 1, 5 + ((H(k + 190) * 7) | 0));
      }
      if (H(210) < 0.35) { // occasional knot
        const kx = 5 + ((H(215) * 7) | 0), ky = 4 + ((H(220) * 8) | 0);
        rect(g, dark, kx, ky, 2, 2);
        rect(g, shade(bark, -0.35), kx, ky + 1, 1, 1);
      }
    },

    leafy(g, def, H) {
      const c0 = def.colors[0];
      const c1 = def.colors[1] || shade(c0, -0.2);
      const c2 = def.colors[2] || shade(c0, 0.15);
      rect(g, c0, 0, 0, 16, 16);
      for (let k = 0; k < 5; k++) { // shadow blotches, lower-left bias
        rect(g, c1, (H(k + 240) * 13) | 0, 3 + ((H(k + 250) * 12) | 0), 3, 2);
      }
      for (let k = 0; k < 4; k++) { // highlight blotches, upper-right bias
        rect(g, c2, (H(k + 260) * 13) | 0, (H(k + 270) * 10) | 0, 2, 2);
      }
      g.clearRect(0, 0, 1, 1); g.clearRect(15, 0, 1, 1); // soften corners
      g.clearRect(0, 15, 1, 1); g.clearRect(15, 15, 1, 1);
      for (let k = 0; k < 4; k++) { // edge nibbles for an organic silhouette
        const side = (H(k + 230) * 4) | 0;
        const o = 2 + ((H(k + 236) * 11) | 0);
        if (side === 0) g.clearRect(o, 0, 2, 1);
        else if (side === 1) g.clearRect(o, 15, 2, 1);
        else if (side === 2) g.clearRect(0, o, 1, 2);
        else g.clearRect(15, o, 1, 2);
      }
      if (H(280) < 0.65) { // occasional holes
        const n = 1 + ((H(285) * 1.99) | 0);
        for (let k = 0; k < n; k++) {
          g.clearRect(2 + ((H(k + 290) * 11) | 0), 2 + ((H(k + 300) * 11) | 0), 2, 1);
        }
      }
    },

    ore(g, def, H) {
      const stone = def.colors[0];
      rect(g, stone, 0, 0, 16, 16);
      for (let k = 0; k < 8; k++) { // stone texture
        rect(g, shade(stone, H(k + 310) < 0.5 ? -0.14 : 0.1), (H(k) * 16) | 0, (H(k + 16) * 16) | 0, 1, 1);
      }
      const oreC = def.colors[1];
      const hi = shade(oreC, 0.3), lo = shade(oreC, -0.3);
      const n = 3 + ((H(330) * 3) | 0); // 3-5 nuggets
      for (let k = 0; k < n; k++) {
        const x = 1 + ((H(k + 340) * 12) | 0), y = 1 + ((H(k + 360) * 12) | 0);
        rect(g, oreC, x, y, 2, 2);
        rect(g, oreC, x + (H(k + 380) < 0.5 ? -1 : 2), y + 1 + ((H(k + 384) * 2) | 0), 1, 1);
        rect(g, hi, x, y, 1, 1);
        rect(g, lo, x + 1, y + 1, 1, 1);
      }
    },

    torch(g, def) {
      const stick = def.colors[0];
      const flame = def.colors[1] || '#ffd76a';
      const grad = g.createRadialGradient(8, 4, 1, 8, 4, 8);
      grad.addColorStop(0, rgba(flame, 0.45));
      grad.addColorStop(1, rgba(flame, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, 16, 16);
      rect(g, stick, 7, 6, 2, 10); // handle
      rect(g, shade(stick, -0.25), 8, 6, 1, 10);
      rect(g, flame, 6, 2, 4, 4); // flame body
      rect(g, flame, 7, 1, 2, 1);
      rect(g, flame, 7, 6, 2, 1);
      rect(g, shade(flame, 0.45), 7, 3, 2, 2); // hot core
    },

    workbench(g, def) {
      const wood = def.colors[0];
      const dark = def.colors[1] || shade(wood, -0.25);
      rect(g, wood, 0, 4, 16, 3); // slab
      rect(g, shade(wood, 0.18), 0, 4, 16, 1);
      rect(g, dark, 0, 6, 16, 1);
      rect(g, dark, 2, 7, 2, 9); // legs
      rect(g, dark, 12, 7, 2, 9);
      rect(g, shade(dark, -0.2), 3, 7, 1, 9);
      rect(g, shade(dark, -0.2), 13, 7, 1, 9);
    },

    furnace(g, def) {
      const stone = def.colors[0];
      const dark = def.colors[1] || shade(stone, -0.35);
      const fire = def.colors[2] || '#ff8c3a';
      rect(g, stone, 0, 0, 16, 16);
      rect(g, shade(stone, 0.12), 0, 0, 16, 1);
      rect(g, shade(stone, -0.18), 0, 5, 16, 1); // block joints
      rect(g, shade(stone, -0.18), 0, 10, 16, 1);
      rect(g, dark, 4, 8, 8, 8); // arched mouth
      rect(g, dark, 3, 9, 10, 7);
      rect(g, fire, 5, 12, 6, 4); // fire
      rect(g, fire, 6, 11, 4, 1);
      rect(g, shade(fire, 0.4), 7, 12, 2, 2);
      rect(g, shade(fire, -0.3), 5, 15, 6, 1);
    },

    anvil(g, def) {
      const body = def.colors[0];
      const hi = def.colors[1] || shade(body, 0.2);
      rect(g, body, 1, 4, 14, 3); // top plate
      rect(g, body, 0, 5, 1, 1); // horn tips
      rect(g, body, 15, 5, 1, 1);
      rect(g, hi, 1, 4, 14, 1); // polished face
      rect(g, body, 6, 7, 4, 3); // neck
      rect(g, shade(body, -0.3), 6, 7, 1, 3);
      rect(g, body, 4, 10, 8, 3); // waist
      rect(g, shade(body, -0.3), 4, 12, 8, 1);
      rect(g, body, 2, 13, 12, 3); // foot
    },

    plant(g, def, H) {
      const stem = def.colors[0];
      if (def.colors.length > 1) { // flower: stem + bloom in colors[1]
        const bloom = def.colors[1];
        const bx = 6 + ((H(400) * 3) | 0);
        const tip = 7 + ((H(405) * 2) | 0);
        for (let y = 15; y >= 6; y--) {
          rect(g, stem, Math.round(bx + (tip - bx) * (15 - y) / 9), y, 1, 1);
        }
        rect(g, stem, tip - 2, 10, 2, 1); // leaves
        rect(g, stem, tip + 1, 12, 2, 1);
        rect(g, bloom, tip - 1, 3, 3, 3); // petals
        rect(g, bloom, tip, 2, 1, 1);
        rect(g, bloom, tip, 6, 1, 1);
        rect(g, shade(bloom, 0.45), tip, 4, 1, 1); // center
      } else { // tall grass blades
        for (let k = 0; k < 5; k++) {
          const x0 = 1 + ((H(k + 410) * 14) | 0);
          const h = 5 + ((H(k + 430) * 6) | 0);
          const lean = H(k + 450) < 0.5 ? -1 : 1;
          rect(g, stem, x0, 16 - h, 1, h);
          rect(g, shade(stem, 0.18), x0 + lean, 16 - h, 1, 2);
        }
      }
    },

    liquid(g, def, H, flags) {
      rect(g, rgba(def.colors[0], 0.8), 0, 0, 16, 16);
      if (flags & 2) { // exposed surface (no water above)
        const lite = def.colors[1] || shade(def.colors[0], 0.25);
        rect(g, rgba(lite, 0.9), 0, 0, 16, 2);
        for (let k = 0; k < 3; k++) {
          rect(g, rgba(shade(lite, 0.35), 0.9), (H(k + 470) * 14) | 0, 0, 2, 1);
        }
      }
    },

    glass(g, def) {
      const c = def.colors[0];
      rect(g, rgba(c, 0.25), 0, 0, 16, 16);
      const edge = rgba(c, 0.6);
      rect(g, edge, 0, 0, 16, 1);
      rect(g, edge, 0, 15, 16, 1);
      rect(g, edge, 0, 0, 1, 16);
      rect(g, edge, 15, 0, 1, 16);
      g.fillStyle = 'rgba(255,255,255,0.35)'; // diagonal shine streak
      for (let i = 2; i < 13; i++) g.fillRect(13 - i, i, 2, 1);
      g.fillStyle = 'rgba(255,255,255,0.18)'; // faint echo streak
      for (let i = 1; i < 6; i++) g.fillRect(7 - i, i, 1, 1);
    },

    // The three patterns below receive nb = {n,e,s,w} same-id neighbour flags
    // so runs of platforms/ropes/chains join up (see connBits in drawTile).
    platform(g, def, H, flags, nb) {
      const wood = def.colors[0];
      const dark = def.colors[1] || shade(wood, -0.25);
      const x0 = nb && nb.w ? 0 : 1;   // deck spans into connected neighbours
      const x1 = nb && nb.e ? 16 : 15;
      rect(g, wood, x0, 5, x1 - x0, 3);
      rect(g, shade(wood, 0.18), x0, 5, x1 - x0, 1);
      rect(g, dark, x0, 7, x1 - x0, 1);
      for (let k = 0; k < 4; k++) {    // grain ticks on the deck
        rect(g, shade(wood, -0.12), x0 + ((H(k + 500) * (x1 - x0)) | 0), 6, 1, 1);
      }
      if (!(nb && nb.w)) { rect(g, dark, 1, 8, 2, 3); rect(g, wood, 1, 8, 1, 2); }
      if (!(nb && nb.e)) { rect(g, dark, 13, 8, 2, 3); rect(g, wood, 14, 8, 1, 2); }
    },

    rope(g, def, H, flags, nb) {
      const fiber = def.colors[0];
      const dark = def.colors[1] || shade(fiber, -0.25);
      const y0 = nb && nb.n ? 0 : 2;   // free tops leave room for the knot
      const y1 = nb && nb.s ? 16 : 14;
      for (let y = y0; y < y1; y++) {  // two twisted strands
        const twist = ((y >> 2) & 1) === 0;
        rect(g, fiber, twist ? 6 : 8, y, 1, 1);
        rect(g, dark, twist ? 9 : 7, y, 1, 1);
      }
      if (!(nb && nb.n)) {             // anchor knot
        rect(g, dark, 5, 0, 6, 2);
        rect(g, fiber, 6, 0, 4, 1);
      }
      if (!(nb && nb.s)) {             // frayed tail
        rect(g, fiber, 6, 14, 1, 1);
        rect(g, dark, 9, 14, 1, 1);
      }
    },

    chain(g, def, H, flags, nb) {
      const metal = def.colors[0];
      const dark = def.colors[1] || shade(metal, -0.3);
      const hi = shade(metal, 0.35);
      const y0 = nb && nb.n ? 0 : 1;
      const y1 = nb && nb.s ? 16 : 15;
      for (let y = y0; y < y1; y += 4) {   // alternating links joined by a pin
        const wide = (((y - y0) >> 2) & 1) === 0;
        const lw = wide ? 8 : 4;
        const lx = 8 - (lw >> 1);
        rect(g, dark, lx, y, lw, 3);
        rect(g, metal, lx + 1, y, lw - 2, 1);
        rect(g, metal, lx + 1, y + 2, lw - 2, 1);
        rect(g, hi, lx + 1, y, 2, 1);
        rect(g, metal, 7, y + 1, 2, 1);
      }
    }
  };

  // Patterns that get the generic 1px lighter top edge when the north neighbor
  // is clear (grass has its cap, liquid its surface line, decor is free-form).
  const TOP_EDGE = { speckle: 1, plank: 1, ore: 1 };

  // Patterns whose sprites connect to same-id neighbours (see PATTERNS.platform
  // et al). Connection bits mirror the mask layout: N=1, E=2, S=4, W=8.
  const CONNECTS = { platform: 1, rope: 1, chain: 1 };
  const PAINT_SLOTS = 4;   // paint ids reserved in the cache key (stub, see applyPaint)

  function connBits(id, tx, ty) {
    const w = TC.world;
    if (!w || typeof w.get !== 'function') return 0;
    return (w.get(tx, ty - 1) === id ? 1 : 0) |
           (w.get(tx + 1, ty) === id ? 2 : 0) |
           (w.get(tx, ty + 1) === id ? 4 : 0) |
           (w.get(tx - 1, ty) === id ? 8 : 0);
  }

  // Cut a hammered shape out of a freshly painted tile canvas: wipe it, clip
  // to the shape's unit-space polygon (TC.Shapes.renderPath), repaint the
  // texture inside, then light the cut with a dithered lip. HALF keeps the
  // lower half; PLATFORM keeps the thin deck band; slopes are right triangles
  // filled toward their namesake corner.
  function carveShape(g, def, shape, repaint) {
    const desc = SHAPES.renderPath(shape);
    if (!desc || !desc.poly) return;
    const lip = shade(def.colors[0], -0.3);
    const hi = shade(def.colors[0], 0.25);
    g.clearRect(0, 0, BASE, BASE);     // wipe, then rebuild only inside the clip
    g.save();
    g.beginPath();
    const p = desc.poly;
    g.moveTo(p[0][0] * BASE, p[0][1] * BASE);
    for (let i = 1; i < p.length; i++) g.lineTo(p[i][0] * BASE, p[i][1] * BASE);
    g.closePath();
    g.clip();
    repaint();
    g.restore();
    if (shape === SHAPES.PLATFORM) {
      rect(g, lip, 0, 8, BASE, 1);     // underside of the deck band
    } else if (shape === SHAPES.HALF) {
      rect(g, lip, 0, 7, BASE, 1);     // walkable mid-tile ledge
    } else if (shape === SHAPES.SLOPE_NE || shape === SHAPES.SLOPE_SW) {
      for (let x = 0; x < BASE; x++) rect(g, x & 1 ? hi : lip, x, x, 1, 1);          // "\"
    } else {
      for (let x = 0; x < BASE; x++) rect(g, x & 1 ? hi : lip, x, BASE - 1 - x, 1, 1); // "/"
    }
  }

  // Paint compatibility stub: a real paint feature would list its tints here
  // keyed by paint id (1..PAINT_SLOTS-1). The table ships empty so nothing
  // changes visually until paint items exist; World.setPaint/getPaint already
  // carry the per-position state end to end.
  const PAINT_TINTS = {};
  function applyPaint(cv, paint) {
    const tint = PAINT_TINTS[paint];
    if (!tint) return;
    const g = cv.getContext('2d');
    g.save();
    g.globalCompositeOperation = 'source-atop'; // keep tile transparency
    g.fillStyle = tint;
    g.fillRect(0, 0, BASE, BASE);
    g.restore();
  }

  function buildTile(id, v, flags, conn, shape) {
    const def = TC.TILE_DEFS[id];
    const cv = document.createElement('canvas');
    cv.width = BASE;
    cv.height = BASE;
    const g = cv.getContext('2d');
    // The variant index stands in for tx here so cached tiles stay
    // position-independent while remaining deterministic from the seed.
    const H = function (k) { return hash2(v, id, k); };
    const pat = PATTERNS[def.pattern];
    const nb = {
      n: !!(conn & 1), e: !!(conn & 2), s: !!(conn & 4), w: !!(conn & 8)
    };
    // Paints the full tile texture; reused inside shape clips after a wipe.
    const repaint = function () {
      if (pat) pat(g, def, H, flags, nb);
      if (flags & 1) rect(g, shade(def.colors[0], 0.22), 0, 0, BASE, 1);
    };
    repaint();
    if (shape) carveShape(g, def, shape, repaint);
    return cv;
  }

  // Surface line only when the tile above is not liquid; prefer the
  // TC.Liquids volume layer (W1 authority), then a legacy world peek, then
  // the mask (opaque cover) when neither is up yet.
  function waterAbove(tx, ty, mask) {
    const LQ = TC.Liquids;
    if (LQ && typeof LQ.queryAt === 'function') {
      const q = LQ.queryAt(tx, ty - 1);
      if (q.amount > 0) return true;
    }
    const w = TC.world;
    if (w && typeof w.get === 'function') {
      const id = w.get(tx, ty - 1);
      if (id === TC.TILE.WATER || id === TC.TILE.LAVA) return true;
    }
    return !!(mask & 1);
  }

  function drawTile(ctx, id, px, py, ts, tx, ty, mask, shape, paint) {
    const def = TC.TILE_DEFS && TC.TILE_DEFS[id];
    if (!def || def.pattern === 'empty') return;
    ts = ts || (TC.CONST && TC.CONST.TS) || BASE;
    tx = tx | 0; ty = ty | 0; mask = mask | 0;
    shape = (shape | 0) & 7;                       // TC.Shapes id, wraps into range
    paint = paint | 0;
    if (paint < 0 || paint >= PAINT_SLOTS) paint = 0;
    const v = (hash2(tx, ty, id) * VARIANTS) | 0;
    let flags = 0;
    if (!(mask & 1) && TOP_EDGE[def.pattern]) flags |= 1;
    if (def.pattern === 'liquid' && !waterAbove(tx, ty, mask)) flags |= 2;
    const conn = CONNECTS[def.pattern] ? connBits(id, tx, ty) : 0;
    // key layout: id/variant/flags -> shape (8 ids) -> paint -> neighbour connection
    const key = ((((id * VARIANTS + v) * 4 + flags) * 8 + shape) * PAINT_SLOTS + paint) * 16 + conn;
    let cv = cache.get(key);
    if (!cv) {
      cv = buildTile(id, v, flags, conn, shape);
      if (paint) applyPaint(cv, paint);
      cache.set(key, cv);
    }
    ctx.drawImage(cv, Math.round(px), Math.round(py), ts, ts);
  }

  // Hand-authored crack polylines in unit tile space; stages are cumulative.
  const CRACK_COUNT = [1, 3, 6, 10];
  const CRACKS = [
    [[0.50, 0.04], [0.44, 0.26], [0.53, 0.46], [0.48, 0.62]], // stage 0
    [[0.48, 0.60], [0.60, 0.72], [0.57, 0.94]],               // stage 1
    [[0.45, 0.28], [0.28, 0.36], [0.10, 0.32]],
    [[0.52, 0.45], [0.70, 0.41], [0.90, 0.50]],               // stage 2
    [[0.30, 0.54], [0.23, 0.73], [0.33, 0.92]],
    [[0.70, 0.43], [0.76, 0.24], [0.87, 0.12]],
    [[0.57, 0.93], [0.44, 0.98]],                             // stage 3
    [[0.10, 0.33], [0.05, 0.52]],
    [[0.90, 0.51], [0.96, 0.67], [0.89, 0.85]],
    [[0.36, 0.61], [0.50, 0.78], [0.46, 0.95]]
  ];

  function drawCracks(ctx, px, py, ts, stage) {
    if (!(stage >= 0)) return; // rejects NaN and negatives
    const n = CRACK_COUNT[Math.min(3, stage | 0)];
    ts = ts || (TC.CONST && TC.CONST.TS) || BASE;
    const ox = Math.round(px), oy = Math.round(py);
    ctx.save();
    ctx.strokeStyle = 'rgba(12,9,6,0.85)';
    ctx.lineWidth = Math.max(1, ts / 16);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const p = CRACKS[i];
      ctx.moveTo(ox + p[0][0] * ts, oy + p[0][1] * ts);
      for (let j = 1; j < p.length; j++) ctx.lineTo(ox + p[j][0] * ts, oy + p[j][1] * ts);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---- background walls ----
  const wallCache = new Map(); // wall id -> HTMLCanvasElement (one look per id)

  function buildWall(id) {
    const def = TC.WALL_DEFS[id];
    const cv = document.createElement('canvas');
    cv.width = BASE;
    cv.height = BASE;
    const g = cv.getContext('2d');
    rect(g, def.color, 0, 0, BASE, BASE);
    const H = function (k) { return hash2(id, id, k); }; // id-only mottling
    for (let k = 0; k < 6; k++) {
      rect(g, shade(def.color, H(k + 20) < 0.5 ? -0.12 : 0.06),
        (H(k) * BASE) | 0, (H(k + 10) * BASE) | 0, 1, 1);
    }
    rect(g, shade(def.color, -0.15), 0, 0, BASE, 1); // darker top lip (no neighbor info)
    return cv;
  }

  function drawWall(ctx, id, px, py, ts, tx, ty) {
    const def = TC.WALL_DEFS && TC.WALL_DEFS[id];
    if (!def || !def.color) return; // NONE (id 0) or unknown wall id
    ts = ts || (TC.CONST && TC.CONST.TS) || BASE;
    tx = tx | 0; ty = ty | 0;
    let cv = wallCache.get(id);
    if (!cv) {
      cv = buildWall(id);
      wallCache.set(id, cv);
    }
    const ox = Math.round(px), oy = Math.round(py);
    ctx.drawImage(cv, ox, oy, ts, ts);
    // position-seeded darker speckles so long wall runs don't visibly repeat
    ctx.save();
    ctx.fillStyle = shade(def.color, -0.18);
    const u = Math.max(1, Math.round(ts / 16));
    for (let k = 0; k < 3; k++) {
      const s = (hash2(tx, ty, id * 97 + k) < 0.35 ? 2 : 1) * u;
      const x = Math.min((hash2(tx, ty, id * 131 + k) * ts) | 0, ts - s);
      const y = Math.min((hash2(tx, ty, id * 193 + k) * ts) | 0, ts - s);
      ctx.fillRect(ox + x, oy + y, s, s);
    }
    ctx.restore();
  }

  // Ghost outline of a tile shape for placement/hammer previews. Screen or
  // world space, caller's transform; draws a translucent fill plus dashed
  // outline of the shape region (full square when shape is FULL).
  function drawShapePreview(ctx, px, py, ts, shape) {
    const desc = SHAPES.renderPath((shape | 0) & 7);
    const poly = desc && desc.poly;
    const ox = Math.round(px), oy = Math.round(py);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = Math.max(1, ts / 16);
    ctx.setLineDash([Math.max(2, ts / 4), Math.max(2, ts / 4)]);
    ctx.beginPath();
    if (poly) {
      ctx.moveTo(ox + poly[0][0] * ts, oy + poly[0][1] * ts);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(ox + poly[i][0] * ts, oy + poly[i][1] * ts);
      }
      ctx.closePath();
    } else {
      ctx.rect(ox, oy, ts, ts);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  TC.Tiles = { drawTile, drawCracks, drawWall, drawShapePreview, SHAPE: SHAPES };
})();

/* loot.js — TC.Loot: breakable pots, life crystals, and treasure.

   Owns exactly this file. constants.js / main.js / index.html are lead-owned,
   so this module EXTENDS the shared tables at load time and PATCHES existing
   prototypes/functions at runtime instead of editing them (same pattern as
   wiring.js / accessories.js):

   - Table extensions (promote into constants.js when convenient):
     TC.TILE:      POT, LIFE_CRYSTAL
     TC.TILE_DEFS: matching defs appended
     TC.ITEM_DEFS: pot (placeable), life_crystal (kind 'crystal'), heart

   - Runtime hooks (all guarded + idempotent):
     WorldGen.generate          -> deterministic post-pass: pots sprinkled on
                                   underground cave floors (~1 per 90 candidate
                                   tiles, cap 400), ~25 life crystals below
                                   y=200, and generated CHEST tiles pre-filled
                                   with loot keyed by position hash
     World.prototype.applyMineDamage -> breaking a POT scatters small loot;
                                   completes the break for POT/LIFE_CRYSTAL if
                                   wiring.js's global shim is absent
     World.prototype.draw       -> paints POT / LIFE_CRYSTAL (their patterns are
                                   unknown to tiles.js, which renders them blank)
     Items.iconFor              -> procedural icons for pot / life_crystal / heart
     Player.prototype.useHeld   -> kind 'crystal' consumable: +20 maxHp, cap 400
     Player.prototype.update    -> crystal cooldown + maxHp floor maintenance
     Player.prototype.serialize / Player.deserialize -> persists lifeCrystals
                                  (player.js's own blob has no maxHp field)
     Accessories.modsOf         -> folds the crystal HP bonus into the gear-mod
                                   sum so accessories.js syncMaxHp never clobbers it
     newGame                    -> TC.Loot.reset()

   REQUIRES one line in index.html (lead-owned, not added here), AFTER
   js/worldgen.js and BEFORE js/main.js — directly under the worldgen tag:
     <script src="js/worldgen.js"></script>
     <script src="js/loot.js"></script>

   Exposed API: TC.Loot.{reset, populateChest, stats}. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Loot) return;                        // load-once guard

  // ======================================================================
  // Shared-table extensions (see header note; promote to constants.js).
  // ======================================================================

  function extendTables() {
    const T = TC.TILE;
    const defs = TC.TILE_DEFS;
    if (!T || !defs) return;                  // constants.js missing; bail out
    const addTile = (key, def) => {
      if (T[key] == null) {
        T[key] = defs.length;
        defs.push(Object.assign({
          name: key.toLowerCase(), solid: false, opaque: false, hardness: 0,
          tool: 'any', minPower: 0, drop: null, light: 0, pattern: 'empty',
          needsSupport: null, replaceable: false, colors: []
        }, def));
      }
    };
    addTile('POT', {
      name: 'pot', hardness: 0.1, tool: 'any', drop: null,
      pattern: 'pot', needsSupport: 'below',
      colors: ['#b3623a', '#8a4626', '#5f2f18']
    });
    addTile('LIFE_CRYSTAL', {
      name: 'life crystal', solid: true, opaque: false, hardness: 0.5,
      tool: 'pick', drop: 'life_crystal', light: 0.4,
      pattern: 'crystal', needsSupport: 'below',
      colors: ['#e23b48', '#a31f2c', '#6d6d6d']
    });

    if (!TC.ITEM_DEFS) TC.ITEM_DEFS = {};
    const addItem = (id, name, kind, o) => {
      if (!TC.ITEM_DEFS[id]) {
        TC.ITEM_DEFS[id] = Object.assign({ name, kind, maxStack: 999 }, o);
      }
    };
    addItem('pot', 'Pot', 'block', { tile: T.POT });
    addItem('life_crystal', 'Life Crystal', 'crystal', { maxStack: 20 });
    addItem('heart', 'Heart', 'material', { maxStack: 99 });
  }
  extendTables();

  // ======================================================================
  // Tuning
  // ======================================================================

  const TS = (TC.CONST && TC.CONST.TS) || 16;
  const T = TC.TILE;

  const POT_DIVISOR = 90;        // one pot per N underground floor-air candidates
  const POT_CAP = 400;           // hard cap per world
  const CRYSTAL_COUNT = 25;      // life crystals per world
  const CRYSTAL_MIN_Y = 200;     // crystals only below this row
  const GEN_SALT = 0x9075;       // "P075" isn't valid hex; reads as POT
  const CHEST_SALT = 0x7e57;     // chest loot hash stream salt

  const CRYSTAL_STEP = 20;       // maxHp gained per life crystal used
  const CRYSTAL_MAX_HP = 400;    // hard ceiling for player.maxHp
  const CRYSTAL_MAX_USES = 15;   // (400 - base 100) / 20
  const CRYSTAL_CD = 0.5;        // seconds between uses

  // Pot break loot: [item id, min, max, weight]. Ids are checked against
  // ITEM_DEFS at break time, so optional siblings (accessories potions)
  // simply drop out when absent. No coin item exists in this codebase, so
  // bars stand in for coins.
  const POT_LOOT = [
    ['torch', 1, 3, 26],
    ['arrow', 3, 8, 22],
    ['heart', 1, 1, 14],
    ['copper_bar', 1, 2, 16],
    ['gold_bar', 1, 1, 6],
    ['regen_potion', 1, 1, 9]
  ];

  // Accessory ids considered for chest loot (only those actually defined).
  const CHEST_ACCESSORIES = ['guard_ring', 'regen_band', 'swift_charm',
    'power_glove', 'aimer_lens', 'vital_amulet'];

  // ======================================================================
  // State + guarded cross-module helpers
  // ======================================================================

  const stats = { potsBroken: 0, crystalsUsed: 0 };

  function reset() {
    stats.potsBroken = 0;
    stats.crystalsUsed = 0;
  }

  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') {
      try { TC.Audio.play(name); } catch (e) {}
    }
  }
  function pBurst(x, y, n, colors, spd) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try { TC.Particles.burst(x, y, n, { colors: colors, speed: spd }); } catch (e) {}
    }
  }
  function floatText(x, y, str, color) {
    if (TC.Particles && typeof TC.Particles.floatText === 'function') {
      try { TC.Particles.floatText(x, y, str, color); } catch (e) {}
    }
  }
  function spawnDrop(x, y, id, count) {
    if (TC.Items && typeof TC.Items.spawnDrop === 'function') {
      try { TC.Items.spawnDrop(x, y, id, count, true); } catch (e) {}
    }
  }
  function hash2(x, y, s) {
    return (TC.Utils && typeof TC.Utils.hash2 === 'function')
      ? TC.Utils.hash2(x, y, s) : 0.5;
  }

  // Remove n of id from a slot; tolerates slot-index or id-based removal.
  function consumeFromSlot(p, slotIdx, id, n) {
    const inv = p.inventory;
    if (!inv || typeof inv.remove !== 'function') return false;
    const read = () => {
      if (typeof inv.get !== 'function') return -1;
      const s = inv.get(slotIdx);
      return (s && s.id === id) ? s.count : 0;
    };
    const before = read();
    if (before <= 0) return false;
    try { inv.remove(slotIdx, n); } catch (e) {}
    if (read() === before) { try { inv.remove(id, n); } catch (e) {} }
    return read() < before;
  }

  // ======================================================================
  // Life crystals — use path + persistence + maxHp maintenance
  // ======================================================================

  function crystalBonus(p) {
    return Math.min(p.lifeCrystals | 0, CRYSTAL_MAX_USES) * CRYSTAL_STEP;
  }

  // Raise maxHp to the crystal floor (never lowers; accessories may add more).
  function ensureCrystalHp(p) {
    const base = (TC.CONST && TC.CONST.PLAYER_HP) || 100;
    const want = Math.min(CRYSTAL_MAX_HP, base + crystalBonus(p));
    if (p.maxHp < want) p.maxHp = want;
  }

  function useLifeCrystal(p, itemId) {
    if (p.dead || (p._crystalCd || 0) > 0) return;
    const cx = p.x + p.w / 2;
    const healCol = (TC.CONST.COLORS && TC.CONST.COLORS.heal) || '#7dff7d';
    const def = TC.ITEM_DEFS ? TC.ITEM_DEFS[itemId] : null;
    const swing = () => {
      p.swingSeq = (p.swingSeq || 0) + 1;
      p.swing = { item: def, timer: 0.45, dur: 0.45, swung: true, loop: false,
        bow: false, id: p.swingSeq };
    };
    if (((TC.CONST && TC.CONST.PLAYER_HP) || 100) + crystalBonus(p) >= CRYSTAL_MAX_HP) {
      floatText(cx, p.y - 6, 'Health is maxed!', healCol);
      swing();
      p._crystalCd = CRYSTAL_CD;
      return;                                    // nothing consumed at the cap
    }
    if (!consumeFromSlot(p, p.hotbarIndex | 0, itemId, 1)) return;
    p._crystalCd = CRYSTAL_CD;
    p.lifeCrystals = (p.lifeCrystals | 0) + 1;
    stats.crystalsUsed++;
    ensureCrystalHp(p);
    p.hp = Math.min(p.maxHp, p.hp + CRYSTAL_STEP);
    sfx('pickup');
    pBurst(cx, p.y + p.h / 2, 10, ['#e23b48', '#ff8a94', '#ffffff'], 90);
    floatText(cx, p.y - 6, '+' + CRYSTAL_STEP + ' max HP', healCol);
    swing();
  }

  // ======================================================================
  // Pot breaking — random small loot via the normal mine path
  // ======================================================================

  function breakPot(tx, ty) {
    stats.potsBroken++;
    const cx = (tx + 0.5) * TS, cy = (ty + 0.5) * TS;
    const pool = POT_LOOT.filter((e) => TC.ITEM_DEFS[e[0]]);
    let rolls = 1 + ((Math.random() * 2) | 0);   // gameplay roll, not worldgen
    while (rolls-- > 0 && pool.length) {
      let total = 0;
      for (let i = 0; i < pool.length; i++) total += pool[i][3];
      let r = Math.random() * total;
      for (let i = 0; i < pool.length; i++) {
        r -= pool[i][3];
        if (r <= 0) {
          const e = pool[i];
          const n = e[1] + ((Math.random() * (e[2] - e[1] + 1)) | 0);
          spawnDrop(cx, cy, e[0], n);
          break;
        }
      }
    }
    sfx('break');
    pBurst(cx, cy, 10, ['#b3623a', '#8a4626', '#5f2f18'], 120);
  }

  // ======================================================================
  // Chest loot — deterministic from the chest position hash
  // ======================================================================

  // Fill an empty chest container at (tx, ty). Same position always yields
  // the same contents regardless of seed or session. Returns bool.
  function populateChest(tx, ty) {
    if (!TC.Chests || typeof TC.Chests.get !== 'function') return false;
    tx |= 0; ty |= 0;
    const slots = TC.Chests.get(tx, ty);
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) return false;                // already filled / touched
    }
    const h = (k) => hash2(tx, ty, CHEST_SALT + k);
    const put = (k, id, min, max) => {
      const n = min + ((h(k) * (max - min + 1)) | 0);
      const start = (h(k + 100) * slots.length) | 0;
      for (let s = 0; s < slots.length; s++) {   // first free slot from hashed start
        const j = (start + s) % slots.length;
        if (!slots[j]) { slots[j] = { id: id, count: n }; return; }
      }
    };
    put(1, 'gold_bar', 3, 6);
    if (h(2) < 0.7) put(3, 'arrow', 8, 18);
    if (h(4) < 0.6) put(5, 'torch', 4, 10);
    if (h(6) < 0.35) {
      const acc = CHEST_ACCESSORIES.filter((id) => TC.ITEM_DEFS[id]);
      if (acc.length) put(7, acc[(h(8) * acc.length) | 0], 1, 1);
    }
    return true;
  }

  // ======================================================================
  // Worldgen post-pass — sprinkle pots + crystals, fill generated chests
  // ======================================================================

  // Partial Fisher-Yates over spot indices; writes id into the picked cells.
  function scatter(tiles, spots, n, id, rng) {
    n = Math.min(n, spots.length);
    for (let k = 0; k < n; k++) {
      const j = k + ((rng() * (spots.length - k)) | 0);
      const t = spots[k]; spots[k] = spots[j]; spots[j] = t;
      tiles[spots[k]] = id;
    }
  }

  function sprinkle(gen, seed) {
    if (!gen || !(gen.tiles instanceof Uint8Array) ||
        T.POT == null || T.LIFE_CRYSTAL == null) return;
    const U = TC.Utils;
    if (!U || typeof U.mulberry32 !== 'function') return;
    const W = gen.width, H = gen.height, tiles = gen.tiles;
    const surf = gen.surfaceY;
    const SOLID = new Uint8Array(TC.TILE_DEFS.length);
    for (let i = 0; i < SOLID.length; i++) SOLID[i] = TC.TILE_DEFS[i].solid ? 1 : 0;
    const rng = U.mulberry32(((seed | 0) ^ GEN_SALT) >>> 0);

    // Candidates: underground AIR cells resting on a solid floor. Water pools
    // exclude themselves (their floor cells hold WATER, not AIR).
    const pots = [], crystals = [];
    for (let y = 1; y < H - 1; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        if (tiles[i] !== T.AIR || SOLID[tiles[i + W]] !== 1) continue;
        if (!surf || y <= surf[x] + 4) continue; // stay below the topsoil
        pots.push(i);
        if (y > CRYSTAL_MIN_Y) crystals.push(i);
      }
    }
    scatter(tiles, pots, Math.min(POT_CAP, (pots.length / POT_DIVISOR) | 0),
      T.POT, rng);
    scatter(tiles, crystals, Math.min(CRYSTAL_COUNT, crystals.length),
      T.LIFE_CRYSTAL, rng);

    // Pre-fill every generated chest (skips ones already holding items).
    if (TC.Chests) {
      for (let i = 0; i < tiles.length; i++) {
        if (tiles[i] === T.CHEST) populateChest(i % W, (i / W) | 0);
      }
    }
  }

  function patchWorldGen() {
    if (!TC.WorldGen || typeof TC.WorldGen.generate !== 'function') return;
    if (TC.WorldGen.__lootWrapped || TC.WorldGen.generate.__lootWrapped) return;
    const orig = TC.WorldGen.generate;
    const wrapped = function (seed) {
      const gen = orig.apply(this, arguments);
      try { sprinkle(gen, seed | 0); } catch (e) {}   // decoration only, never fatal
      return gen;
    };
    wrapped.__lootWrapped = true;
    TC.WorldGen.__lootWrapped = true;
    TC.WorldGen.generate = wrapped;
  }

  // ======================================================================
  // Rendering — POT / LIFE_CRYSTAL overlay (tiles.js leaves unknown patterns
  // blank inside chunk canvases, so these draw after World.draw each frame)
  // ======================================================================

  function rect(g, style, x, y, w, h) { g.fillStyle = style; g.fillRect(x, y, w, h); }

  function drawPot(ctx, px, py) {
    rect(ctx, '#2e1a10', px + 5, py + 3, 6, 2);    // mouth opening
    rect(ctx, '#8a4626', px + 4, py + 5, 8, 1);    // rim
    rect(ctx, '#b3623a', px + 3, py + 6, 10, 7);   // body
    rect(ctx, '#8a4626', px + 11, py + 6, 2, 7);   // shaded side
    rect(ctx, '#c97a4e', px + 4, py + 7, 2, 4);    // highlight
    rect(ctx, '#5f2f18', px + 4, py + 13, 8, 1);   // base shadow
  }

  function drawHeart(ctx, px, py, main, dark, gloss) {
    rect(ctx, main, px + 4, py + 4, 3, 2);         // lobes
    rect(ctx, main, px + 9, py + 4, 3, 2);
    rect(ctx, main, px + 3, py + 6, 10, 2);
    rect(ctx, dark, px + 11, py + 6, 2, 2);
    rect(ctx, main, px + 4, py + 8, 8, 1);
    rect(ctx, main, px + 5, py + 9, 6, 1);
    rect(ctx, main, px + 6, py + 10, 4, 1);
    rect(ctx, main, px + 7, py + 11, 2, 1);
    rect(ctx, gloss, px + 5, py + 5, 1, 1);        // glints
    rect(ctx, gloss, px + 9, py + 5, 1, 1);
  }

  function drawCrystal(ctx, px, py) {
    rect(ctx, '#6d6d6d', px + 3, py + 12, 10, 3);  // rock pedestal
    rect(ctx, '#5a5a5a', px + 3, py + 14, 10, 1);
    drawHeart(ctx, px, py, '#e23b48', '#a31f2c', '#ff9aa4');
  }

  function drawLootTiles(ctx, cam, world) {
    if (!ctx || !cam || !world || !world.tiles) return;
    const vw = ctx.canvas.width / cam.zoom, vh = ctx.canvas.height / cam.zoom;
    const tx0 = Math.max(0, Math.floor(cam.x / TS) - 1);
    const ty0 = Math.max(0, Math.floor(cam.y / TS) - 1);
    const tx1 = Math.min(world.width - 1, Math.ceil((cam.x + vw) / TS) + 1);
    const ty1 = Math.min(world.height - 1, Math.ceil((cam.y + vh) / TS) + 1);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      const row = ty * world.width;
      for (let tx = tx0; tx <= tx1; tx++) {
        const id = world.tiles[row + tx];
        if (id === T.POT) drawPot(ctx, tx * TS, ty * TS);
        else if (id === T.LIFE_CRYSTAL) drawCrystal(ctx, tx * TS, ty * TS);
      }
    }
    ctx.restore();
  }

  // ======================================================================
  // Item icons — hand-painted 16px canvases for the ids added above
  // ======================================================================

  const ICON_PAINTERS = {
    pot(g) {
      rect(g, '#2e1a10', 5, 3, 6, 2);
      rect(g, '#8a4626', 4, 5, 8, 1);
      rect(g, '#b3623a', 3, 6, 10, 7);
      rect(g, '#8a4626', 11, 6, 2, 7);
      rect(g, '#c97a4e', 4, 7, 2, 4);
      rect(g, '#5f2f18', 4, 13, 8, 1);
    },
    life_crystal(g) {
      rect(g, '#6d6d6d', 3, 12, 10, 3);
      rect(g, '#5a5a5a', 3, 14, 10, 1);
      drawHeart(g, 0, 0, '#e23b48', '#a31f2c', '#ff9aa4');
    },
    heart(g) {
      drawHeart(g, 0, 1, '#e23b48', '#a31f2c', '#ff9aa4');
    }
  };

  function patchIcons() {
    if (!TC.Items || typeof TC.Items.iconFor !== 'function' ||
        TC.Items.iconFor.__lootIcons) return;
    const orig = TC.Items.iconFor;
    const cache = new Map();
    const wrapped = function (id) {
      const paint = id && ICON_PAINTERS[id];
      if (paint) {
        let cv = cache.get(id);
        if (!cv) {
          cv = document.createElement('canvas');
          cv.width = 16;
          cv.height = 16;
          paint(cv.getContext('2d'));
          cache.set(id, cv);
        }
        return cv;
      }
      return orig.call(TC.Items, id);
    };
    wrapped.__lootIcons = true;
    TC.Items.iconFor = wrapped;
  }

  // ======================================================================
  // Runtime patches (guarded, idempotent)
  // ======================================================================

  function mark(fn) { fn.__lootWrap = true; return fn; }

  function patchWorld() {
    const WP = TC.World && TC.World.prototype;
    if (!WP || WP.__lootPatched) return;
    WP.__lootPatched = true;

    // Pot loot + break completion for our two tiles. wiring.js's global shim
    // normally writes AIR for any broken tile; this scoped fallback keeps pots
    // and crystals working when wiring.js is absent.
    const origAmd = WP.applyMineDamage;
    WP.applyMineDamage = function (tx, ty, amt) {
      const i = this.inB(tx, ty) ? this.idx(tx, ty) : -1;
      const id = i >= 0 ? this.tiles[i] : -1;
      const broke = origAmd.call(this, tx, ty, amt);
      if (broke && (id === T.POT || id === T.LIFE_CRYSTAL)) {
        if (i >= 0 && this.tiles[i] !== T.AIR) {
          try { this.set(tx, ty, T.AIR); } catch (e) {}
        }
        if (id === T.POT) breakPot(tx, ty);
        // LIFE_CRYSTAL's item drop flows through the vanilla td.drop path.
      }
      return broke;
    };

    // Overlay render chained onto the world's own draw (camera already applied).
    const origDraw = WP.draw;
    WP.draw = function (ctx, cam) {
      origDraw.call(this, ctx, cam);
      try { drawLootTiles(ctx, cam, this); } catch (e) {}
    };
  }

  function patchPlayer() {
    const PP = TC.Player && TC.Player.prototype;
    if (!PP || PP.__lootPatched) return;
    PP.__lootPatched = true;

    // kind 'crystal' consumables short-circuit the normal use switch.
    const origUseHeld = PP.useHeld;
    PP.useHeld = function (dt) {
      const sel = (typeof this.selectedSlot === 'function') ? this.selectedSlot() : null;
      const def = (sel && TC.ITEM_DEFS) ? TC.ITEM_DEFS[sel.id] : null;
      if (def && def.kind === 'crystal') { useLifeCrystal(this, sel.id); return; }
      return origUseHeld.call(this, dt);
    };

    // Cooldown tick + keep maxHp at the crystal floor (covers sessions where
    // accessories.js is absent; with it present both agree on the same value).
    const origUpdate = PP.update;
    PP.update = function (dt) {
      if ((this._crystalCd || 0) > 0) this._crystalCd -= dt;
      ensureCrystalHp(this);
      return origUpdate.call(this, dt);
    };

    // Persist the crystal count alongside the rest of the player blob.
    const origSerialize = PP.serialize;
    PP.serialize = function () {
      const data = origSerialize ? origSerialize.call(this) : {};
      if (data && typeof data === 'object') data.lifeCrystals = this.lifeCrystals | 0;
      return data;
    };

    // Restore crystals, re-raise maxHp, then re-clamp hp against the raised cap
    // (the vanilla deserialize clamps hp to the default maxHp first).
    if (typeof TC.Player.deserialize === 'function' && !TC.Player.deserialize.__lootWrap) {
      const origDeserialize = TC.Player.deserialize;
      TC.Player.deserialize = mark(function (data) {
        const p = origDeserialize.call(this, data);
        if (p && data && typeof data === 'object') {
          const n = data.lifeCrystals;
          p.lifeCrystals = (typeof n === 'number' && isFinite(n))
            ? Math.max(0, Math.min(n | 0, CRYSTAL_MAX_USES)) : 0;
          ensureCrystalHp(p);
          const hp = data.hp;
          if (typeof hp === 'number' && isFinite(hp)) {
            p.hp = Math.min(p.maxHp, Math.max(1, hp));
          }
        }
        return p;
      });
    }
  }

  // Fold the crystal bonus into the accessory/buff mod sum so accessories.js's
  // syncMaxHp (want = PLAYER_HP + mods.maxHp) keeps the crystal gains instead
  // of resetting maxHp to the gear-only value every frame.
  function hookAccessories() {
    const Acc = TC.Accessories;
    if (!Acc || typeof Acc.modsOf !== 'function' ||
        (Acc.modsOf.__lootWrap)) return;
    const origModsOf = Acc.modsOf;
    Acc.modsOf = mark(function (player) {
      const m = origModsOf.call(this, player);
      if (m && player && player.lifeCrystals) m.maxHp += crystalBonus(player);
      return m;
    });
  }

  function patchFlow() {
    if (typeof TC.newGame === 'function' && !TC.newGame.__lootWrap) {
      const origNew = TC.newGame;
      TC.newGame = mark(function (seed) {
        const r = origNew.call(TC, seed);
        reset();                                 // fresh world: fresh loot stats
        return r;
      });
    }
  }

  // ======================================================================
  // Install — prototype patches need all sibling scripts loaded, so defer to
  // DOMContentLoaded when loot.js sits before them (sync scripts have all run
  // by then). Same approach as wiring.js.
  // ======================================================================

  function install() {
    patchWorldGen();
    patchWorld();
    patchPlayer();
    patchIcons();
    hookAccessories();
    patchFlow();
  }

  patchWorldGen();   // worldgen.js precedes this file per the required placement
  if (typeof document === 'undefined' || document.readyState !== 'loading') {
    install();
  } else {
    document.addEventListener('DOMContentLoaded', install);
  }

  TC.Loot = { reset, populateChest, stats };
})();

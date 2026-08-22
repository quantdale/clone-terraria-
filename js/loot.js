/* loot.js — TC.Loot: breakable pots, life crystals, and treasure.

   Owns exactly this file. Foundation-contract edition: NO monkey patching.
   This module EXTENDS the shared tables at load time (constants.js /
   main.js / index.html are lead-owned), subscribes to TC.Events for
   reactions, registers a TC.SaveCore provider for persistence, and exposes
   plain functions the lead calls from the game loop / useHeld switch.

   - Table extensions (promote into constants.js when convenient):
     TC.TILE:      POT, LIFE_CRYSTAL
     TC.TILE_DEFS: matching defs appended
     TC.ITEM_DEFS: pot (placeable), life_crystal (kind 'crystal'), heart

   - Exposed surface:
     TC.Loot.reset()                    zero the stats counters (fresh world)
     TC.Loot.stats                      { potsBroken, crystalsUsed }
     TC.Loot.populateWorld(gen, seed)   deterministic worldgen post-pass:
                                        pots sprinkled on underground cave
                                        floors (~1 per 90 candidate tiles, cap
                                        400), ~25 life crystals below y=200,
                                        generated CHEST tiles pre-filled with
                                        position-hash loot. Call from
                                        buildWorld right after
                                        WorldGen.generate; `seed` falls back
                                        to TC.worldSeed when omitted. Returns
                                        gen. Decoration only — never throws.
     TC.Loot.onTileBroken(tx, ty)       scatter pot loot for one broken POT.
                                        Exactly one path per break: either
                                        call this directly from your break
                                        completion OR rely on the built-in
                                        TileBroken subscription below — never
                                        both (double scatter).
     TC.Loot.onUseHeld(player, def, dt) -> bool
                                        true when def.kind is 'crystal' and
                                        the use was fully handled (at the HP
                                        cap it swings + cooldowns without
                                        consuming — still true).
     TC.Loot.update(player, dt)         crystal cooldown tick + maxHp floor
                                        maintenance (covers sessions where
                                        accessories.js is absent). Call once
                                        per frame after player.update.
     TC.Loot.drawTiles(ctx, cam, world) world-space overlay painting POT /
                                        LIFE_CRYSTAL (tiles.js renders their
                                        patterns blank). Call after
                                        TC.world.draw while the camera
                                        transform is active.
     TC.Loot.iconFor(id) -> canvas|null hand-painted 16px icons for pot /
                                        life_crystal / heart; null otherwise.
     TC.Loot.crystalBonus(player)       flat maxHp granted by the player's
                                        crystal count (cap 15 * 20). Fold this
                                        into accessory mod sums so
                                        accessories.js syncMaxHp keeps the
                                        crystal gains instead of clobbering
                                        them each frame.
     TC.SaveCore 'character.core.loot'  provider persisting
                                        { lifeCrystals, hp } from/to the live
                                        player object (field player.lifeCrystals
                                        unchanged); deserialize re-raises
                                        maxHp then re-clamps hp, mirroring the
                                        old Player.deserialize wrap.

   - Event wiring (guarded; no-ops when the bus is absent):
     TileBroken   -> pot loot scatter (payload.tile === POT)
     WorldLoaded  -> reset()
     WorldProgressChanged <- emitted on each life crystal consumed

   INTEGRATION (one line each, lead-owned files):
     main.js buildWorld(), right after `const gen = ...` generate call:
       if (TC.Loot) TC.Loot.populateWorld(gen, seed);
     main.js step(), after `TC.player.update(dt)`:
       if (TC.Loot && TC.player) TC.Loot.update(TC.player, dt);
     main.js draw(), after `TC.world.draw(ctx, cam)`:
       if (TC.Loot) TC.Loot.drawTiles(ctx, cam, TC.world);
     main.js newGame(): if (TC.Loot) TC.Loot.reset();
     player.js useHeld(), after resolving sel/def and BEFORE the kind switch:
       if (TC.Loot && def && TC.Loot.onUseHeld(this, def, dt)) return;
     items.js iconFor(), before its own painters:
       const gic = (TC.Gear && TC.Gear.iconFor(key)) ||
                   (TC.Loot && TC.Loot.iconFor(key));
       if (gic) return gic;
     accessories.js combinedMods(), after summing gear/buff mods:
       m.maxHp += (TC.Loot && TC.Loot.crystalBonus) ?
         TC.Loot.crystalBonus(player) : 0;

   Pot/crystal break COMPLETION (writing AIR) is upstream's job now — the
   MineTile command / migrated doMine tail does it and emits TileBroken; this
   module no longer patches applyMineDamage to compensate. */
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
    lastPotIdx = -1;
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

  // Observation only; a missing or misbehaving bus never breaks gameplay.
  function emit(name, payload) {
    if (TC.Events && TC.Events.EVENT && typeof TC.Events.emit === 'function') {
      try { TC.Events.emit(name, payload); } catch (e) {}
    }
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

  // Flat maxHp the player's crystal count grants (exported accessor: fold
  // into accessory/buff mod sums so syncMaxHp keeps the crystal gains).
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
    emit(TC.Events.EVENT.WorldProgressChanged,
      { kind: 'lifeCrystal', lifeCrystals: p.lifeCrystals, maxHp: p.maxHp });
  }

  // Lead-facing hook (was a Player.prototype.useHeld wrap): fully handles one
  // use of a kind 'crystal' item. True = the vanilla switch must not run.
  function onUseHeld(player, def, dt) {
    if (!player || !def || def.kind !== 'crystal') return false;
    const sel = (typeof player.selectedSlot === 'function') ? player.selectedSlot() : null;
    const itemId = (sel && TC.ITEM_DEFS && TC.ITEM_DEFS[sel.id] === def) ? sel.id : null;
    if (!itemId) return false;
    useLifeCrystal(player, itemId);            // dt unused: uses are click-paced
    return true;
  }

  // Per-frame maintenance (was a Player.prototype.update wrap): cooldown tick
  // + keep maxHp at the crystal floor when no accessory sync would.
  function update(player, dt) {
    if (!player || !(dt > 0)) return;
    if ((player._crystalCd || 0) > 0) player._crystalCd -= dt;
    ensureCrystalHp(player);
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

  // Lead-facing hook for one broken POT tile. Prefer the built-in TileBroken
  // subscription (below) over calling this directly — exactly one path per
  // break, or the loot scatters twice.
  // Idempotence guard: a duplicate TileBroken for the same pot cell (two
  // emitters, or an event replay) must not scatter loot twice.
  let lastPotIdx = -1;
  function onTileBroken(tx, ty) {
    tx |= 0; ty |= 0;
    const idx = TC.world ? ty * TC.world.width + tx : tx * 100000 + ty;
    if (idx === lastPotIdx) return;
    lastPotIdx = idx;
    breakPot(tx, ty);
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
  // (was a WorldGen.generate wrap; the lead calls populateWorld(gen, seed)
  // from buildWorld instead)
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

  // Deterministic post-pass over a freshly generated world. Decoration only:
  // a failure here must never fail worldgen (same contract as the old wrap).
  function populateWorld(gen, seed) {
    if (seed == null) seed = (typeof TC.worldSeed === 'number') ? TC.worldSeed : 0;
    try { sprinkle(gen, seed | 0); } catch (e) {}
    return gen;
  }

  // ======================================================================
  // Rendering — POT / LIFE_CRYSTAL overlay (tiles.js leaves unknown patterns
  // blank inside chunk canvases, so these draw after World.draw each frame;
  // lead calls drawTiles(ctx, cam, world) under the camera transform)
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
  // Item icons — hand-painted 16px canvases for the ids added above; the
  // lead's items.js iconFor consults TC.Loot.iconFor first.
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

  const iconCache = new Map();

  // Canvas for a loot item id, or null when the id is not ours.
  function iconFor(id) {
    const paint = id && ICON_PAINTERS[id];
    if (!paint) return null;
    let cv = iconCache.get(id);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = 16;
      cv.height = 16;
      paint(cv.getContext('2d'));
      iconCache.set(id, cv);
    }
    return cv;
  }

  // ======================================================================
  // Persistence — SaveCore provider (was Player.serialize/deserialize wraps).
  // The live field stays player.lifeCrystals; the provider mirrors it into
  // the envelope and restores it (re-raising maxHp, then re-clamping hp
  // against the raised cap — the vanilla deserialize clamps hp to the
  // default maxHp first, so restore must run after player creation).
  // ======================================================================

  if (TC.SaveCore && typeof TC.SaveCore.register === 'function') {
    try {
      TC.SaveCore.register('character.core.loot', {
        version: 1,
        serialize(ctx) {
          const p = ctx ? ctx.player : null;
          return {
            lifeCrystals: p ? (p.lifeCrystals | 0) : 0,
            hp: p ? p.hp : 0
          };
        },
        deserialize(data, ctx) {
          const p = ctx ? ctx.player : null;
          if (!p || !data || typeof data !== 'object') return;
          const n = data.lifeCrystals;
          p.lifeCrystals = (typeof n === 'number' && isFinite(n))
            ? Math.max(0, Math.min(n | 0, CRYSTAL_MAX_USES)) : 0;
          ensureCrystalHp(p);
          const hp = data.hp;
          if (typeof hp === 'number' && isFinite(hp)) {
            p.hp = Math.min(p.maxHp, Math.max(1, hp));
          }
        }
      });
    } catch (e) {
      console.warn('[TC.Loot] SaveCore provider refused:', e && e.message);
    }
  }

  // ======================================================================
  // Event wiring — reactions only, installed once at load (guarded).
  // ======================================================================

  if (TC.Events && TC.Events.EVENT && typeof TC.Events.on === 'function') {
    // Pot loot rides the canonical break event (commands.js MineTile emits
    // it after break completion). Do NOT also call onTileBroken by hand.
    TC.Events.on(TC.Events.EVENT.TileBroken, function (p) {
      if (p && p.tile === T.POT) onTileBroken(p.tx, p.ty);
    });
    // A pot re-placed onto a previously broken cell re-arms its scatter.
    TC.Events.on(TC.Events.EVENT.TileChanged, function (p) {
      if (p && p.id != null && p.id !== 0 && lastPotIdx === p.ty * (TC.world ? TC.world.width : 0) + p.tx) {
        lastPotIdx = -1;
      }
    });
    // Fresh world: fresh loot stats (reset() stays public for direct calls).
    TC.Events.on(TC.Events.EVENT.WorldLoaded, function () { reset(); });
  }

  // ======================================================================
  // Public API
  // ======================================================================

  TC.Loot = {
    reset, stats, populateChest, populateWorld,
    onTileBroken, onUseHeld, update,
    drawTiles: drawLootTiles, iconFor, crystalBonus
  };
})();

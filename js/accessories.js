/* accessories.js — TC.Accessories (5 accessory equip slots, stat modifiers,
   reforge-style prefix stub) + TC.Buffs (timed buffs/debuffs: ironskin,
   regeneration, swiftness, wrath, poisoned, burning, slowed) with stat mods,
   ambient particle icons, a HUD buff-icon row, and potion consumables.

   Self-integrating via guarded runtime wraps (this file owns nothing else):
     - Player.prototype.totalDefense  += accessory/buff/prefix defense
     - Player.prototype.update        ticks buffs, applies move/regen/maxHp mods
     - Player.prototype.useHeld       intercepts kind:'potion' items
     - Player.prototype.serialize /
       Player.deserialize             persists accessories + buffs in the save blob
     - Combat.meleeStrike/shootArrow  scale outgoing damage
     - Combat.hurtPlayer              lava hits apply the 'burning' debuff
     - Items.iconFor                  paints icons for the items added below
     - UI.draw                        appends the active-buff icon row (top right)
     - newGame/continueGame/quitToTitle reset buff state

   Lead-owned files need NO edits except index.html: add
     <script src="js/accessories.js"></script>
   anywhere after js/player.js (hooks poll until each target module exists, so
   any sibling order works). Item defs and recipes are appended to
   TC.ITEM_DEFS / TC.RECIPES from here, so constants.js stays untouched.

   Suggested AGENTS.md contract rows (lead-owned doc):
     | accessories.js | TC.Accessories: SLOT_COUNT(5), slotsOf/equip/unequip,
       modsOf, serialize/deserialize, PREFIX_DEFS + rollPrefix (stub) |
     | TC.Buffs: DEFS, list, apply/remove/has/clear, modsOf, tick, drawIcons,
       serialize/deserialize |

   Prefix stub status: PREFIX_DEFS + deterministic rollPrefix exist and merge
   into stat mods, but no reforge station/UI wiring yet — a future crafting
   recipe would call Accessories.rollPrefix(id, seed) and store the result on
   the equipped entry's .prefix field (already serialized).
*/
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Accessories || TC.Buffs) return;   // already installed

  const U = TC.Utils || {};
  const hash2 = (typeof U.hash2 === 'function') ? U.hash2 : function () { return 0; };

  // ====================================================================
  // Data tables
  // ====================================================================

  // Stat modifier fields understood everywhere in this module:
  //   defense (flat), regen (hp/s), moveSpeed (multiplier),
  //   meleeDmg / rangedDmg (multipliers), critChance (+flat), maxHp (flat)
  const ACCESSORY_DEFS = {
    guard_ring:   { name: 'Ring of Guarding',   kind: 'accessory', maxStack: 1,
                    mods: { defense: 2 }, color: '#c0c0cc' },
    regen_band:   { name: 'Band of Renewal',    kind: 'accessory', maxStack: 1,
                    mods: { regen: 1.5 }, color: '#ffd24a' },
    swift_charm:  { name: 'Swift Charm',        kind: 'accessory', maxStack: 1,
                    mods: { moveSpeed: 1.18 }, color: '#5ad0e8' },
    power_glove:  { name: 'Power Glove',        kind: 'accessory', maxStack: 1,
                    mods: { meleeDmg: 1.15 }, color: '#b05a3a' },
    aimer_lens:   { name: "Aimer's Lens",       kind: 'accessory', maxStack: 1,
                    mods: { rangedDmg: 1.15 }, color: '#9adcf0' },
    vital_amulet: { name: 'Amulet of Vitality', kind: 'accessory', maxStack: 1,
                    mods: { maxHp: 20 }, color: '#e23b3b' }
  };

  const POTION_DEFS = {
    ironskin_potion:  { name: 'Ironskin Potion',     kind: 'potion', maxStack: 20,
                        buff: 'ironskin',     time: 50, color: '#aeb8c8' },
    regen_potion:     { name: 'Regeneration Potion', kind: 'potion', maxStack: 20,
                        buff: 'regeneration', time: 45, color: '#6ee06e' },
    swiftness_potion: { name: 'Swiftness Potion',    kind: 'potion', maxStack: 20,
                        buff: 'swiftness',    time: 60, color: '#5ad0e8' },
    wrath_potion:     { name: 'Wrath Potion',        kind: 'potion', maxStack: 20,
                        buff: 'wrath',        time: 30, color: '#e85a48' }
  };

  // Appended to TC.RECIPES at load; shape matches constants.js entries.
  const EXTRA_RECIPES = [
    { out: 'guard_ring',       n: 1, station: 'anvil',     cost: { iron_bar: 6 } },
    { out: 'regen_band',       n: 1, station: 'anvil',     cost: { gold_bar: 4, gel: 10 } },
    { out: 'swift_charm',      n: 1, station: 'anvil',     cost: { gold_bar: 3, iron_bar: 4 } },
    { out: 'power_glove',      n: 1, station: 'anvil',     cost: { iron_bar: 8, gold_bar: 2 } },
    { out: 'aimer_lens',       n: 1, station: 'anvil',     cost: { glass: 4, gold_bar: 2 } },
    { out: 'vital_amulet',     n: 1, station: 'anvil',     cost: { gold_bar: 8, gel: 12 } },
    { out: 'ironskin_potion',  n: 1, station: 'workbench', cost: { gel: 5, iron_bar: 1 } },
    { out: 'regen_potion',     n: 1, station: 'workbench', cost: { gel: 5, copper_bar: 1 } },
    { out: 'swiftness_potion', n: 1, station: 'workbench', cost: { gel: 5, iron_ore: 3 } },
    { out: 'wrath_potion',     n: 1, station: 'workbench', cost: { gel: 8, gold_ore: 3 } }
  ];

  const BUFF_DEFS = {
    ironskin:     { name: 'Ironskin',     good: true,  dur: 50, color: '#b8c0cc',
                    mods: { defense: 8 }, parts: ['#c8d0dc', '#98a2b2'], rate: 6 },
    regeneration: { name: 'Regeneration', good: true,  dur: 40, color: '#6ee06e',
                    mods: { regen: 2 }, parts: ['#8ef08e', '#4ec44e'], rate: 7 },
    swiftness:    { name: 'Swiftness',    good: true,  dur: 60, color: '#5ad0e8',
                    mods: { moveSpeed: 1.25 }, parts: ['#8ae4f4', '#38aecb'], rate: 9 },
    wrath:        { name: 'Wrath',        good: true,  dur: 30, color: '#e85a48',
                    mods: { meleeDmg: 1.2, rangedDmg: 1.2 },
                    parts: ['#ff8a6a', '#c83a2a'], rate: 7 },
    poisoned:     { name: 'Poisoned',     good: false, dps: 2, color: '#7ac74f',
                    parts: ['#9ade6e', '#589c32'], rate: 5 },
    burning:      { name: 'Burning',      good: false, dps: 6, color: '#ff7a30',
                    parts: ['#ffb03a', '#e85a1a'], rate: 14 },
    slowed:       { name: 'Slowed',       good: false, color: '#9a8ad0',
                    mods: { moveSpeed: 0.55 }, parts: ['#b8a8e8', '#786aa8'], rate: 4 }
  };

  // Reforge-style prefixes (stub): positive tier 1, negative tier -1.
  const PREFIX_DEFS = {
    none:    { name: '',              tier: 0,  mods: {} },
    quick:   { name: 'Quick',         tier: 1,  mods: { moveSpeed: 1.08 } },
    mighty:  { name: 'Mighty',        tier: 1,  mods: { meleeDmg: 1.08 } },
    guarded: { name: 'Guarded',       tier: 1,  mods: { defense: 1 } },
    lucky:   { name: 'Lucky',         tier: 1,  mods: { critChance: 0.03 } },
    heavy:   { name: 'Heavy',         tier: -1, mods: { meleeDmg: 1.12, moveSpeed: 0.92 } },
    dull:    { name: 'Dull',          tier: -1, mods: { meleeDmg: 0.9, rangedDmg: 0.9 } }
  };
  const POS_PREFIXES = ['quick', 'mighty', 'guarded', 'lucky'];
  const NEG_PREFIXES = ['heavy', 'dull'];

  // Append our defs/recipes to the lead-owned registries (no constants.js edit).
  function installDefs() {
    if (!TC.CONST) return false;              // constants.js not loaded yet
    if (!TC.ITEM_DEFS) TC.ITEM_DEFS = {};
    let id;
    for (id in ACCESSORY_DEFS) if (!TC.ITEM_DEFS[id]) TC.ITEM_DEFS[id] = ACCESSORY_DEFS[id];
    for (id in POTION_DEFS) if (!TC.ITEM_DEFS[id]) TC.ITEM_DEFS[id] = POTION_DEFS[id];
    if (Array.isArray(TC.RECIPES)) {
      const have = {};
      for (let i = 0; i < TC.RECIPES.length; i++) have[TC.RECIPES[i].out] = true;
      for (let i = 0; i < EXTRA_RECIPES.length; i++) {
        if (!have[EXTRA_RECIPES[i].out]) TC.RECIPES.push(EXTRA_RECIPES[i]);
      }
    }
    return true;
  }

  // ====================================================================
  // Small guarded helpers
  // ====================================================================

  function itemDef(id) { return (TC.ITEM_DEFS && id) ? TC.ITEM_DEFS[id] : null; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') {
      try { TC.Audio.play(name); } catch (e) {}
    }
  }
  function floatText(x, y, str, color) {
    if (TC.Particles && typeof TC.Particles.floatText === 'function') {
      try { TC.Particles.floatText(x, y, str, color); } catch (e) {}
    }
  }
  function burst(x, y, n, colors, speed) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try { TC.Particles.burst(x, y, n, { colors: colors, speed: speed }); } catch (e) {}
    }
  }
  function spawnP(x, y, vx, vy, life, color) {
    if (TC.Particles && typeof TC.Particles.spawn === 'function') {
      try { TC.Particles.spawn({ x: x, y: y, vx: vx, vy: vy, life: life, size: 2,
        color: color, gravity: -20 }); } catch (e) {}
    }
  }

  // FNV-1a over a string -> uint32; deterministic, no Math.random.
  function strHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // ---- stat-mod aggregation ----

  function zeroMods() {
    return { defense: 0, regen: 0, moveSpeed: 1, meleeDmg: 1, rangedDmg: 1,
             critChance: 0, maxHp: 0 };
  }
  function addMods(out, mods) {
    if (!mods) return out;
    out.defense += mods.defense || 0;
    out.regen += mods.regen || 0;
    out.moveSpeed *= (mods.moveSpeed > 0) ? mods.moveSpeed : 1;
    out.meleeDmg *= (mods.meleeDmg > 0) ? mods.meleeDmg : 1;
    out.rangedDmg *= (mods.rangedDmg > 0) ? mods.rangedDmg : 1;
    out.critChance += mods.critChance || 0;
    out.maxHp += mods.maxHp || 0;
    return out;
  }
  function combinedMods(player) {
    const m = zeroMods();
    addMods(m, TC.Accessories.modsOf(player));
    addMods(m, TC.Buffs.modsOf());
    return m;
  }

  // Remove n of id from the player's selected hotbar slot; tolerates
  // slot-index or id-based Inventory.remove (same pattern as player.js).
  function consumeSelected(p, id, n) {
    const inv = p.inventory;
    if (!inv || typeof inv.remove !== 'function') return false;
    const idx = p.hotbarIndex | 0;
    const read = () => {
      if (typeof inv.get !== 'function') return -1;
      const s = inv.get(idx);
      return (s && s.id === id) ? s.count : 0;
    };
    const before = read();
    if (before <= 0) return false;
    try { inv.remove(idx, n); } catch (e) {}
    if (read() === before) { try { inv.remove(id, n); } catch (e) {} }
    return read() < before;
  }

  // ====================================================================
  // TC.Accessories — five equip slots of passive stat modifiers
  // ====================================================================

  const SLOT_COUNT = 5;

  const Acc = TC.Accessories = {
    SLOT_COUNT: SLOT_COUNT,
    PREFIX_DEFS: PREFIX_DEFS,

    // Equipped entries live on the player instance (lazy-attached):
    // player.accessories = [null | {id, prefix}, x5]
    slotsOf(player) {
      if (!player) return null;
      if (!Array.isArray(player.accessories)) {
        player.accessories = new Array(SLOT_COUNT).fill(null);
      }
      return player.accessories;
    },

    // Swap the inventory stack at invIndex with accessory slot slotIndex.
    // Only kind:'accessory' items may be worn. Returns bool.
    equip(player, invIndex, slotIndex) {
      const inv = player && player.inventory;
      if (!inv || typeof inv.get !== 'function') return false;
      const slots = Acc.slotsOf(player);
      if (!slots || slotIndex < 0 || slotIndex >= SLOT_COUNT) return false;
      const idx = invIndex | 0;
      const sel = inv.get(idx);
      const cur = slots[slotIndex];
      const selDef = sel ? itemDef(sel.id) : null;
      if (!cur && !(selDef && selDef.kind === 'accessory')) return false;

      if (cur && !sel) {                      // unequip worn piece into the bag
        let ok = false;
        if (typeof inv.swapOrPlace === 'function') {
          try { inv.swapOrPlace(idx, { id: cur.id, count: 1 }); ok = true; } catch (e) {}
        }
        if (!ok) return false;
        slots[slotIndex] = null;
      } else if (selDef && selDef.kind === 'accessory') {
        let wearId = sel.id;
        if (cur) {                            // stow worn piece, wear what returns
          let back = null;
          try { back = inv.swapOrPlace(idx, { id: cur.id, count: 1 }); } catch (e) { return false; }
          if (back) {
            const bd = itemDef(back.id);
            if (!(bd && bd.kind === 'accessory')) return false;
            wearId = back.id;
          }
        } else {                              // take the selected stack out
          let took = false;
          if (typeof inv.swapOrPlace === 'function') {
            try { inv.swapOrPlace(idx, null); took = true; } catch (e) {}
          }
          if (!took && Array.isArray(inv.slots)) {
            try { inv.slots[idx] = null; took = true; } catch (e) {}
          }
          if (!took) return false;
        }
        const keepPrefix = (cur && cur.id === wearId) ? (cur.prefix || null) : null;
        slots[slotIndex] = { id: wearId, prefix: keepPrefix };
      } else {
        return false;                         // selected item is not an accessory
      }
      sfx('pickup');
      return true;
    },

    // Move a worn accessory back to the bag (first free slot unless invIndex given).
    unequip(player, slotIndex, invIndex) {
      const inv = player && player.inventory;
      const slots = Acc.slotsOf(player);
      if (!inv || !slots) return false;
      const cur = slots[slotIndex];
      if (!cur) return false;
      let target = (invIndex != null) ? (invIndex | 0) : -1;
      if (target < 0) {
        const n = (Array.isArray(inv.slots) && inv.slots.length) ? inv.slots.length : 50;
        for (let i = 0; i < n; i++) {
          const s = (typeof inv.get === 'function') ? inv.get(i) : (inv.slots[i] || null);
          if (!s) { target = i; break; }
        }
      }
      if (target < 0) return false;
      const occ = (typeof inv.get === 'function') ? inv.get(target)
        : (Array.isArray(inv.slots) ? inv.slots[target] : {});
      if (occ) return false;                  // refuse to overwrite a stack
      let ok = false;
      if (typeof inv.swapOrPlace === 'function') {
        try { inv.swapOrPlace(target, { id: cur.id, count: 1 }); ok = true; } catch (e) {}
      }
      if (!ok && Array.isArray(inv.slots)) {
        try { inv.slots[target] = { id: cur.id, count: 1 }; ok = true; } catch (e) {}
      }
      if (!ok) return false;
      slots[slotIndex] = null;
      sfx('pickup');
      return true;
    },

    // Aggregate stat modifiers from everything worn.
    modsOf(player) {
      const m = zeroMods();
      const slots = (player && Array.isArray(player.accessories)) ? player.accessories : null;
      if (!slots) return m;
      for (let i = 0; i < slots.length && i < SLOT_COUNT; i++) {
        const e = slots[i];
        if (!e) continue;
        const d = itemDef(e.id);
        if (!d || d.kind !== 'accessory') continue;
        addMods(m, d.mods);
        if (e.prefix) addMods(m, Acc.prefixMods(e.prefix));
      }
      return m;
    },

    prefixMods(prefixId) {
      const p = PREFIX_DEFS[prefixId];
      return p ? p.mods : null;
    },

    // Deterministic pseudo-reforge pick: same (itemId, seed) -> same prefix.
    // Stub: nothing calls this yet; a reforge feature would store the result
    // on the equipped entry's .prefix field (already serialized above).
    rollPrefix(itemId, seed) {
      const h = strHash(String(itemId) + '|' + String(seed));
      const r = hash2(h, 0x51ed, 0xacce);
      if (r < 0.34) return 'none';
      const pool = (r < 0.78) ? POS_PREFIXES : NEG_PREFIXES;
      return pool[(hash2(h, 0x9e37, 0x7f4a) * pool.length) | 0];
    },

    serialize(player) {
      const slots = Acc.slotsOf(player);
      if (!slots) return null;
      const out = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        const e = slots[i];
        out[i] = e ? { id: e.id, prefix: e.prefix || null } : null;
      }
      return out;
    },

    deserialize(player, data) {
      const slots = Acc.slotsOf(player);
      if (!slots || !Array.isArray(data)) return false;
      for (let i = 0; i < SLOT_COUNT && i < data.length; i++) {
        const e = data[i];
        if (!e || typeof e !== 'object') { slots[i] = null; continue; }
        const d = itemDef(e.id);
        slots[i] = (d && d.kind === 'accessory')
          ? { id: e.id, prefix: (e.prefix && PREFIX_DEFS[e.prefix]) ? e.prefix : null }
          : null;
      }
      return true;
    }
  };

  // ====================================================================
  // TC.Buffs — timed buffs/debuffs on the current player
  // ====================================================================

  const MAX_ACTIVE = 12;
  const list = [];   // active entries: {id, time, dur, pool}

  function findBuff(id) {
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  const Buffs = TC.Buffs = {
    DEFS: BUFF_DEFS,
    list: list,

    // Apply/refresh a buff on the player (defaults to TC.player). Re-applying
    // extends to the longer of the remaining/new duration (Terraria-style).
    apply(id, dur, player) {
      const d = BUFF_DEFS[id];
      if (!d) return false;
      const p = player || TC.player;
      if (!p || p.dead) return false;
      const t = (dur != null && dur > 0) ? dur : (d.dur || 30);
      const cur = findBuff(id);
      if (cur) { cur.time = Math.max(cur.time, t); return true; }
      if (list.length >= MAX_ACTIVE) list.shift();
      list.push({ id: id, time: t, dur: t, pool: 0 });
      floatText(p.x + p.w / 2, p.y - 12, d.name, d.color);
      return true;
    },

    remove(id) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].id === id) { list.splice(i, 1); return true; }
      }
      return false;
    },

    has(id) { return !!findBuff(id); },

    clear() { list.length = 0; },

    modsOf() {
      const m = zeroMods();
      for (let i = 0; i < list.length; i++) {
        const d = BUFF_DEFS[list[i].id];
        if (d) addMods(m, d.mods);
      }
      return m;
    },

    // Per-step upkeep: timers, damage-over-time, ambient particle icons.
    // Driven by the wrapped Player.update; safe to call manually too.
    tick(dt, player) {
      if (!player) return;
      if (player.dead) { if (list.length) list.length = 0; return; }
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        b.time -= dt;
        if (b.time <= 0) { list.splice(i, 1); continue; }
        const d = BUFF_DEFS[b.id];
        if (d && d.dps > 0) dotDamage(b, player, d, dt);
      }
      emitParticles(dt, player);
    },

    // Screen-space HUD row under the hearts/breath bubbles, right-aligned.
    drawIcons(ctx, w, h) {
      if (!ctx || TC.state !== 'playing' || !list.length) return;
      const p = TC.player;
      if (!p || p.dead) return;
      const S = 22, GAP = 4, Y = 56;
      ctx.save();
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let x = w - 14 - S;
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const d = BUFF_DEFS[b.id];
        if (!d) continue;
        ctx.fillStyle = 'rgba(16,12,22,0.82)';
        ctx.fillRect(x, Y, S, S);
        ctx.lineWidth = 1;
        ctx.strokeStyle = d.color;
        ctx.strokeRect(x + 0.5, Y + 0.5, S - 1, S - 1);
        const words = d.name.split(' ');
        const glyph = (words.length > 1 ? words[0].charAt(0) + words[1].charAt(0)
          : d.name.slice(0, 2)).toUpperCase();
        ctx.fillStyle = d.color;
        ctx.fillText(glyph, x + S / 2, Y + S / 2 - 2);
        const frac = clamp01(b.dur > 0 ? b.time / b.dur : 0);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillRect(x + 2, Y + S - 4, (S - 4) * frac, 2);
        x -= S + GAP;
      }
      ctx.restore();
    },

    // [[id, secondsRemaining], ...]
    serialize() {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        out.push([list[i].id, Math.round(list[i].time * 10) / 10]);
      }
      return out;
    },

    deserialize(data) {
      list.length = 0;
      if (!Array.isArray(data)) return false;
      for (let i = 0; i < data.length && i < MAX_ACTIVE; i++) {
        const e = data[i];
        if (!Array.isArray(e) || !BUFF_DEFS[e[0]]) continue;
        const defDur = BUFF_DEFS[e[0]].dur || 30;
        const t = (typeof e[1] === 'number' && isFinite(e[1]))
          ? Math.min(Math.max(e[1], 0.1), 600) : defDur;
        list.push({ id: e[0], time: t, dur: t, pool: 0 });
      }
      return true;
    }
  };

  // Damage-over-time bypasses player.damage() on purpose: that path grants
  // iframes, so a poison tick would shield the player from real enemy hits.
  function dotDamage(b, p, d, dt) {
    b.pool += d.dps * dt;
    if (b.pool < 1) return;
    const n = Math.floor(b.pool);
    b.pool -= n;
    if (p.dead || typeof p.hp !== 'number') return;
    p.hp -= n;
    floatText(p.x + p.w / 2, p.y - 4, '-' + n, d.color);
    burst(p.x + p.w / 2, p.y + p.h / 2, 3, d.parts || [d.color], 60);
    if (p.hp <= 0) {
      p.hp = 0;
      if (typeof p.die === 'function') { try { p.die(); } catch (e) {} }
    }
  }

  // Ambient colored motes rising around the player, one per active buff.
  let partT = 0;
  function emitParticles(dt, p) {
    partT -= dt;
    if (partT > 0 || !list.length) return;
    partT = 0.12;
    const cx = p.x + p.w / 2, top = p.y + 4, hh = p.h - 8;
    for (let i = 0; i < list.length; i++) {
      const d = BUFF_DEFS[list[i].id];
      if (!d || !d.parts) continue;
      spawnP(cx + (Math.random() - 0.5) * (p.w + 8),
             top + Math.random() * hh,
             (Math.random() - 0.5) * 14, -26 - Math.random() * 22,
             0.5 + Math.random() * 0.3,
             d.parts[(Math.random() * d.parts.length) | 0]);
    }
  }

  // ====================================================================
  // Potion consumables (kind:'potion'), intercepted in Player.useHeld
  // ====================================================================

  function drinkPotion(p, def, itemId) {
    if ((p._potionCd || 0) > 0) return;
    if (!consumeSelected(p, itemId, 1)) return;
    p._potionCd = 0.8;
    Buffs.apply(def.buff, def.time, p);
    sfx('pickup');
    burst(p.x + p.w / 2, p.y + p.h / 2, 8, [def.color || '#ffffff', '#ffffff'], 80);
    p.swingSeq = (p.swingSeq || 0) + 1;
    p.swing = { item: def, timer: 0.45, dur: 0.45, swung: true, loop: false, bow: false,
                id: p.swingSeq };
  }

  // Keep p.maxHp in sync with gear bonuses (vital amulet), clamping overflow.
  function syncMaxHp(p, C, bonus) {
    const want = (C.PLAYER_HP || p.maxHp) + bonus;
    if (want !== p.maxHp) {
      p.maxHp = want;
      if (p.hp > want) p.hp = want;
    }
  }

  // ====================================================================
  // Item icons for the defs added above (items.js owns all others)
  // ====================================================================

  function shadeHex(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    const b = Math.max(0, Math.min(255, (n & 255) + amt));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }
  function pxr(g, c, x, y, w, h) { g.fillStyle = c; g.fillRect(x, y, w, h); }

  function paintRing(g, metal, gem) {
    g.strokeStyle = metal;
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(8, 9.5, 4, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = shadeHex(metal, 45);
    g.lineWidth = 1;
    g.beginPath();
    g.arc(8, 9.5, 5.2, Math.PI * 1.1, Math.PI * 1.9);
    g.stroke();
    pxr(g, gem, 6, 2, 4, 4);
    pxr(g, shadeHex(gem, 50), 6, 2, 2, 1);
  }
  function paintBand(g, metal, gem) {
    g.strokeStyle = metal;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(8, 9, 4.5, 0, Math.PI * 2);
    g.stroke();
    pxr(g, shadeHex(metal, -40), 4, 13, 8, 1);
    pxr(g, gem, 7, 7, 3, 3);
    pxr(g, shadeHex(gem, 60), 7, 7, 1, 1);
  }
  function paintCharm(g, c) {
    g.strokeStyle = '#caa84a';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(3, 2); g.lineTo(8, 6); g.lineTo(13, 2);
    g.stroke();
    g.fillStyle = c;
    g.beginPath();
    g.arc(8, 10, 4, 0, Math.PI * 2);
    g.fill();
    pxr(g, shadeHex(c, 55), 6, 8, 2, 2);
    pxr(g, shadeHex(c, -45), 9, 12, 2, 1);
    pxr(g, '#eaf6ff', 3, 8, 2, 1);
    pxr(g, '#eaf6ff', 2, 11, 1, 1);
  }
  function paintGlove(g, c) {
    pxr(g, c, 4, 5, 8, 7);
    pxr(g, shadeHex(c, 40), 4, 5, 8, 1);
    pxr(g, shadeHex(c, -35), 4, 10, 8, 2);
    pxr(g, shadeHex(c, -35), 3, 6, 1, 4);
    pxr(g, '#5a4632', 4, 12, 8, 2);
    pxr(g, '#7a6248', 4, 12, 8, 1);
  }
  function paintLens(g, c) {
    g.fillStyle = '#3a3a44';
    g.beginPath();
    g.arc(8, 8, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = c;
    g.beginPath();
    g.arc(8, 8, 4.5, 0, Math.PI * 2);
    g.fill();
    pxr(g, '#ffffff', 5, 5, 2, 2);
    pxr(g, shadeHex(c, -40), 10, 10, 2, 2);
  }
  function paintAmulet(g, c) {
    g.strokeStyle = '#caa84a';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(3, 2); g.lineTo(8, 7); g.lineTo(13, 2);
    g.stroke();
    g.fillStyle = c;
    g.beginPath();
    g.moveTo(8, 6); g.lineTo(12, 10); g.lineTo(8, 14); g.lineTo(4, 10);
    g.closePath();
    g.fill();
    pxr(g, shadeHex(c, 60), 7, 8, 2, 2);
  }
  function paintPotion(g, c) {
    pxr(g, '#8a6a3a', 6, 1, 4, 2);
    pxr(g, '#bcd9e8', 6, 3, 4, 4);
    pxr(g, 'rgba(188,217,232,0.45)', 4, 6, 8, 8);
    g.fillStyle = c;
    g.beginPath();
    g.arc(8, 11, 3.6, 0, Math.PI * 2);
    g.fill();
    pxr(g, c, 5, 8, 6, 4);
    pxr(g, shadeHex(c, 55), 6, 9, 1, 3);
    pxr(g, '#ffffff', 5, 6, 1, 2);
  }

  const MY_ICON_IDS = {
    guard_ring:       (g) => paintRing(g, '#c0c0cc', '#5a8ec8'),
    regen_band:       (g) => paintBand(g, '#ffd24a', '#6ee06e'),
    swift_charm:      (g) => paintCharm(g, '#5ad0e8'),
    power_glove:      (g) => paintGlove(g, '#b05a3a'),
    aimer_lens:       (g) => paintLens(g, '#9adcf0'),
    vital_amulet:     (g) => paintAmulet(g, '#e23b3b'),
    ironskin_potion:  (g) => paintPotion(g, '#aeb8c8'),
    regen_potion:     (g) => paintPotion(g, '#6ee06e'),
    swiftness_potion: (g) => paintPotion(g, '#5ad0e8'),
    wrath_potion:     (g) => paintPotion(g, '#e85a48')
  };

  const iconCache = new Map();
  function myIcon(id) {
    if (!MY_ICON_IDS[id]) return null;
    if (iconCache.has(id)) return iconCache.get(id);
    let cv = null;
    try {
      cv = document.createElement('canvas');
      cv.width = 16;
      cv.height = 16;
      MY_ICON_IDS[id](cv.getContext('2d'));
    } catch (e) { cv = null; }
    if (cv) iconCache.set(id, cv);
    return cv;
  }

  // ====================================================================
  // Runtime wraps — installed as each target module becomes available
  // ====================================================================

  function mark(fn) { try { fn.__accWrap = true; } catch (e) {} return fn; }

  function wrapFn(owner, name, make) {
    if (!owner || typeof owner[name] !== 'function') return false;
    const cur = owner[name];
    if (cur.__accWrap) return true;           // already ours
    owner[name] = mark(make(cur));
    return true;
  }

  function hookPlayer(P) {
    let ok = true;

    // Defense from accessories/buffs joins the armor sum; ui.js HUD and
    // Combat.hurtPlayer both read totalDefense(), so this propagates.
    if (!wrapFn(P.prototype, 'totalDefense', (orig) => function () {
      const base = orig.apply(this, arguments);
      return base + Math.round(combinedMods(this).defense);
    })) ok = false;

    // Buff upkeep + physics-tuning window: movement/regen constants are
    // adjusted around the synchronous original call, then restored.
    if (!wrapFn(P.prototype, 'update', (orig) => function (dt) {
      const p = this;
      if (typeof p._potionCd === 'number' && p._potionCd > 0) p._potionCd -= dt;
      Buffs.tick(dt, p);
      if (p.dead) return orig.call(p, dt);
      const m = combinedMods(p);
      const C = TC.CONST;
      let sv = null;
      if (C) {
        sv = [C.RUN_MAX, C.RUN_ACCEL, C.REGEN_RATE];
        C.RUN_MAX *= m.moveSpeed;
        C.RUN_ACCEL *= m.moveSpeed;
        C.REGEN_RATE += m.regen;
        syncMaxHp(p, C, m.maxHp);
      }
      try { return orig.call(p, dt); }
      finally {
        if (sv) { C.RUN_MAX = sv[0]; C.RUN_ACCEL = sv[1]; C.REGEN_RATE = sv[2]; }
      }
    })) ok = false;

    // Potions short-circuit the normal use switch.
    if (!wrapFn(P.prototype, 'useHeld', (orig) => function (dt) {
      const p = this;
      const sel = (typeof p.selectedSlot === 'function') ? p.selectedSlot() : null;
      const def = (sel && TC.ITEM_DEFS) ? TC.ITEM_DEFS[sel.id] : null;
      if (def && def.kind === 'potion') { drinkPotion(p, def, sel.id); return; }
      return orig.call(p, dt);
    })) ok = false;

    // Persistence rides the existing save blob (save.js stores it verbatim).
    if (!wrapFn(P.prototype, 'serialize', (orig) => function () {
      const data = orig.apply(this, arguments);
      if (data && typeof data === 'object') {
        data.accessories = Acc.serialize(this);
        data.buffs = Buffs.serialize();
      }
      return data;
    })) ok = false;

    if (!wrapFn(P, 'deserialize', (orig) => function (data) {
      const p = orig.call(this, data);
      if (p) {
        Acc.deserialize(p, data && data.accessories);
        if (data && data.buffs) Buffs.deserialize(data.buffs);
        else Buffs.clear();
      }
      return p;
    })) ok = false;

    return ok;
  }

  function hookCombat(Cb) {
    let ok = true;

    // Melee: scale the strike's base damage; crit bonus rides the roll window.
    if (!wrapFn(Cb, 'meleeStrike', (orig) => function () {
      const p = TC.player;
      const m = p ? combinedMods(p) : null;
      if (m && (m.meleeDmg !== 1 || m.critChance !== 0)) {
        const args = Array.prototype.slice.call(arguments);
        args[5] = Math.round((args[5] || 0) * m.meleeDmg);
        const C = TC.CONST;
        let sv = null;
        if (C) { sv = C.CRIT_CHANCE; C.CRIT_CHANCE = sv + m.critChance; }
        try { return orig.apply(this, args); }
        finally { if (sv !== null && C) C.CRIT_CHANCE = sv; }
      }
      return orig.apply(this, arguments);
    })) ok = false;

    // Bow: scale arrow damage (impact-time crit roll is Combat's own).
    if (!wrapFn(Cb, 'shootArrow', (orig) => function () {
      const p = TC.player;
      const m = p ? combinedMods(p) : null;
      if (m && m.rangedDmg !== 1) {
        const args = Array.prototype.slice.call(arguments);
        args[4] = Math.round((args[4] || 0) * m.rangedDmg);
        return orig.apply(this, args);
      }
      return orig.apply(this, arguments);
    })) ok = false;

    // Environmental hook: lava burns apply the Burning debuff. Defense
    // reduction already flows through the wrapped totalDefense().
    if (!wrapFn(Cb, 'hurtPlayer', (orig) => function (dmg, kbx, kby, src) {
      if (src === 'lava') Buffs.apply('burning', 4);
      return orig.call(this, dmg, kbx, kby, src);
    })) ok = false;

    return ok;
  }

  function hookUI(UI) {
    return wrapFn(UI, 'draw', (orig) => function () {
      const r = orig.apply(this, arguments);
      try { Buffs.drawIcons(arguments[0], arguments[1], arguments[2]); } catch (e) {}
      return r;
    });
  }

  function hookItems(Items) {
    if (!Items || typeof Items.iconFor !== 'function') return false;
    if (Items.iconFor.__accWrap) return true;
    const orig = Items.iconFor;
    Items.iconFor = mark(function (id) {
      const cv = myIcon(String(id));
      return cv || orig.apply(this, arguments);
    });
    return true;
  }

  function hookGlobals() {
    let ok = true;
    if (!wrapFn(TC, 'newGame', (orig) => function () {
      const r = orig.apply(this, arguments);
      Buffs.clear();
      return r;
    })) ok = false;
    if (!wrapFn(TC, 'continueGame', (orig) => function () {
      Buffs.clear();               // stale session buffs; deserialize re-adds saved ones
      return orig.apply(this, arguments);
    })) ok = false;
    if (!wrapFn(TC, 'quitToTitle', (orig) => function () {
      const r = orig.apply(this, arguments);
      Buffs.clear();
      return r;
    })) ok = false;
    return ok;
  }

  // Retry loop: each job returns true once installed (or is hopeless), so the
  // module works no matter where its <script> tag sits relative to siblings.
  const jobs = [
    () => installDefs(),
    () => (TC.Player ? hookPlayer(TC.Player) : false),
    () => (TC.Combat ? hookCombat(TC.Combat) : false),
    () => (TC.UI ? hookUI(TC.UI) : false),
    () => (TC.Items ? hookItems(TC.Items) : false),
    () => hookGlobals()
  ];
  let tries = 0;
  function pump() {
    for (let i = jobs.length - 1; i >= 0; i--) {
      let done = false;
      try { done = !!jobs[i](); } catch (e) { done = true; }
      if (done) jobs.splice(i, 1);
    }
    if (jobs.length && ++tries < 600 && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(pump);
    }
  }
  pump();
})();

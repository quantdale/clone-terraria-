/* accessories.js — TC.Accessories (5 accessory equip slots, stat modifiers,
   reforge-style prefix stub) + TC.Buffs (timed buffs/debuffs: ironskin,
   regeneration, swiftness, wrath, poisoned, burning, slowed) with stat mods,
   ambient particle icons, a HUD buff-icon row, and potion consumables.

   Fully de-monkey-patched (ARCHITECTURE.md §10/§11): every former runtime
   wrap is now a plain exported function, an event reaction, or a SaveCore
   provider. Stat arithmetic lives in TC.Stats (js/stats.js), which registers
   'gear.accessories' -> TC.Accessories.modsOf(player) and 'status.buffs' ->
   TC.Buffs.modsOf(); both modsOf() implementations here are pure reads.

   Removed wraps -> supported contracts:
     Player.totalDefense / update / useHeld / serialize / deserialize wraps
       -> TC.Stats sources (lead rewires player.js/combat.js against
          TC.Stats.resolve()), TC.Accessories.update/onUseHeld below, and the
          'character.core.accessories' SaveCore provider
     Combat.meleeStrike/shootArrow/hurtPlayer wraps
       -> TC.Stats.resolve() damage/crit/defense + lead-applied
          TC.Buffs.apply('burning', 4) on lava hits
     UI.draw / Items.iconFor wraps
       -> TC.Accessories.drawHud(ctx) / TC.Accessories.iconFor(id)
     newGame/continueGame/quitToTitle wraps
       -> session tracking in update(): a player instance that was never
          handed saved state (attachToPlayer/restoreLegacy) starts with no
          active buffs; restored players keep exactly what was loaded

   Exports:
     TC.Accessories  SLOT_COUNT(5), PREFIX_DEFS, slotsOf/equip/unequip,
                     modsOf, prefixMods, rollPrefix (stub), serialize/
                     deserialize (per-player shapes), update(dt), 
                     onUseHeld(player, def, dt) -> bool, drawHud(ctx),
                     iconFor(id) -> canvas|null, attachToPlayer(player, data),
                     captureOf(player), restoreLegacy(playerData)
     TC.Buffs        DEFS, list, apply/remove/has/clear, modsOf, tick,
                     drawIcons(ctx, w, h), serialize/deserialize,
                     attachToPlayer(player, data), captureOf()

   Events emitted (guarded; canonical names from TC.Events.EVENT):
     BuffApplied {id, time}   on apply/refresh
     BuffExpired {id}         on natural timeout or manual remove

   INTEGRATION (one line each, lead-owned files):
     main.js step(), after the player update line:
       if (TC.Accessories) TC.Accessories.update(dt);
     main.js draw() (screen space, after UI.draw):
       if (TC.Accessories) TC.Accessories.drawHud(ctx);
     player.js totalDefense(): `return TC.Stats.resolve(this).defense;`
     player.js update(): moveSpeed multiplier on RUN_MAX/RUN_ACCEL, regen from
       healthRegen, maxHp synced to maxHealth — all via TC.Stats.resolve(this)
     player.js useHeld(), before the kind switch (next to the other use hooks):
       if (TC.Accessories && def && TC.Accessories.onUseHeld(this, def, dt)) return;
     combat.js meleeStrike/shootArrow callers scale dmg by
       st.meleeDamage/st.rangedDamage and roll crit vs st.critChance;
       hurtPlayer subtracts st.defense and, when src === 'lava',
       calls TC.Buffs.apply('burning', 4)
     items.js iconFor(), before its own painters:
       const aic = TC.Accessories && TC.Accessories.iconFor(key);
       if (aic) return aic;   // sibling gear/loot icon hooks sit alongside
     main.js continueGame(), after `TC.player = TC.Player.deserialize(...)`:
       if (TC.Accessories) TC.Accessories.restoreLegacy(data.player);
     SaveCore envelope restore (after player creation) dispatches the
       'character.core.accessories' provider registered below.

   Item defs and recipes are appended to TC.ITEM_DEFS / TC.RECIPES from here,
   and registered under 'acc:<id>' stable ids in TC.Registry (guarded), so
   constants.js stays untouched.

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

  // Generic status-effect definition schema (W13.1). Every timed status on
  // the player is a BUFF_DEFS row — there is no second effect runtime:
  //   id          stable string key (save identity — never rename without
  //               an alias; serialized as [[id, secondsLeft], ...])
  //   name        display name (HUD glyph derives from it)
  //   good        true = buff, false = debuff (icon framing only)
  //   dur         default duration seconds when applier omits one
  //   stack       'refresh' (default) keeps the LONGER of remaining/new;
  //               'max' behaves identically today but names the policy
  //   mods        stat modifiers folded in by TC.Stats ('status.buffs')
  //   dps         damage-over-time hp/s (bypasses iframes deliberately)
  //   healPerSec  regeneration-over-time hp/s (applied in tickBuffs)
  //   fromSource  intake source tag that inflicts this status via
  //               TC.Combat.hurtPlayer (combat consults statusForSource,
  //               it never hardcodes effect ids)
  //   fromSourceDur  duration override when inflicted via fromSource
  //   color       HUD/border tint; parts[] ambient particle palette; rate
  //               particles/sec
  const BUFF_DEFS = {
    ironskin:     { name: 'Ironskin',     good: true,  dur: 50, color: '#b8c0cc',
                    stack: 'refresh',
                    mods: { defense: 8 }, parts: ['#c8d0dc', '#98a2b2'], rate: 6 },
    regeneration: { name: 'Regeneration', good: true,  dur: 40, color: '#6ee06e',
                    stack: 'refresh', healPerSec: 2,
                    mods: { regen: 2 }, parts: ['#8ef08e', '#4ec44e'], rate: 7 },
    swiftness:    { name: 'Swiftness',    good: true,  dur: 60, color: '#5ad0e8',
                    stack: 'refresh',
                    mods: { moveSpeed: 1.25 }, parts: ['#8ae4f4', '#38aecb'], rate: 9 },
    wrath:        { name: 'Wrath',        good: true,  dur: 30, color: '#e85a48',
                    stack: 'refresh',
                    mods: { meleeDmg: 1.2, rangedDmg: 1.2 },
                    parts: ['#ff8a6a', '#c83a2a'], rate: 7 },
    poisoned:     { name: 'Poisoned',     good: false, dps: 2, color: '#7ac74f',
                    stack: 'refresh',
                    parts: ['#9ade6e', '#589c32'], rate: 5 },
    burning:      { name: 'Burning',      good: false, dps: 6, color: '#ff7a30',
                    stack: 'refresh',
                    fromSource: 'lava', fromSourceDur: 4,
                    parts: ['#ffb03a', '#e85a1a'], rate: 14 },
    slowed:       { name: 'Slowed',       good: false, color: '#9a8ad0',
                    stack: 'refresh',
                    mods: { moveSpeed: 0.55 }, parts: ['#b8a8e8', '#786aa8'], rate: 4 }
  };

  // Intake-source -> status policy table derived from the defs above.
  // TC.Combat.hurtPlayer asks statusForSource(src) instead of naming effects.
  const SOURCE_STATUS = {};
  (function () {
    for (const id in BUFF_DEFS) {
      const d = BUFF_DEFS[id];
      if (typeof d.fromSource === 'string' && d.fromSource) {
        SOURCE_STATUS[d.fromSource] = {
          id: id,
          dur: (typeof d.fromSourceDur === 'number' && d.fromSourceDur > 0)
            ? d.fromSourceDur : d.dur,
        };
      }
    }
  })();

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

  // ---- guarded event emission ----

  function emitBus(key, fallback, payload) {
    if (!TC.Events || typeof TC.Events.emit !== 'function') return;
    const name = (TC.Events.EVENT && TC.Events.EVENT[key]) || fallback;
    try { TC.Events.emit(name, payload); } catch (e) {}
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

  // Equipped entries live on the player instance (lazy-attached):
  // player.accessories = [null | {id, prefix}, x5]
  function slotsOf(player) {
    if (!player) return null;
    if (!Array.isArray(player.accessories)) {
      player.accessories = new Array(SLOT_COUNT).fill(null);
    }
    return player.accessories;
  }

  // Swap the inventory stack at invIndex with accessory slot slotIndex.
  // Only kind:'accessory' items may be worn. Returns bool.
  function equip(player, invIndex, slotIndex) {
    const inv = player && player.inventory;
    if (!inv || typeof inv.get !== 'function') return false;
    const slots = slotsOf(player);
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
  }

  // Move a worn accessory back to the bag (first free slot unless invIndex given).
  function unequip(player, slotIndex, invIndex) {
    const inv = player && player.inventory;
    const slots = slotsOf(player);
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
  }

  // Aggregate stat modifiers from everything worn. Pure read — TC.Stats'
  // 'gear.accessories' source folds this straight into its accumulator.
  function modsOf(player) {
    const m = zeroMods();
    const slots = (player && Array.isArray(player.accessories)) ? player.accessories : null;
    if (!slots) return m;
    for (let i = 0; i < slots.length && i < SLOT_COUNT; i++) {
      const e = slots[i];
      if (!e) continue;
      const d = itemDef(e.id);
      if (!d || d.kind !== 'accessory') continue;
      addMods(m, d.mods);
      if (e.prefix) addMods(m, prefixMods(e.prefix));
    }
    return m;
  }

  function prefixMods(prefixId) {
    const p = PREFIX_DEFS[prefixId];
    return p ? p.mods : null;
  }

  // Deterministic pseudo-reforge pick: same (itemId, seed) -> same prefix.
  // Stub: nothing calls this yet; a reforge feature would store the result
  // on the equipped entry's .prefix field (already serialized above).
  function rollPrefix(itemId, seed) {
    const h = strHash(String(itemId) + '|' + String(seed));
    const r = hash2(h, 0x51ed, 0xacce);
    if (r < 0.34) return 'none';
    const pool = (r < 0.78) ? POS_PREFIXES : NEG_PREFIXES;
    return pool[(hash2(h, 0x9e37, 0x7f4a) * pool.length) | 0];
  }

  // Per-player shapes (unchanged): [{id, prefix|null}|null, x5]
  function serializeAcc(player) {
    const slots = slotsOf(player);
    if (!slots) return null;
    const out = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const e = slots[i];
      out[i] = e ? { id: e.id, prefix: e.prefix || null } : null;
    }
    return out;
  }

  function deserializeAcc(player, data) {
    const slots = slotsOf(player);
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

  // ====================================================================
  // TC.Buffs — timed buffs/debuffs on the current player
  // ====================================================================

  const MAX_ACTIVE = 12;
  const list = [];   // active entries: {id, time, dur, pool}

  function findBuff(id) {
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // Apply/refresh a buff on the player (defaults to TC.player). Re-applying
  // extends to the longer of the remaining/new duration (Terraria-style).
  function applyBuff(id, dur, player) {
    const d = BUFF_DEFS[id];
    if (!d) return false;
    const p = player || TC.player;
    if (!p || p.dead) return false;
    const t = (dur != null && dur > 0) ? dur : (d.dur || 30);
    const cur = findBuff(id);
    if (cur) {
      cur.time = Math.max(cur.time, t);
      emitBus('BuffApplied', 'BuffApplied', { id: id, time: cur.time });
      return true;
    }
    if (list.length >= MAX_ACTIVE) list.shift();
    list.push({ id: id, time: t, dur: t, pool: 0 });
    floatText(p.x + p.w / 2, p.y - 12, buffName(id), d.color);
    emitBus('BuffApplied', 'BuffApplied', { id: id, time: t });
    return true;
  }

  // Localized buff/status display name (W20): the id stays a machine value;
  // presentation resolves through the catalog with def.name as fallback.
  function buffName(id) {
    if (TC.Localization && typeof TC.Localization.contentName === 'function') {
      try { return TC.Localization.contentName('buff', id); } catch (e) {}
    }
    const d = BUFF_DEFS[id];
    return (d && d.name) || String(id);
  }

  function removeBuff(id) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].id === id) {
        list.splice(i, 1);
        emitBus('BuffExpired', 'BuffExpired', { id: id });
        return true;
      }
    }
    return false;
  }

  function hasBuff(id) { return !!findBuff(id); }

  function modsOfBuffs() {
    const m = zeroMods();
    for (let i = 0; i < list.length; i++) {
      const d = BUFF_DEFS[list[i].id];
      if (d) addMods(m, d.mods);
    }
    return m;
  }

  // Per-step upkeep: timers, damage-over-time, ambient particle icons.
  // Driven by TC.Accessories.update(); safe to call manually too.
  function tickBuffs(dt, player) {
    if (!player) return;
    if (player.dead) { if (list.length) list.length = 0; return; }
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.time -= dt;
      if (b.time <= 0) {
        list.splice(i, 1);
        emitBus('BuffExpired', 'BuffExpired', { id: b.id });
        continue;
      }
      const d = BUFF_DEFS[b.id];
      if (!d) continue;
      if (d.dps > 0) dotDamage(b, player, d, dt);
      if (d.healPerSec > 0) hotDamage(b, player, d, dt);
    }
    emitParticles(dt, player);
  }

  // Screen-space HUD row under the hearts/breath bubbles, right-aligned.
  function drawBuffIcons(ctx, w, h) {
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
      // two-letter glyph from the LOCALIZED name (W20): stays stable per
      // locale and never derives from the machine id.
      const words = buffName(b.id).split(' ');
      const glyph = (words.length > 1 ? words[0].charAt(0) + words[1].charAt(0)
        : words[0].slice(0, 2)).toUpperCase();
      ctx.fillStyle = d.color;
      ctx.fillText(glyph, x + S / 2, Y + S / 2 - 2);
      const frac = clamp01(b.dur > 0 ? b.time / b.dur : 0);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x + 2, Y + S - 4, (S - 4) * frac, 2);
      x -= S + GAP;
    }
    ctx.restore();
  }

  // [[id, secondsRemaining], ...]
  function serializeBuffs() {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push([list[i].id, Math.round(list[i].time * 10) / 10]);
    }
    return out;
  }

  function deserializeBuffs(data) {
    list.length = 0;                          // replace-wholesale: stale session state dies here
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

  // Heal-over-time twin of dotDamage (fractional pool, integer ticks). The
  // regeneration buff currently heals through its Stats regen mod instead;
  // this makes periodic healing a first-class status property for new defs.
  function hotDamage(b, p, d, dt) {
    if (!(d.healPerSec > 0)) return;
    b.pool += d.healPerSec * dt;
    if (b.pool < 1) return;
    const n = Math.floor(b.pool);
    b.pool -= n;
    if (p.dead || typeof p.hp !== 'number') return;
    const maxHp = (typeof p.maxHp === 'number') ? p.maxHp : Infinity;
    const before = p.hp;
    p.hp = Math.min(maxHp, p.hp + n);
    const gained = p.hp - before;
    if (gained > 0) {
      floatText(p.x + p.w / 2, p.y - 4, '+' + gained,
                (TC.CONST && TC.CONST.COLORS && TC.CONST.COLORS.heal) || '#7dff7d');
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
  // Per-frame upkeep — lead calls TC.Accessories.update(dt) from step()
  // (absorbs the old Player.update wrap's work beyond stat windows, which
  // moved into TC.Stats consumers)
  // ====================================================================

  // Buffs are module-global but belong to "the current player". A player
  // instance that was just created (newGame, failed-load fallback) starts
  // clean; one that received saved state via attachToPlayer/restoreLegacy
  // keeps exactly what was loaded. Respawn reuses the same instance, so
  // mid-session deaths are untouched.
  let curPlayer;                                // undefined until first update()
  const restored = new WeakSet();

  function markRestored(p) {
    if (p && typeof p === 'object') { try { restored.add(p); } catch (e) {} }
  }

  function update(dt) {
    const p = TC.player || null;
    if (p !== curPlayer) {
      curPlayer = p;
      if (!p || !restored.has(p)) list.length = 0;   // fresh session: drop stale buffs
    }
    if (!p) return;
    if (typeof p._potionCd === 'number' && p._potionCd > 0) p._potionCd -= dt;
    tickBuffs(dt, p);
  }

  // ====================================================================
  // Potion consumables (kind:'potion') — lead calls onUseHeld from
  // Player.useHeld before its kind switch (absorbs the old useHeld wrap)
  // ====================================================================

  // Returns true when the potion was actually drunk.
  function drinkPotion(p, def, itemId) {
    if ((p._potionCd || 0) > 0) return false;
    if (!consumeSelected(p, itemId, 1)) return false;
    p._potionCd = 0.8;
    applyBuff(def.buff, def.time, p);
    sfx('pickup');
    burst(p.x + p.w / 2, p.y + p.h / 2, 8, [def.color || '#ffffff', '#ffffff'], 80);
    p.swingSeq = (p.swingSeq || 0) + 1;
    p.swing = { item: def, timer: 0.45, dur: 0.45, swung: true, loop: false, bow: false,
                id: p.swingSeq };
    return true;
  }

  // Handle the held item if it is a potion; report so the caller can skip
  // its own kind switch. dt unused: sips are click-paced.
  function onUseHeld(player, def, dt) {
    if (!player || !def || def.kind !== 'potion') return false;
    const sel = (typeof player.selectedSlot === 'function') ? player.selectedSlot() : null;
    const itemId = (sel && TC.ITEM_DEFS && TC.ITEM_DEFS[sel.id] === def) ? sel.id : null;
    if (!itemId) return false;
    return drinkPotion(player, def, itemId);
  }

  // ====================================================================
  // HUD — lead calls TC.Accessories.drawHud(ctx) screen-space after UI.draw
  // (absorbs the old UI.draw wrap part)
  // ====================================================================

  function drawHud(ctx) {
    if (!ctx || !list.length) return;
    const cv = ctx.canvas;
    drawBuffIcons(ctx, cv ? cv.width : 0, cv ? cv.height : 0);
  }

  // ====================================================================
  // Item icons for the defs added above (items.js owns all others; the lead
  // consults TC.Accessories.iconFor alongside its other icon hooks)
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

  function iconFor(id) {
    return (id != null) ? myIcon(String(id)) : null;
  }

  // ====================================================================
  // Persistence — SaveCore provider + explicit attach/capture pair
  // (absorbs the old Player.serialize / static deserialize wraps; data
  // shapes are byte-compatible with the old player-blob sub-keys
  // `accessories` / `buffs`)
  // ====================================================================

  function attachAcc(player, data) {
    const ok = deserializeAcc(player, data);
    markRestored(player);
    return ok;
  }
  function captureAcc(player) {
    return serializeAcc(player);
  }
  function attachBuffs(player, data) {
    const ok = deserializeBuffs(data);
    markRestored(player);
    return ok;
  }
  function captureBuffs() {
    return serializeBuffs();
  }

  // Apply accessories + buffs from an old v1 player blob onto the live
  // TC.player (mirrors the removed Player.deserialize wrap, including the
  // clear-when-buffs-absent branch). Lead calls it in continueGame() right
  // after player creation.
  function restoreLegacy(playerData, player) {
    // During Player.deserialize the rebuilt player is NOT yet on TC.player,
    // so callers pass it explicitly (v1 blobs would otherwise silently drop
    // accessories + buffs).
    const p = player || TC.player || null;
    if (!p || !playerData || typeof playerData !== 'object') return false;
    attachAcc(p, playerData.accessories);
    if (playerData.buffs) attachBuffs(p, playerData.buffs);
    else list.length = 0;
    markRestored(p);
    return true;
  }

  if (TC.SaveCore && typeof TC.SaveCore.register === 'function') {
    try {
      TC.SaveCore.register('character.core.accessories', {
        version: 1,
        serialize(ctx) {
          const p = ctx ? ctx.player : null;
          return { accessories: captureAcc(p), buffs: captureBuffs() };
        },
        deserialize(data, ctx) {
          const p = ctx ? ctx.player : null;
          const d = (data && typeof data === 'object') ? data : {};
          attachAcc(p, d.accessories);
          if (d.buffs) attachBuffs(p, d.buffs);
          else list.length = 0;               // mirrors the old else-clear branch
        }
      });
    } catch (e) {
      console.warn('[TC.Accessories] SaveCore provider refused:', e && e.message);
    }
  }

  // ====================================================================
  // Boot: shared-table extension + stable registry ids (guarded, once —
  // script order in index.html puts this file after constants/registry/
  // savecore/events, so no retry pump is needed)
  // ====================================================================

  installDefs();

  const ACC_ITEM_IDS = Object.keys(ACCESSORY_DEFS).concat(Object.keys(POTION_DEFS));
  if (TC.Registry && typeof TC.Registry.define === 'function') {
    for (let i = 0; i < ACC_ITEM_IDS.length; i++) {
      const d = TC.ITEM_DEFS ? TC.ITEM_DEFS[ACC_ITEM_IDS[i]] : null;
      if (!d) continue;
      try { TC.Registry.define('item', 'acc:' + ACC_ITEM_IDS[i], d); }
      catch (e) { /* duplicate or rejected: content still ships via tables */ }
    }
  }

  // ====================================================================
  // Public API
  // ====================================================================

  TC.Accessories = {
    SLOT_COUNT: SLOT_COUNT,
    PREFIX_DEFS: PREFIX_DEFS,

    slotsOf: slotsOf,
    equip: equip,
    unequip: unequip,

    // Pure stat-mod aggregation (folded in by TC.Stats 'gear.accessories')
    modsOf: modsOf,
    prefixMods: prefixMods,
    rollPrefix: rollPrefix,

    // Per-player persistence shapes (legacy player-blob sub-key compatible)
    serialize: serializeAcc,
    deserialize: deserializeAcc,

    // Loop-facing hooks
    update: update,
    onUseHeld: onUseHeld,
    drawHud: drawHud,
    iconFor: iconFor,

    // SaveCore-era persistence pair + legacy v1 blob adapter
    attachToPlayer: attachAcc,
    captureOf: captureAcc,
    restoreLegacy: restoreLegacy
  };

  TC.Buffs = {
    DEFS: BUFF_DEFS,
    list: list,

    apply: applyBuff,
    remove: removeBuff,
    has: hasBuff,
    clear() { list.length = 0; },

    // Intake-source policy lookup for TC.Combat.hurtPlayer (W12): returns
    // {id, dur} when the source inflicts a status, else null.
    statusForSource(src) { return SOURCE_STATUS[src] || null; },

    // Pure stat-mod aggregation (folded in by TC.Stats 'status.buffs')
    modsOf: modsOfBuffs,

    tick: tickBuffs,
    drawIcons: drawBuffIcons,

    serialize: serializeBuffs,
    deserialize: deserializeBuffs,
    attachToPlayer: attachBuffs,
    captureOf: captureBuffs
  };
})();

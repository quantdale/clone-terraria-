/* stats.js — TC.Stats: unified player stat resolver (ARCHITECTURE.md §10).

   One place computes "what are this player's effective stats": base values
   from the player instance + CONST, then named modifier sources applied in
   priority order. Replaces the accessory/buff CONST-mutation windows and the
   totalDefense wrap with explicit arithmetic at the point of use.

   Sources: registerSource(name, priority, fn(player, out)). fn folds its
   modifiers straight into the accumulator `out`: additive fields start at 0
   (use +=), multiplicative fields start at 1 (use *=, values must be > 0).
   Built-ins registered here:
     100 core.armor             equipped armor defense (mirror of the original
                                Player.totalDefense body — reads equipment
                                directly, never calls the wrapped method)
     200 gear.accessories       folds TC.Accessories.modsOf(player) (prefixes
                                included; loot.js's __lootWrap crystal bonus
                                rides along while that wrap exists)
     300 status.buffs           folds TC.Buffs.modsOf()
     400 progress.lifeCrystals  +20 max health per life crystal, 15 max
                                (skipped when loot.js's modsOf wrap already
                                folds the same bonus in — never double-counts)

   Snapshot semantics (what resolve() returns, per field):
     additive      maxHealth (base CONST.PLAYER_HP), healthRegen (base
                   CONST.REGEN_RATE), maxMana (base player.maxMana), manaRegen
                   (base 3 + maxMana * 0.05, mirrors Magic regenRate),
                   critChance (base CONST.CRIT_CHANCE — final chance, callers
                   may still add a per-weapon bonus), defense (Math.round of
                   all source deltas; armor arrives via the core.armor source,
                   which reproduces the legacy armor + Math.round(deltas)
                   exactly since armor values are integral), armorPenetration,
                   fishingPower (flat points)
     multiplicative moveSpeed (apply to BOTH CONST.RUN_MAX and RUN_ACCEL),
                   jumpPower (CONST.JUMP_VEL), knockback (weapon kb),
                   meleeDamage / rangedDamage / magicDamage / summonDamage
                   (Math.round(weaponDamage * mult) at strike time),
                   miningSpeed (tool def.power)

   Exact-behavior mirrors (verified against current source):
     - accessories.js addMods: non-positive multipliers are ignored (treated
       as 1); defense/regen/critChance/maxHp are flat adds.
     - accessories.js totalDefense wrap: armor + Math.round(combined deltas),
       one rounding of the summed delta.
     - accessories.js update wrap: RUN_MAX/RUN_ACCEL * moveSpeed-mult,
       REGEN_RATE + regen, PLAYER_HP + maxHp-deltas (syncMaxHp).
     - accessories.js meleeStrike/shootArrow wraps: Math.round(dmg * mult),
       CRIT_CHANCE + critChance at roll time.
     - magic.js regenRate: 3 + maxMana * 0.05.
     - loot.js crystalBonus: min(lifeCrystals, 15) * 20.

   Integration: pure service — no update/draw (nothing to register with
   TC.Systems) and no persistent state (no TC.SaveCore provider). The lead
   consumes resolve() wherever the old wraps used to mutate state; see the
   migration notes at the bottom of this file. A tiny signature-checked cache
   keeps repeat resolve() calls allocation-free and can never serve stale
   numbers: any gear/buff/crystal/mana change changes the signature.
   Stat-affecting TC.Events additionally call invalidate(). */

'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Stats) return;                        // load-once guard

  // ====================================================================
  // Field model
  // ====================================================================

  const ADD_FIELDS = ['defense', 'healthRegen', 'maxHealth', 'maxMana', 'manaRegen',
                      'critChance', 'armorPenetration', 'fishingPower'];
  const MUL_FIELDS = ['moveSpeed', 'jumpPower', 'knockback', 'meleeDamage',
                      'rangedDamage', 'magicDamage', 'summonDamage', 'miningSpeed'];

  function newAccum() {
    const out = {};
    let i;
    for (i = 0; i < ADD_FIELDS.length; i++) out[ADD_FIELDS[i]] = 0;
    for (i = 0; i < MUL_FIELDS.length; i++) out[MUL_FIELDS[i]] = 1;
    return out;
  }

  // Legacy mods-object shape (Accessories/Buffs addMods) -> accumulator keys.
  const MODS_KEYS = {
    defense: 'defense',
    regen: 'healthRegen',
    moveSpeed: 'moveSpeed',
    meleeDmg: 'meleeDamage',
    rangedDmg: 'rangedDamage',
    critChance: 'critChance',
    maxHp: 'maxHealth'
  };
  const MUL_SET = new Set(MUL_FIELDS);

  // Exact port of accessories.js addMods semantics, retargeted at `out`.
  function foldMods(out, mods) {
    if (!mods) return out;
    for (const k in MODS_KEYS) {
      if (!(k in mods)) continue;
      const v = mods[k];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      const field = MODS_KEYS[k];
      if (MUL_SET.has(field)) out[field] *= (v > 0) ? v : 1;
      else out[field] += v;
    }
    return out;
  }

  function sanitizeMul(v) {
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 1;
  }
  function numOr(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }
  function itemDef(id) { return (TC.ITEM_DEFS && id) ? TC.ITEM_DEFS[id] : null; }

  // Snapshot cache: player -> {sig, snap}. Signature-checked, so it can
  // never serve stale numbers even between event notifications. Declared
  // before the registry because registerSource() calls invalidate().
  let cache = new WeakMap();

  function invalidate(player) {
    if (player) {
      try { cache.delete(player); } catch (e) {}
    } else {
      cache = new WeakMap();
    }
  }

  // ====================================================================
  // Source registry
  // ====================================================================

  const sources = [];                          // {name, priority, fn, seq, errors}
  let seq = 0;

  function sortSources() {
    sources.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
  }

  // Duplicate names replace in place (keeps their original slot), mirroring
  // TC.Systems.register. Returns an unsubscribe function.
  function registerSource(name, priority, fn) {
    if (typeof name !== 'string' || !name ||
        typeof priority !== 'number' || !isFinite(priority) ||
        typeof fn !== 'function') {
      console.warn('[TC.Stats] registerSource: need (string name, number priority, fn(player, out))');
      return function () {};
    }
    let entry = null;
    for (let i = 0; i < sources.length; i++) {
      if (sources[i].name === name) { entry = sources[i]; break; }
    }
    if (entry) {
      console.warn('[TC.Stats] duplicate source "' + name + '" — replacing in place');
      entry.priority = priority;
      entry.fn = fn;
    } else {
      entry = { name: name, priority: priority, fn: fn, seq: seq++, errors: 0 };
      sources.push(entry);
    }
    sortSources();
    invalidate();
    return function () {
      const i = sources.indexOf(entry);
      if (i >= 0) sources.splice(i, 1);
      invalidate();
    };
  }

  // Run every source against `out`. When `rows` is given, per-source field
  // diffs are appended for explain().
  function runSources(player, out, rows) {
    for (let i = 0; i < sources.length; i++) {
      const entry = sources[i];
      const before = rows ? Object.assign({}, out) : null;
      try {
        entry.fn(player, out);
      } catch (err) {
        entry.errors++;
        if (entry.errors <= 3) console.warn('[TC.Stats] source "' + entry.name + '" threw:', err);
      }
      if (rows) {
        const changes = {};
        for (const f in out) {
          if (out[f] !== before[f]) changes[f] = { from: before[f], to: out[f] };
        }
        rows.push({ name: entry.name, priority: entry.priority, changes: changes });
      }
    }
  }

  // ====================================================================
  // Bases (mirrors of today's arithmetic, kept in one place)
  // ====================================================================

  // Mirror of the ORIGINAL Player.totalDefense body (pre-wrap): equipped
  // armor only. Reads equipment directly so the wrapped method — which adds
  // accessory/buff defense — is never double-counted.
  function equippedArmorDefense(player) {
    const eq = player && player.equipment;
    if (!eq) return 0;
    const slots = (TC.CONST && TC.CONST.EQUIP_SLOTS && TC.CONST.EQUIP_SLOTS.length)
      ? TC.CONST.EQUIP_SLOTS : ['head', 'body', 'feet'];
    let n = 0;
    for (let i = 0; i < slots.length; i++) {
      const d = itemDef(eq[slots[i]]);
      if (d && d.kind === 'armor') n += d.defense || 0;
    }
    return n;
  }

  // ---- built-in sources ----

  registerSource('core.armor', 100, function (player, out) {
    out.defense += equippedArmorDefense(player);
  });

  // While loot.js's __lootWrap is installed on modsOf, its life-crystal HP
  // bonus arrives folded into m.maxHp here; progress.lifeCrystals below
  // detects that marker and stays out of the way.
  registerSource('gear.accessories', 200, function (player, out) {
    const Acc = TC.Accessories;
    if (Acc && typeof Acc.modsOf === 'function') foldMods(out, Acc.modsOf(player));
  });

  registerSource('status.buffs', 300, function (player, out) {
    const B = TC.Buffs;
    if (B && typeof B.modsOf === 'function') foldMods(out, B.modsOf());
  });

  // loot.js CRYSTAL_STEP/CRYSTAL_MAX_USES: +20 max HP per crystal, 15 uses.
  registerSource('progress.lifeCrystals', 400, function (player, out) {
    const n = player ? (player.lifeCrystals | 0) : 0;
    if (!(n > 0)) return;
    const Acc = TC.Accessories;
    if (Acc && typeof Acc.modsOf === 'function' && Acc.modsOf.__lootWrap) return;
    out.maxHealth += Math.min(n, 15) * 20;
  });

  // ====================================================================
  // Resolution
  // ====================================================================

  function finalize(player, out) {
    const C = TC.CONST || {};
    const p = (player && typeof player === 'object') ? player : {};
    // Base max mana is the live pool (crystal growth lives there, persisted
    // by magic.js); MANA_BASE is the fallback for untouched players.
    const baseMaxMana = (typeof p.maxMana === 'number' && isFinite(p.maxMana) && p.maxMana > 0)
      ? p.maxMana : numOr(TC.Magic && TC.Magic.MANA_BASE, 20);
    const maxMana = baseMaxMana + out.maxMana;
    return {
      maxHealth: numOr(C.PLAYER_HP, 100) + out.maxHealth,
      healthRegen: numOr(C.REGEN_RATE, 1.6) + out.healthRegen,
      maxMana: maxMana,
      manaRegen: (3 + maxMana * 0.05) + out.manaRegen,   // mirrors Magic regenRate
      // Armor rides in out.defense via core.armor, so one rounding over the
      // total reproduces the legacy `armor + Math.round(deltas)` exactly
      // (armor values are integers).
      defense: Math.round(out.defense),
      moveSpeed: sanitizeMul(out.moveSpeed),
      jumpPower: sanitizeMul(out.jumpPower),
      knockback: sanitizeMul(out.knockback),
      meleeDamage: sanitizeMul(out.meleeDamage),
      rangedDamage: sanitizeMul(out.rangedDamage),
      magicDamage: sanitizeMul(out.magicDamage),
      summonDamage: sanitizeMul(out.summonDamage),
      miningSpeed: sanitizeMul(out.miningSpeed),
      critChance: numOr(C.CRIT_CHANCE, 0.08) + out.critChance,
      armorPenetration: out.armorPenetration,
      fishingPower: out.fishingPower
    };
  }

  // Everything the resolver reads, as one comparable string. Presence-based
  // for buffs (their mods don't vary with remaining time), so a ticking buff
  // down to zero flips the signature exactly once — at expiry.
  function signature(p) {
    let s = '';
    const eq = p.equipment;
    s += eq ? ((eq.head || '') + ',' + (eq.body || '') + ',' + (eq.feet || '')) : '-';
    const acc = Array.isArray(p.accessories) ? p.accessories : null;
    if (acc) {
      for (let i = 0; i < acc.length; i++) {
        const e = acc[i];
        s += '|' + (e ? e.id + ':' + (e.prefix || '') : 'n');
      }
    }
    const bl = (TC.Buffs && Array.isArray(TC.Buffs.list)) ? TC.Buffs.list : null;
    if (bl) {
      for (let i = 0; i < bl.length; i++) s += '|' + bl[i].id;
    }
    return s + '#' + (p.lifeCrystals | 0) + '@' + (typeof p.maxMana === 'number' ? (p.maxMana | 0) : '?');
  }

  // Best-effort auto-invalidation on the stat-affecting bus events. Wired
  // lazily on first resolve/explain so script order never matters.
  let wired = false;
  function ensureWiring() {
    if (wired) return;
    wired = true;
    if (TC.Events && typeof TC.Events.on === 'function') {
      const E = TC.Events.EVENT || {};
      const names = [E.ItemEquipped, E.InventoryChanged, E.BuffApplied, E.BuffExpired];
      for (let i = 0; i < names.length; i++) {
        if (names[i]) TC.Events.on(names[i], function () { invalidate(); });
      }
    }
  }

  // Frozen snapshot of the player's effective stats. Safe to call with a
  // null/absent player (CONST-only bases).
  function resolve(player) {
    ensureWiring();
    const p = (player && typeof player === 'object') ? player : null;
    if (p) {
      const hit = cache.get(p);
      if (hit && hit.sig === signature(p)) return hit.snap;
    }
    const out = newAccum();
    runSources(p, out, null);
    const snap = Object.freeze(finalize(p, out));
    if (p) {
      try { cache.set(p, { sig: signature(p), snap: snap }); } catch (e) {}
    }
    return snap;
  }

  // Ordered contributor list for debug panels:
  //   [{name, priority, changes: {field: {from, to}}}, ...,
  //    {name: 'resolved', priority: null, values: <snapshot>}]
  function explain(player) {
    ensureWiring();
    const p = (player && typeof player === 'object') ? player : null;
    const out = newAccum();
    const rows = [];
    runSources(p, out, rows);
    rows.push({ name: 'resolved', priority: null, values: finalize(p, out) });
    return rows;
  }

  TC.Stats = {
    ADD_FIELDS: ADD_FIELDS.slice(),
    MUL_FIELDS: MUL_FIELDS.slice(),
    registerSource: registerSource,
    resolve: resolve,
    explain: explain,
    invalidate: invalidate
  };

  /* --------------------------------------------------------------------
     Migration notes for the lead (one hook per old wrap):

     player.js
       - totalDefense(): body may become
           `return TC.Stats ? TC.Stats.resolve(this).defense : <old body>;`
         (or callers read the snapshot directly).
       - update(): replace the RUN_MAX/RUN_ACCEL/REGEN_RATE mutation window
         and syncMaxHp with, once per step:
           const st = TC.Stats.resolve(this);
           maxSp = CONST.RUN_MAX * st.moveSpeed * swimMult;
           accel = CONST.RUN_ACCEL * st.moveSpeed * swimMult;
           regen uses st.healthRegen; keep maxHp synced to st.maxHealth
           (raise, and clamp hp above it — old syncMaxHp behavior).
     combat.js
       - meleeStrike callers: pass Math.round(dmg * st.meleeDamage); roll
         crit against st.critChance instead of CONST.CRIT_CHANCE.
       - shootArrow callers: pass Math.round(dmg * st.rangedDamage).
       - hurtPlayer: subtract st.defense (same number the old wrap produced).
     magic.js
       - bolt damage: Math.round(def.damage * st.magicDamage) at fire time;
         regenRate(maxMana) -> st.manaRegen when a per-player value is wanted.
     Call resolve() once per step and reuse the snapshot; it is cached and
     signature-checked, so repeated calls are cheap and never stale.
     -------------------------------------------------------------------- */
})();

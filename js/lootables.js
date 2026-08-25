/* lootables.js — TC.LootTables: THE canonical loot-table mechanism (W13.3).
   One schema, one evaluator, one validator for every drop roll in the game.

   Table entry schema (ENEMY_DEFS[].drops, chest/pot tables, future sources):
     id       item id string; must exist in TC.ITEM_DEFS at validation time
              ('' or unknown ids are validation problems, never silent skips)
     min/max  inclusive integer stack bounds (default 1..1); max >= min
     chance   0..1 roll probability (default 1 = guaranteed)
     requires optional progression gate: a flag string evaluated through
              TC.Progression.has when present (W14 generalizes the grammar)

   Coins: def.coins = [minCopper, maxCopper] rolls one integer amount and
   scatters canonical currency via TC.Economy.dropCoins.

   Determinism: roll(table, {rng}) accepts an injectable RNG for tests;
   gameplay paths default to the seeded GameRng 'loot' stream (runtime loot,
   not worldgen) since W23.

   Events: none emitted here — drops enter the world through TC.Items and
   TC.Economy, which own their own InventoryChanged emissions exactly once.
   Boss loot therefore cannot duplicate: killEnemy -> rollDrops -> rollEntity
   runs exactly once per death (damageEnemy's hp<=0 guard). */
'use strict';
(function () {
  window.TC = window.TC || {};
  const TC = window.TC;

  function defaultRng() {
    return TC.GameRng ? TC.GameRng.stream('loot').float() : Math.random();
  }

  function isRng(fn) { return typeof fn === 'function'; }

// Roll one table against rng. Returns [{id, count}] — pure data; callers
   // decide how to spawn. Entries carrying a `requires` gate that currently
   // fails are skipped. Unknown item ids and malformed entries are skipped
   // at ROLL time (a broken entry must not break combat), but validate()
   // reports them loudly for content authors and tests.
  function roll(table, opts) {
    const out = [];
    if (!Array.isArray(table)) return out;
    const o = opts || {};
    const rng = isRng(o.rng) ? o.rng : defaultRng;
    for (let i = 0; i < table.length; i++) {
      const d = table[i];
      if (!d || typeof d !== 'object') continue;
      if (typeof d.id !== 'string' || !d.id) continue;
      if (TC.ITEM_DEFS && !TC.ITEM_DEFS[d.id]) continue;
      if (!requiresOk(d)) continue;
      let chance = (d.chance == null) ? 1 : Number(d.chance);
      if (!isFinite(chance)) chance = 1;
      if (rng() >= chance) continue;
      let lo = (d.min == null) ? 1 : Math.floor(Number(d.min));
      let hi = (d.max == null) ? 1 : Math.floor(Number(d.max));
      if (!isFinite(lo) || lo < 1) lo = 1;
      if (!isFinite(hi) || hi < lo) hi = lo;
      const n = lo + Math.floor(rng() * (hi - lo + 1));
      if (n > 0) out.push({ id: d.id, count: n });
    }
    return out;
  }

  // Roll a [min,max] coin range; returns 0 for malformed ranges.
  function rollCoins(range, opts) {
    if (!Array.isArray(range) || range.length < 2) return 0;
    const lo = Math.max(0, Math.floor(Number(range[0]) || 0));
    const hi = Math.max(lo, Math.floor(Number(range[1]) || 0));
    if (hi <= 0) return 0;
    const rng = (opts && isRng(opts.rng)) ? opts.rng : defaultRng;
    return lo + Math.floor(rng() * (hi - lo + 1));
  }

  // Progression gate shared by roll-time filtering and validation. Uses the
  // full W14 condition grammar (flag string or compound object) via
  // TC.Progression.test; functions are honored for custom rules.
  function requiresOk(entry) {
    const r = entry.requires;
    if (r == null || r === '') return true;
    if (typeof r === 'function') {
      try { return !!r(entry); } catch (e) { return false; }
    }
    if (TC.Progression && typeof TC.Progression.test === 'function') {
      try { return !!TC.Progression.test(r); } catch (e) { return false; }
    }
    return false;
  }

  // Scatter an ENEMY_DEFS-style def (drops[] + coins[]) into the world at
  // (cx, cy). The single entry point Enemies.rollDrops delegates to.
  function rollEntity(def, cx, cy, opts) {
    if (!def) return [];
    const rolled = [];
    const results = roll(Array.isArray(def.drops) ? def.drops : [], opts);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (TC.Items && typeof TC.Items.spawnDrop === 'function') {
        TC.Items.spawnDrop(cx, cy, r.id, r.count, true);
      }
      rolled.push(r);
    }
    const amount = rollCoins(def.coins, opts);
    if (amount > 0 && TC.Economy && typeof TC.Economy.dropCoins === 'function') {
      TC.Economy.dropCoins(cx, cy, amount);
      rolled.push({ id: '__coins__', count: amount });
    }
    return rolled;
  }

  // ---- validation --------------------------------------------------------

  // Returns an array of human-readable problems (empty = valid).
  function validate(table, label) {
    const problems = [];
    const who = label || 'loot table';
    if (!Array.isArray(table)) {
      problems.push(who + ': not an array');
      return problems;
    }
    for (let i = 0; i < table.length; i++) {
      const d = table[i];
      const at = who + '[' + i + ']';
      if (!d || typeof d !== 'object') {
        problems.push(at + ': entry is not an object');
        continue;
      }
      if (typeof d.id !== 'string' || !d.id) {
        problems.push(at + ': missing item id');
      } else if (TC.ITEM_DEFS && !TC.ITEM_DEFS[d.id]) {
        problems.push(at + ': unknown item id "' + d.id + '"');
      }
      if (d.chance != null) {
        const c = Number(d.chance);
        if (!isFinite(c) || c < 0 || c > 1) {
          problems.push(at + ': chance ' + d.chance + ' outside [0,1]');
        }
      }
      if (d.min != null && (!Number.isInteger(Number(d.min)) || Number(d.min) < 1)) {
        problems.push(at + ': min must be an integer >= 1');
      }
      if (d.max != null && (!Number.isInteger(Number(d.max)) || Number(d.max) < 1)) {
        problems.push(at + ': max must be an integer >= 1');
      }
      if (d.min != null && d.max != null &&
          Number(d.min) > Number(d.max)) {
        problems.push(at + ': min > max');
      }
      if (d.requires != null && typeof d.requires !== 'string' &&
          typeof d.requires !== 'object') {
        problems.push(at + ': requires must be a flag string or condition object');
      }
    }
    return problems;
  }

  function validateRange(range, label) {
    const who = label || 'coin range';
    if (range == null) return [];
    if (!Array.isArray(range) || range.length < 2 ||
        !Number.isInteger(Number(range[0])) || !Number.isInteger(Number(range[1])) ||
        Number(range[0]) < 0 || Number(range[1]) < Number(range[0])) {
      return [who + ': expected [minCopper, maxCopper] integers with min <= max'];
    }
    return [];
  }

  // Validate every enemy definition's drops+coins (boot-time sanity net).
  function validateAll() {
    const problems = [];
    const defs = TC.ENEMY_DEFS || {};
    for (const type in defs) {
      const def = defs[type];
      if (!def) continue;
      if (def.drops != null) {
        problems.push.apply(problems, validate(def.drops, 'ENEMY_DEFS.' + type + '.drops'));
      }
      if (def.coins != null) {
        problems.push.apply(problems, validateRange(def.coins, 'ENEMY_DEFS.' + type + '.coins'));
      }
    }
    return problems;
  }

  // Boot-time sanity net: log problems once per session. Validation NEVER
  // blocks boot — a malformed mod/table degrades, it does not crash.
  if (TC.Systems && typeof TC.Systems.boot === 'function') {
    TC.Systems.boot('core.loot-validation', {
      init: function () {
        const problems = validateAll();
        for (let i = 0; i < problems.length; i++) {
          console.warn('[TC.LootTables] ' + problems[i]);
        }
      },
    });
  }

  TC.LootTables = {
    roll,
    rollCoins,
    rollEntity,
    validate,
    validateRange,
    validateAll,
  };
})();

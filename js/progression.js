/* progression.js — TC.Progression: world progression flag store PLUS the
   one declarative condition grammar every consumer shares (W14).
   Tracks one-way world milestones (bosses defeated, events completed,
   biomes discovered) as string keys. Consumers query has(FLAGS.x) live or
   evaluate compound specs through test(cond); nothing here is cached
   elsewhere, so restores take effect immediately.

   Well-known keys (see FLAGS): 'boss.eye_of_void.defeated',
   'boss.king_slime.defeated', 'boss.skeletron.defeated',
   'boss.wall_of_flesh.defeated', 'boss.storm_jelly.defeated',
   'boss.moss_mother.defeated', 'event.blood_moon.completed'.

   Condition grammar (test(cond) -> bool, pure, side-effect free):
     null / undefined     always true  (unconditional)
     boolean              itself
     'flag.string'        has(flag)
     [c0, c1, ...]        all-of
     {all: [...]}         all-of
     {any: [...]}
     {not: cond}
     {flag: 'x'}          has('x')
     {boss: 'storm_jelly'} has('boss.storm_jelly.defeated')
     {event: 'blood_moon'} has('event.blood_moon.completed')
     {biome: 'snow'}      has('biome.snow.discovered')
   Unknown shapes FAIL CLOSED (false) so typos can never silently unlock.
   Consumers: recipe gating (Crafting), NPC unlocks + shop stock rows
   (NPCs), loot entries (LootTables), spawn-table entries (EnemySpawn),
   boss-summon availability (Player.doSummon).

   Wiring:
     - Listens to TC.Events.EVENT.BossDefeated and records
       'boss.<type>.defeated' (canonical names via BOSS_FLAG below, generic
       fallback for future bosses), emitting WorldProgressChanged per new
       flag.
     - Persists through SaveCore provider 'systems.core.progression'.
     - resetForNewWorld() clears the store; the lead calls it on new game.
     - spawnMultiplier() is a difficulty knob consumed by
       TC.EnemySpawn.spawnDirector: +10% spawn rate per defeated boss, cap
       1.5x.

   Deterministic: no randomness anywhere in this module. */
'use strict';
(function () {
  window.TC = window.TC || {};
  const TC = window.TC;

  // Canonical flag keys other modules may reference by name.
  const FLAGS = Object.freeze({
    bossEyeOfVoid: 'boss.eye_of_void.defeated',
    bossKingSlime: 'boss.king_slime.defeated',
    bossSkeletron: 'boss.skeletron.defeated',
    bossWallOfFlesh: 'boss.wall_of_flesh.defeated',
    bossStormJelly: 'boss.storm_jelly.defeated',
    bossMossMother: 'boss.moss_mother.defeated',
    eventBloodMoon: 'event.blood_moon.completed'
  });

  // BossDefeated payload.type (ENEMY_DEFS key) -> canonical flag. Unknown
  // boss types derive 'boss.<type>.defeated' so they still count.
  const BOSS_FLAG = {
    void_eye: FLAGS.bossEyeOfVoid,
    king_slime: FLAGS.bossKingSlime,
    skeletron: FLAGS.bossSkeletron,
    wof: FLAGS.bossWallOfFlesh,
    storm_jelly: FLAGS.bossStormJelly,
    moss_mother: FLAGS.bossMossMother
  };

  // Spawn-rate scaling per defeated boss flag (see spawnMultiplier).
  const SPAWN_BONUS_PER_BOSS = 0.10;
  const SPAWN_MULT_CAP = 1.5;

  const flags = new Set();

  function validKey(key) { return typeof key === 'string' && key.length > 0; }

  // Idempotent: setting an already-set flag is a no-op. Emits
  // WorldProgressChanged ({key}) only on the unset -> set transition.
  // Returns true when the flag was newly recorded.
  function set(key) {
    if (!validKey(key) || flags.has(key)) return false;
    flags.add(key);
    if (TC.Events) {
      try { TC.Events.emit(TC.Events.EVENT.WorldProgressChanged, { key: key }); } catch (err) {}
    }
    return true;
  }

  function has(key) { return validKey(key) && flags.has(key); }

  // Live lookup through the public export so instrumentation/stubs of
  // TC.Progression.has stay honored (and headless tests can intercept).
  function hasLive(key) {
    if (TC.Progression && typeof TC.Progression.has === 'function') {
      try { return !!TC.Progression.has(key); } catch (e) { return false; }
    }
    return has(key);
  }

  // ---- declarative condition grammar (W14) -------------------------------
  // Pure, side-effect free, deterministic. Unknown shapes fail closed.
  function test(cond) {
    if (cond == null) return true;
    if (typeof cond === 'boolean') return cond;
    if (typeof cond === 'string') return hasLive(cond);
    if (Array.isArray(cond)) {
      for (let i = 0; i < cond.length; i++) {
        if (!test(cond[i])) return false;
      }
      return true;
    }
    if (typeof cond === 'object') {
      if (Array.isArray(cond.all)) return test(cond.all);
      if (Array.isArray(cond.any)) {
        for (let i = 0; i < cond.any.length; i++) {
          if (test(cond.any[i])) return true;
        }
        return false;
      }
      if ('not' in cond) return !test(cond.not);
      if (typeof cond.flag === 'string') return hasLive(cond.flag);
      if (typeof cond.boss === 'string') return hasLive('boss.' + cond.boss + '.defeated');
      if (typeof cond.event === 'string') return hasLive('event.' + cond.event + '.completed');
      if (typeof cond.biome === 'string') {
        const k = 'biome.' +
          cond.biome.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.discovered';
        return hasLive(k);
      }
    }
    return false; // unknown shape: fail closed
  }

  // One-way world discovery milestone (W5): 'biome.<name>.discovered'.
  // Idempotent like set(); returns true only on first discovery so callers
  // can announce it. Unknown names are sanitized into lowercase-dash keys.
  function discoverBiome(name) {
    if (typeof name !== 'string' || !name.length) return false;
    const key = 'biome.' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_') +
      '.discovered';
    return set(key);
  }

  // Sorted snapshot — deterministic order for saves and debug output.
  function all() { return Array.from(flags).sort(); }

  function resetForNewWorld() { flags.clear(); }

  // Spawn-rate multiplier consumed by Enemies.spawnDirector: +10% per
  // distinct 'boss.*.defeated' flag, capped at 1.5x (1x before any boss).
  function spawnMultiplier() {
    let bosses = 0;
    flags.forEach(function (k) { if (/^boss\..+\.defeated$/.test(k)) bosses++; });
    return Math.min(SPAWN_MULT_CAP, 1 + bosses * SPAWN_BONUS_PER_BOSS);
  }

  // ---- foundation wiring ----
  if (TC.Events && TC.Events.EVENT && typeof TC.Events.on === 'function') {
    TC.Events.on(TC.Events.EVENT.BossDefeated, function (payload) {
      const t = payload && payload.type;
      if (!validKey(t)) return;
      set(BOSS_FLAG[t] || ('boss.' + t + '.defeated'));
    });
  }

  if (TC.SaveCore && typeof TC.SaveCore.register === 'function') {
    try {
      TC.SaveCore.register('systems.core.progression', {
        version: 1,
        serialize: function () { return { flags: all() }; },
        deserialize: function (data) {
          // Silent bulk restore: loading saved state is not new progress,
          // so no WorldProgressChanged fires during deserialize.
          if (!data || !Array.isArray(data.flags)) return;
          for (let i = 0; i < data.flags.length; i++) {
            if (validKey(data.flags[i])) flags.add(data.flags[i]);
          }
        }
      });
    } catch (e) {
      console.warn('[TC.Progression] SaveCore provider refused:', e && e.message);
    }
  }

  TC.Progression = {
    FLAGS: FLAGS,
    BOSS_FLAG: BOSS_FLAG,
    set: set,
    has: has,
    test: test,
    all: all,
    discoverBiome: discoverBiome,
    resetForNewWorld: resetForNewWorld,
    spawnMultiplier: spawnMultiplier
  };
})();

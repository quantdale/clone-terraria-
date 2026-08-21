/* progression.js — TC.Progression: world progression flag store.
   Tracks one-way world milestones (bosses defeated, events completed) as
   string keys. Consumers query has(FLAGS.x) live; nothing here is cached
   elsewhere, so restores take effect immediately.

   Well-known keys (see FLAGS): 'boss.eye_of_void.defeated',
   'boss.king_slime.defeated', 'boss.skeletron.defeated',
   'boss.wall_of_flesh.defeated', 'event.blood_moon.completed'.

   Wiring:
     - Listens to TC.Events.EVENT.BossDefeated and records
       'boss.<type>.defeated' (canonical names via BOSS_FLAG below, generic
       fallback for future bosses), emitting WorldProgressChanged per new flag.
     - Persists through SaveCore provider 'systems.core.progression'.
     - resetForNewWorld() clears the store; the lead calls it on new game.
     - spawnMultiplier() is a difficulty knob consumed by
       TC.Enemies.spawnDirector: +10% spawn rate per defeated boss, cap 1.5x.

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
    eventBloodMoon: 'event.blood_moon.completed'
  });

  // BossDefeated payload.type (ENEMY_DEFS key) -> canonical flag. Unknown
  // boss types derive 'boss.<type>.defeated' so they still count.
  const BOSS_FLAG = {
    void_eye: FLAGS.bossEyeOfVoid,
    king_slime: FLAGS.bossKingSlime,
    skeletron: FLAGS.bossSkeletron,
    wof: FLAGS.bossWallOfFlesh
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
    set: set,
    has: has,
    all: all,
    resetForNewWorld: resetForNewWorld,
    spawnMultiplier: spawnMultiplier
  };
})();

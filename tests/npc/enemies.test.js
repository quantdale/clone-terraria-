/* tests/npc/enemies.test.js — TARGET 2: TC.Enemies.
   Covers killEnemy drop rolls honoring def.drops (chance/min/max, exact
   counts via a deterministic Math.random queue + statistical sanity over
   many seeded kills), servant cleanup on boss death, EntityKilled /
   BossDefeated payloads, spawnDirector honoring Progression.spawnMultiplier
   and Biomes.getSpawnOverride, blood-moon night-table replacement, and the
   MAX_ENEMIES cap.

   Determinism note: loadGame's sandbox shares the HOST Math object, so we
   temporarily replace Math.random here (queue -> seeded PRNG fallback) and
   always restore it in finally. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

// ---- host-level Math.random control --------------------------------------
const REAL_RANDOM = Math.random;

// Values are consumed from `queue` first; afterwards a seeded PRNG takes over
// so long runs stay reproducible. Returns a restore function.
function installRandom(queue, seed) {
  let qi = 0;
  let s = seed >>> 0;
  const prng = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = () => (qi < queue.length ? queue[qi++] : prng());
  return () => { Math.random = REAL_RANDOM; };
}

// Minimal enemy shape matching what damageEnemy/killEnemy touch.
function fakeEnemy(TC, typeId, x, y) {
  const def = TC.ENEMY_DEFS[typeId];
  return {
    type: typeId, def,
    x: x || 100, y: y || 100, w: def.w, h: def.h,
    vx: 0, vy: 0, hp: def.hp, maxHp: def.hp,
    facing: 1, flashTimer: 0, fade: 1
  };
}

// Spy recorder replacing TC.Items.spawnDrop for the duration of `fn`.
function withDropSpy(TC, fn) {
  const orig = TC.Items.spawnDrop;
  const drops = [];
  TC.Items.spawnDrop = (x, y, id, count, scatter) => { drops.push({ id, count }); };
  try { fn(drops); } finally { TC.Items.spawnDrop = orig; }
}

test('enemies: rollDrops honors def.drops chances, min/max counts exactly', () => {
  const { TC } = loadGame();
  TC.newGame(7);
  // Entry A: chance 0.5, gel 2..4. Entry B: chance 0 -> never drops.
  const e = fakeEnemy(TC, 'blue_slime');
  e.def = Object.assign({}, TC.ENEMY_DEFS.blue_slime, {
    drops: [
      { id: 'gel', min: 2, max: 4, chance: 0.5 },
      { id: 'feather', min: 1, max: 1, chance: 0 }
    ]
  });
  TC.Enemies.list.push(e);

  // Roll sequence: r=0.10 passes chance .5; count roll 0.99 -> 2+floor(.99*3)=4;
  // next draw skips entry B (any r >= 0 fails chance 0).
  const restore = installRandom([0.10, 0.99, 0.50], 1);
  try {
    withDropSpy(TC, (drops) => {
      TC.Enemies.damageEnemy(e, 9999, 1, 5);
      assert.equal(e.hp <= 0 || TC.Enemies.list.indexOf(e) === -1, true, 'enemy should be dead');
      assert.deepStrictEqual(drops, [{ id: 'gel', count: 4 }],
        'expected exactly one gel stack of 4 (max roll), got ' + JSON.stringify(drops));
    });
  } finally { restore(); }
});

test('enemies: rollDrops min bound, guaranteed chance, and zero-count guard', () => {
  const { TC } = loadGame();
  TC.newGame(7);

  // min bound: chance .5 passes at 0.49; count roll 0.0 -> exactly min=3
  const e1 = fakeEnemy(TC, 'blue_slime');
  e1.def = Object.assign({}, e1.def, { drops: [{ id: 'gel', min: 3, max: 3, chance: 0.5 }] });
  TC.Enemies.list.push(e1);
  let restore = installRandom([0.49, 0.0], 1);
  try {
    withDropSpy(TC, (drops) => {
      TC.Enemies.damageEnemy(e1, 9999, 1, 5);
      assert.deepStrictEqual(drops, [{ id: 'gel', count: 3 }], 'min bound violated');
    });
  } finally { restore(); }

  // chance >= 1 always drops even at r=0.999999
  const e2 = fakeEnemy(TC, 'green_slime');
  e2.def = Object.assign({}, e2.def, { drops: [{ id: 'gel', min: 1, max: 2, chance: 1 }] });
  TC.Enemies.list.push(e2);
  restore = installRandom([0.999999, 0.9], 1);
  try {
    withDropSpy(TC, (drops) => {
      TC.Enemies.damageEnemy(e2, 9999, 1, 5);
      assert.equal(drops.length, 1, 'chance 1 must always drop');
    });
  } finally { restore(); }

  // n === 0 must not spawn anything
  const e3 = fakeEnemy(TC, 'green_slime');
  e3.def = Object.assign({}, e3.def, { drops: [{ id: 'gel', min: 0, max: 0, chance: 1 }] });
  TC.Enemies.list.push(e3);
  restore = installRandom([0.1, 0.1], 1);
  try {
    withDropSpy(TC, (drops) => {
      TC.Enemies.damageEnemy(e3, 9999, 1, 5);
      assert.deepStrictEqual(drops, [], 'zero-count entry must not spawn a drop');
    });
  } finally { restore(); }
});

test('enemies: statistical sanity — blue_slime always drops gel within [1,3]', () => {
  const { TC } = loadGame();
  TC.newGame(7);
  const restore = installRandom([], 20260821);
  try {
    withDropSpy(TC, (drops) => {
      for (let k = 0; k < 300; k++) {
        const e = fakeEnemy(TC, 'blue_slime', 100 + k, 100);
        TC.Enemies.list.push(e);
        TC.Enemies.damageEnemy(e, 9999, 1, 5);
      }
      assert.equal(drops.length, 300, 'chance-1 drop missed on some kill');
      for (const d of drops) {
        assert.equal(d.id, 'gel');
        assert.ok(d.count >= 1 && d.count <= 3, 'gel count out of def range: ' + d.count);
      }
      // both ends of the range should be hit by a healthy sample
      const counts = new Set(drops.map((d) => d.count));
      assert.ok(counts.size >= 2, 'count rolls degenerate: ' + [...counts]);
    });
  } finally { restore(); }
});

test('enemies: real defs keep zombie/demon_eye/cave_bat dropless; bosses drop guaranteed stacks', () => {
  const { TC } = loadGame();
  TC.newGame(7);
  const restore = installRandom([0.999999, 0.999999, 0.999999, 0.999999], 5);
  try {
    withDropSpy(TC, (drops) => {
      for (const id of ['zombie', 'demon_eye', 'cave_bat']) {
        const e = fakeEnemy(TC, id, 120, 120);
        TC.Enemies.list.push(e);
        TC.Enemies.damageEnemy(e, 9999, 1, 5);
        assert.deepStrictEqual(drops, [], id + ' should have empty drops');
      }
      // void_eye: two guaranteed entries (gel 25..40, gold_bar 5..8)
      const b = fakeEnemy(TC, 'void_eye', 200, 60);
      TC.Enemies.list.push(b);
      TC.Enemies.damageEnemy(b, 99999, 1, 5);
      const gel = drops.find((d) => d.id === 'gel');
      const gold = drops.find((d) => d.id === 'gold_bar');
      assert.ok(gel && gel.count >= 25 && gel.count <= 40, 'void_eye gel bad: ' + JSON.stringify(gel));
      assert.ok(gold && gold.count >= 5 && gold.count <= 8, 'void_eye gold bad: ' + JSON.stringify(gold));
    });
  } finally { restore(); }
});

test('enemies: boss death cleans servants and emits correct EntityKilled/BossDefeated payloads', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(11);
  const events = [];
  TC.Events.on(TC.Events.EVENT.EntityKilled, (p) => events.push(['killed', p]));
  TC.Events.on(TC.Events.EVENT.BossDefeated, (p) => events.push(['boss', p]));

  const boss = TC.Enemies.spawnBoss('void_eye', TC.player.x, TC.player.y - 30 * TC.CONST.TS);
  assert.ok(boss, 'spawnBoss returned null');
  assert.equal(boss.def.boss, true);

  // attach a live servant linked to the boss
  const servant = fakeEnemy(TC, 'demon_eye', boss.x, boss.y);
  servant.master = boss;
  TC.Enemies.list.push(servant);
  assert.equal(TC.Enemies.list.length, 2);

  TC.Enemies.damageEnemy(boss, 999999, 1, 5);

  assert.equal(TC.Enemies.list.indexOf(servant), -1,
    'servant must be removed when its master boss dies');

  const killed = events.find((e) => e[0] === 'killed');
  const bossEv = events.find((e) => e[0] === 'boss');
  assert.ok(killed, 'no EntityKilled emitted');
  assert.equal(killed[1].type, 'void_eye');
  assert.equal(killed[1].boss, true);
  assert.equal(typeof killed[1].x, 'number');
  assert.equal(typeof killed[1].y, 'number');
  assert.ok(bossEv, 'no BossDefeated emitted for a boss kill');
  assert.deepStrictEqual(bossEv[1], { type: 'void_eye' });

  // BossDefeated auto-recorded progression too (integration)
  assert.equal(TC.Progression.has('boss.eye_of_void.defeated'), true);
});

test('enemies: non-boss kill emits EntityKilled {boss:false} and never BossDefeated', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(12);
  const events = [];
  TC.Events.on(TC.Events.EVENT.EntityKilled, (p) => events.push(['killed', p]));
  TC.Events.on(TC.Events.EVENT.BossDefeated, (p) => events.push(['boss', p]));

  const e = fakeEnemy(TC, 'zombie', 150, 150);
  TC.Enemies.list.push(e);
  TC.Enemies.damageEnemy(e, 9999, 1, 5);

  const killed = events.find((e2) => e2[0] === 'killed');
  assert.ok(killed, 'no EntityKilled');
  assert.equal(killed[1].type, 'zombie');
  assert.equal(killed[1].boss, false);
  assert.equal(events.some((e2) => e2[0] === 'boss'), false,
    'BossDefeated fired for a non-boss');
});

test('enemies: MAX_BOSSES respected — second concurrent boss refused', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(13);
  const a = TC.Enemies.spawnBoss('king_slime', TC.player.x, TC.player.y - 20 * TC.CONST.TS);
  assert.ok(a);
  const b = TC.Enemies.spawnBoss('void_eye', TC.player.x + 100, TC.player.y - 20 * TC.CONST.TS);
  assert.equal(b, null, 'MAX_BOSSES=1 should refuse a second live boss');
  // killing the first frees the slot again
  TC.Enemies.damageEnemy(a, 999999, 1, 5);
  const c = TC.Enemies.spawnBoss('king_slime', TC.player.x, TC.player.y - 20 * TC.CONST.TS);
  assert.ok(c, 'boss slot not freed after defeat');
});

// ---- spawnDirector --------------------------------------------------------
// Common rig: fresh world, day forced, spawn table overridden, spawns counted
// while the list is cleared after each success (keeps MAX_ENEMIES unbound).
function directorRig(seedVal, mult, overrideTable, daylightVal) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(seedVal);
  const restoreRandom = installRandom([], seedVal * 7919 + 13);
  TC.Sky.daylight = () => (daylightVal != null ? daylightVal : 1);
  if (overrideTable) TC.Biomes.getSpawnOverride = () => overrideTable;
  const origMult = TC.Progression.spawnMultiplier;
  TC.Progression.spawnMultiplier = () => mult;
  return { g, TC, restoreRandom, origMult };
}

function countSpawns(TC, simSeconds, dt) {
  let spawns = 0;
  let t = 0;
  while (t < simSeconds) {
    const before = TC.Enemies.list.length;
    TC.Enemies.spawnDirector(dt);
    t += dt;
    if (TC.Enemies.list.length > before) {
      spawns += TC.Enemies.list.length - before;
      TC.Enemies.clear();          // also restarts the 2s grace, same for both arms
    }
  }
  return spawns;
}

test('enemies: spawnDirector rate scales with Progression.spawnMultiplier', () => {
  const SEED = 21, HORIZON = 600, DT = 0.05;

  const rig1 = directorRig(SEED, 1, [['zombie', 1]]);
  let c1;
  try { c1 = countSpawns(rig1.TC, HORIZON, DT); } finally { rig1.restoreRandom(); }

  const rig4 = directorRig(SEED, 4, [['zombie', 1]]);
  let c4;
  try { c4 = countSpawns(rig4.TC, HORIZON, DT); } finally { rig4.restoreRandom(); }

  // Same seed/table/daylight: the only difference is the rate multiplier
  // (interval = 5.5/mult + 2s grace per spawn -> expect roughly 2-3x).
  assert.ok(c1 > 0, 'baseline arm produced no spawns');
  assert.ok(c4 > c1 * 1.6, 'multiplier arm not faster enough: ' + c1 + ' vs ' + c4 +
    ' (ratio ' + (c4 / Math.max(1, c1)).toFixed(2) + ')');
  assert.ok(c4 < c1 * 4, 'multiplier arm suspiciously off-scale: ' + c4 + ' vs ' + c1);
});

test('enemies: spawnDirector honors Biomes.getSpawnOverride table', () => {
  const rig = directorRig(31, 1, [['granite_golem', 1]]);
  try {
    const types = new Set();
    let t = 0;
    const dt = 0.05;
    while (t < 900) {
      const before = rig.TC.Enemies.list.length;
      rig.TC.Enemies.spawnDirector(dt);
      t += dt;
      for (const e of rig.TC.Enemies.list) types.add(e.type);
      if (rig.TC.Enemies.list.length > before) rig.TC.Enemies.clear();
    }
    assert.ok(types.has('granite_golem'),
      'override-table enemy never spawned: ' + [...types]);
    // granite_golem is in neither CONST.SPAWN.day nor EXTRA_SPAWN.day, so any
    // other type can only come from the day extras (harpy) — subset check:
    for (const ty of types) {
      assert.ok(ty === 'granite_golem' || ty === 'harpy',
        'unexpected type leaked into overridden day table: ' + ty);
    }
  } finally { rig.restoreRandom(); }
});

test('enemies: blood moon replaces the whole night table', () => {
  // normal night: blood-moon-only types must never appear
  const rigN = directorRig(41, 1, null, 0);
  let sawNightTypes = false;
  try {
    let t = 0;
    while (t < 400) {
      const before = rigN.TC.Enemies.list.length;
      rigN.TC.Enemies.spawnDirector(0.05);
      t += 0.05;
      for (const e of rigN.TC.Enemies.list) {
        assert.ok(['zombie', 'demon_eye', 'eater_of_souls'].includes(e.type),
          'non-blood-moon night spawned ' + e.type);
        sawNightTypes = true;
      }
      if (rigN.TC.Enemies.list.length > before) rigN.TC.Enemies.clear();
    }
    assert.ok(sawNightTypes, 'night arm produced no spawns at all');
  } finally { rigN.restoreRandom(); }

  // blood moon night: BLOOD_MOON_TABLE types appear, including exclusives
  const rigB = directorRig(42, 1, null, 0);
  try {
    rigB.TC.Enemies.setBloodMoon(true);
    const types = new Set();
    let t = 0;
    while (t < 400) {
      const before = rigB.TC.Enemies.list.length;
      rigB.TC.Enemies.spawnDirector(0.05);
      t += 0.05;
      for (const e of rigB.TC.Enemies.list) {
        types.add(e.type);
        assert.ok(
          ['zombie', 'demon_eye', 'blood_crawler', 'crimson_slime', 'eater_of_souls'].includes(e.type),
          'blood moon spawned out-of-table type ' + e.type);
      }
      if (rigB.TC.Enemies.list.length > before) rigB.TC.Enemies.clear();
    }
    assert.ok(types.has('blood_crawler') || types.has('crimson_slime'),
      'blood-moon-exclusive types never spawned: ' + [...types]);
  } finally { rigB.restoreRandom(); }
});

test('enemies: MAX_ENEMIES cap is enforced (with a live control arm)', () => {
  const CAP = loadGame().TC.CONST.MAX_ENEMIES;
  assert.equal(CAP, 8);

  // Control: without dummies the director does spawn under this rig.
  const rigC = directorRig(51, 8, [['zombie', 1]]);   // mult 8 -> fast attempts
  try {
    let spawns = 0;
    let t = 0;
    while (t < 120) {
      const before = rigC.TC.Enemies.list.length;
      rigC.TC.Enemies.spawnDirector(0.05);
      t += 0.05;
      if (rigC.TC.Enemies.list.length > before) { spawns++; rigC.TC.Enemies.clear(); }
    }
    assert.ok(spawns > 0, 'control arm produced no spawns — rig broken');
  } finally { rigC.restoreRandom(); }

  // Capped: pre-fill the list to the cap; no further spawns may occur.
  const rig = directorRig(52, 8, [['zombie', 1]]);
  try {
    for (let i = 0; i < CAP; i++) {
      rig.TC.Enemies.list.push({
        type: 'zombie', def: rig.TC.ENEMY_DEFS.zombie,
        x: 100 + i, y: 100, w: 22, h: 42, vx: 0, vy: 0, hp: 45, maxHp: 45,
        facing: 1, flashTimer: 0, fade: 1
      });
    }
    let t = 0;
    while (t < 240) {
      rig.TC.Enemies.spawnDirector(0.05);
      t += 0.05;
      assert.ok(rig.TC.Enemies.list.length <= CAP,
        'cap exceeded: ' + rig.TC.Enemies.list.length);
    }
    assert.equal(rig.TC.Enemies.list.length, CAP, 'dummy population disturbed');
  } finally { rig.restoreRandom(); }
});

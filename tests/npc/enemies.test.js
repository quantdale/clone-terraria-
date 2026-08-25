/* tests/npc/enemies.test.js — TARGET: TC.Enemies behaviors.
   Covers deterministic loot rolls from ENEMY_DEFS[].drops (pinned through
   the W23 TC.GameRng test seam), boss-death servant/part
   cleanup, EntityKilled/BossDefeated single-fire payloads, spawnDirector
   honoring Progression.spawnMultiplier + Biomes.getSpawnOverride, and the
   CONST.MAX_ENEMIES population cap. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 20260821 : seed);
  return g;
}

// Pin every authoritative GameRng stream to fn (W23 seam). The pre-W23
// version patched host Math.random through the shared vm Math object.
function patchRandom(g, fn) {
  g.TC.GameRng.override(null, fn);
  return () => g.TC.GameRng.clearOverrides();
}

// Minimal live-enemy shape sufficient for damageEnemy/killEnemy.
function fakeEnemy(TC, type, x, y) {
  const def = TC.ENEMY_DEFS[type];
  return {
    type, def,
    x: x == null ? 200 : x, y: y == null ? 200 : y,
    w: def.w, h: def.h, vx: 0, vy: 0,
    hp: def.hp, maxHp: def.hp,
    facing: 1, flashTimer: 0, touchTimer: 0, fade: 1, servants: 0
  };
}

function stacksOf(TC, id) { return TC.Items.drops.filter((d) => d.id === id); }

test('enemies: killEnemy rolls def.drops deterministically (chance gate + min/max)', () => {
  const g = boot();
  const TC = g.TC;

  // rng pinned to 0.5: every chance>=0.5 gate passes, count = min + floor(0.5*span).
  let restore = patchRandom(g, () => 0.5);
  try {
    TC.Items.clearDrops();
    const e = fakeEnemy(TC, 'green_slime');            // {gel, min:1, max:2, chance:1}
    TC.Enemies.list.push(e);
    TC.Enemies.damageEnemy(e, 9999, 1, 0);
    assert.equal(TC.Enemies.list.indexOf(e), -1, 'dead enemy must leave the list');
    const gel = stacksOf(TC, 'gel');
    assert.equal(gel.length, 1, 'expected exactly one gel stack');
    assert.equal(gel[0].count, 2, '1 + floor(0.5*(2-1+1)) must be 2');

    // chance gate can fail: harpy feather chance 0.9 with rng 0.95 -> no
    // feather; W2 economy coins are a separate always-on roll, so the only
    // drops may be coin_* stacks (harpy coins [30,60] -> silver+copper).
    restore();                                   // swap the pinned value
    restore = patchRandom(g, () => 0.95);
    TC.Items.clearDrops();
    TC.Enemies.list.length = 0;
    const h = fakeEnemy(TC, 'harpy');                  // [{feather, 1..2, chance:0.9}]
    TC.Enemies.list.push(h);
    TC.Enemies.damageEnemy(h, 9999, 1, 0);
    const nonCoin = TC.Items.drops.filter((d) => String(d.id).indexOf('coin_') !== 0);
    assert.equal(nonCoin.length, 0,
      'rng 0.95 >= chance 0.9 must skip the feather drop');
    assert.ok(TC.Items.drops.every((d) => String(d.id).indexOf('coin_') === 0),
      'only coin_* drops may accompany a failed chance roll');
  } finally { restore(); }

  // Whole min..max range reachable and never exceeded (blue_slime gel 1..3):
  // pin every call to v; count collapses to 1 + floor(3*v).
  const cases = [[1 / 6, 1], [0.5, 2], [5 / 6, 3]];
  for (const [v, want] of cases) {
    restore = patchRandom(g, () => v);
    try {
      TC.Items.clearDrops();
      TC.Enemies.list.length = 0;
      const b = fakeEnemy(TC, 'blue_slime');           // {gel, min:1, max:3, chance:1}
      TC.Enemies.list.push(b);
      TC.Enemies.damageEnemy(b, 9999, 1, 0);
      const gel = stacksOf(TC, 'gel');
      assert.equal(gel.length, 1, 'chance-1 entry must always drop');
      assert.equal(gel[0].count, want, 'rng ' + v + ' must yield count ' + want);
    } finally { restore(); }
  }
});

test('enemies: boss death takes linked servants and parts off the list', () => {
  const g = boot();
  const TC = g.TC;

  // King Slime + a manually linked servant (spawnServantOf is module-private,
  // so reproduce its wiring: servant.master = boss, boss.servants++).
  const boss = TC.Enemies.spawnBoss('king_slime', 400, 300);
  assert.ok(boss, 'king_slime summon failed');
  const serv = fakeEnemy(TC, 'blue_slime', boss.x, boss.y - 20);
  serv.master = boss;
  boss.servants = 1;
  TC.Enemies.list.push(serv);
  assert.equal(TC.Enemies.list.length, 2);

  TC.Enemies.damageEnemy(boss, 999999, 1, 0);
  assert.equal(TC.Enemies.list.includes(boss), false, 'boss itself must be removed');
  assert.equal(TC.Enemies.list.includes(serv), false, 'servant must die with its master');

  // Skeletron ships with two hand parts already linked via .master.
  const sk = TC.Enemies.spawnBoss('skeletron', 600, 300);
  assert.ok(sk, 'skeletron summon failed');
  assert.equal(TC.Enemies.list.filter((e) => e.type === 'skele_hand').length, 2,
    'expected both hands attached');
  TC.Enemies.damageEnemy(sk, 9999999, 1, 0);
  assert.equal(TC.Enemies.list.filter((e) => e.def.boss || e.def.part).length, 0,
    'skull and both hands must be gone after the head dies');
});

test('enemies: EntityKilled/BossDefeated fire exactly once with exact payloads', () => {
  const g = boot();
  const TC = g.TC;
  const EV = TC.Events.EVENT;
  const killed = [], bossDown = [];
  TC.Events.on(EV.EntityKilled, (p) => killed.push(p));
  TC.Events.on(EV.BossDefeated, (p) => bossDown.push(p));

  // Regular kill: exactly one EntityKilled carrying the bbox center, no boss event.
  // Payloads are built inside the vm realm — clone through JSON so
  // deepStrictEqual compares host-realm plain objects.
  const e = fakeEnemy(TC, 'green_slime', 123, 45);
  TC.Enemies.list.push(e);
  TC.Enemies.damageEnemy(e, 500, 1, 0);
  assert.equal(killed.length, 1, 'EntityKilled must fire exactly once');
  assert.equal(bossDown.length, 0, 'regular kill must not fire BossDefeated');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(killed[0])),
    { type: 'green_slime', x: 136, y: 54, boss: false },
    'payload must be {type,x=center,y=center,boss:false}');

  // Hitting the corpse again emits nothing.
  TC.Enemies.damageEnemy(e, 500, 1, 0);
  assert.equal(killed.length, 1, 'dead enemies must not re-emit EntityKilled');

  // Boss kill: one EntityKilled(boss:true) + exactly one BossDefeated.
  const b = TC.Enemies.spawnBoss('king_slime', 300, 200);
  assert.ok(b, 'boss summon failed');
  TC.Enemies.damageEnemy(b, 999999, 1, 0);
  assert.equal(killed.length, 2, 'boss kill must add exactly one EntityKilled');
  assert.equal(bossDown.length, 1, 'BossDefeated must fire exactly once');
  assert.equal(killed[1].type, 'king_slime');
  assert.equal(killed[1].boss, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bossDown[0])), { type: 'king_slime' },
    'BossDefeated payload must carry the defeated type');
});

test('enemies: spawnDirector honors Progression.spawnMultiplier cadence', () => {
  const g = boot();
  const TC = g.TC;
  const origMult = TC.Progression.spawnMultiplier;
  const DT = 0.125;

  // Time the gap between two consecutive spawns: after the first spawn lands
  // (grace-expiry attempt, identical for all multipliers) wipe the list and
  // clock the next appearance RELATIVE to that moment. Cycle length =
  // SPAWN.attemptDay / multiplier, longer only when placement attempts fail.
  function gapBetweenSpawns(mult) {
    TC.Progression.spawnMultiplier = () => mult;
    try {
      TC.Enemies.clear();                        // grace timer back to 2 s
      let t = 0, tFirst = null;
      while (t < 120) {
        TC.Enemies.spawnDirector(DT);
        t += DT;
        if (TC.Enemies.list.length > 0) {
          if (tFirst == null) { tFirst = t; TC.Enemies.list.length = 0; continue; }
          return t - tFirst;
        }
      }
      return Infinity;
    } finally { TC.Enemies.clear(); }
  }

  try {
    const slow = gapBetweenSpawns(1);            // expect a full 5.5 s cycle
    const fast = gapBetweenSpawns(8);            // expect ~0.69 s cycle
    assert.ok(isFinite(slow), 'no enemy spawned at 1x within 120 s sim');
    assert.ok(isFinite(fast), 'no enemy spawned at 8x within 120 s sim');
    assert.ok(slow >= TC.CONST.SPAWN.attemptDay - DT,
      '1x gap shorter than attemptDay ' + TC.CONST.SPAWN.attemptDay + ': ' + slow);
    assert.ok(fast <= (TC.CONST.SPAWN.attemptDay / 8) * 2 + DT,
      '8x gap needed more than two cycles: ' + fast);
    assert.ok(slow > fast * 2.5,
      'spawnMultiplier had no measurable effect: slow=' + slow + ' fast=' + fast);
  } finally { TC.Progression.spawnMultiplier = origMult; }
});

test('enemies: spawnDirector honors Biomes.getSpawnOverride table', () => {
  const g = boot();
  const TC = g.TC;
  const origGet = TC.Biomes.getSpawnOverride;
  TC.Biomes.getSpawnOverride = () => [['ice_slime', 1]];   // becomes the BASE day table
  try {
    TC.Enemies.clear();
    const DT = 0.25;
    let t = 0, found = null;
    while (t < 90 && !found) {
      TC.Enemies.spawnDirector(DT);
      t += DT;
      for (const e of TC.Enemies.list) {
        if (e.type === 'ice_slime') { found = e; break; }
      }
      if (!found) TC.Enemies.list.length = 0;  // keep the cap from blocking re-rolls
    }
    assert.ok(TC.ENEMY_DEFS.ice_slime, 'sanity: ice_slime def exists');
    assert.ok(found, 'stubbed override table never produced ice_slime in 90 s sim');
  } finally { TC.Biomes.getSpawnOverride = origGet; }
});

test('enemies: MAX_ENEMIES cap holds under a hot director', () => {
  const g = boot();
  const TC = g.TC;
  const cap = TC.CONST.MAX_ENEMIES;
  TC.Enemies.clear();
  for (let i = 0; i < cap; i++) {
    TC.Enemies.list.push(fakeEnemy(TC, 'green_slime', 100 + i * 30, 100));
  }
  // 60 s of director ticks must neither grow nor shrink a full list.
  for (let k = 0; k < 240; k++) TC.Enemies.spawnDirector(0.25);
  assert.equal(TC.Enemies.list.length, cap, 'population must never exceed MAX_ENEMIES');

  // Freeing one slot reopens the valve within a few cycles.
  TC.Enemies.list.pop();
  let refilled = false;
  for (let k = 0; k < 240 && !refilled; k++) {
    TC.Enemies.spawnDirector(0.25);
    refilled = TC.Enemies.list.length === cap;
  }
  assert.ok(refilled, 'director stopped spawning although below the cap');
});

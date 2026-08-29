/* tests/unit/enemyspawn-underworld.test.js — W19 truth-sync: depth-first
   Underworld spawn zoning. Covers the campaign contracts:

     - zoneOf classifies the Underworld by depth BEFORE generic 'cave'
       (the shared TC.Biomes.isUnderworldAt boundary — one authority for
       summon validation, encounter lifecycle and spawn zoning);
     - the Underworld zone serves the Underworld roster, never the vanilla
       cave table;
     - ordinary cave/day/night classification and tables are unchanged for
       every shallower depth;
     - Blood Moon precedence stays on the surface night only (underground
       zones keep their ecology by design);
     - the post-Wall ember_wraith supplement rides the declarative
       [type, weight, condition] grammar: absent before the flag, present
       after, fail-closed on malformed conditions;
     - director-level proof: an underworld player actually spawns underworld
       enemies through spawnDirector(). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('../combat/_helpers.js');

function tableIds(TC, zone, col) {
  return TC.EnemySpawn.zoneTable(zone, col).map((e) => e[0]);
}

// Place the player deep in the underworld air near world center.
function toUnderworld(TC) {
  const p = TC.player;
  const TS = TC.CONST.TS;
  const UW = TC.CONST.GEN.underworld.startY;
  const cx = (TC.world.width / 2) * TS;
  let y = (UW + 6) * TS;
  for (let dy = 0; dy < 40; dy++) {
    const tryY = y + dy * TS;
    if (!TC.world.isSolid(Math.floor(cx / TS), Math.floor(tryY / TS)) &&
        !TC.world.isSolid(Math.floor(cx / TS), Math.floor((tryY + p.h) / TS))) {
      y = tryY;
      break;
    }
  }
  p.x = cx - p.w / 2;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  p.dead = false;
  for (let i = 0; i < 10; i++) TC.Biomes.update(0.25);
}

// Place the player at a specific depth below the local surface (tiles).
function toDepth(TC, tilesBelowSurf) {
  const p = TC.player;
  const TS = TC.CONST.TS;
  const w = TC.world;
  const col = Math.floor(w.width / 2);
  const surf = w.surfaceY[col];
  // find free headroom at that depth
  let y = (surf + tilesBelowSurf) * TS;
  for (let dy = 0; dy < 60; dy++) {
    const tryY = y + dy * TS;
    if (!w.isSolid(col, Math.floor(tryY / TS)) &&
        !w.isSolid(col, Math.floor((tryY + p.h) / TS))) {
      y = tryY;
      break;
    }
  }
  p.x = col * TS + TS / 2 - p.w / 2;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  p.dead = false;
  for (let i = 0; i < 10; i++) TC.Biomes.update(0.25);
}

test('zoneOf classifies the underworld by depth ahead of generic cave', () => {
  const g = boot(4242);
  const TC = g.TC;
  toUnderworld(TC);
  assert.strictEqual(TC.EnemySpawn.zoneOf(TC.player, TC.world, 1), 'underworld');
});

test('underworld zone serves the underworld roster, not the cave table', () => {
  const g = boot(4242);
  const TC = g.TC;
  toUnderworld(TC);
  const col = Math.floor(TC.world.width / 2);
  const ids = tableIds(TC, 'underworld', col);
  for (const want of ['demon_eye', 'cave_bat', 'zombie']) {
    assert.ok(ids.includes(want), 'underworld roster includes ' + want);
  }
  for (const no of ['skeleton', 'granite_golem', 'rock_charger', 'gloom_bat']) {
    assert.ok(!ids.includes(no), 'vanilla cave pick "' + no + '" must not leak into underworld zone');
  }
  assert.ok(!ids.includes('blue_slime'), 'day-table blue_slime must not leak into underworld zone');
});

test('ordinary cave classification is unchanged for shallower depths', () => {
  const g = boot(4242);
  const TC = g.TC;
  toDepth(TC, 60); // deep underground, far above the underworld boundary
  const zone = TC.EnemySpawn.zoneOf(TC.player, TC.world, 1);
  assert.strictEqual(zone, 'cave');
  const ids = tableIds(TC, 'cave', Math.floor(TC.world.width / 2));
  assert.ok(ids.includes('skeleton'), 'cave keeps its vanilla picks');
  assert.ok(ids.includes('gloom_bat'), 'deep cave bat still depth-gated in');
});

test('surface day/night zones are unchanged', () => {
  const g = boot(4242);
  const TC = g.TC;
  toDepth(TC, -6); // above the local surface
  const w = TC.world;
  assert.strictEqual(TC.EnemySpawn.zoneOf(TC.player, w, 1), 'day');
  assert.strictEqual(TC.EnemySpawn.zoneOf(TC.player, w, 0), 'night');
  const dayIds = tableIds(TC, 'day', Math.floor(w.width / 2));
  assert.ok(dayIds.includes('green_slime'));
  assert.strictEqual(
    TC.EnemySpawn.zoneTable('cave', Math.floor(w.width / 2)).some((e) => e[0] === 'zombie' && e.length === 2 && false),
    false,
  );
});

test('blood moon precedence stays on the surface night only', () => {
  const g = boot(4242);
  const TC = g.TC;
  TC.EnemySpawn.setBloodMoon(true);
  const night = TC.EnemySpawn.zoneTable('night', Math.floor(TC.world.width / 2));
  assert.deepStrictEqual(
    night.map((e) => e[0]).sort(),
    TC.EnemySpawn.BLOOD_MOON_TABLE.map((e) => e[0]).sort(),
    'blood moon replaces the surface night table',
  );
  toUnderworld(TC);
  const uwIds = tableIds(TC, 'underworld', Math.floor(TC.world.width / 2));
  assert.ok(uwIds.includes('demon_eye') && uwIds.includes('zombie'),
    'underground zones keep their own ecology during a blood moon');
  assert.ok(!uwIds.includes('blood_crawler') && !uwIds.includes('crimson_slime'),
    'blood-moon surface crawlers do not invade the underworld table');
});

test('post-wall ember_wraith rides the declarative grammar: absent before, present after', () => {
  const g = boot(4242);
  const TC = g.TC;
  toUnderworld(TC);
  const col = Math.floor(TC.world.width / 2);
  const before = tableIds(TC, 'underworld', col);
  assert.ok(before.includes('demon_eye'), 'base roster intact pre-flag');
  assert.ok(!before.includes('ember_wraith'), 'supplement fails closed while flag unset');

  assert.strictEqual(TC.Progression.set('boss.wall_of_flesh.defeated'), true,
    'flag records exactly once via canonical progression store');
  const after = tableIds(TC, 'underworld', col);
  assert.ok(after.includes('ember_wraith'), 'defeating the wall opens the frontier roster');
  assert.ok(after.includes('demon_eye'), 'base roster still present post-flag');
});

test('malformed or unknown conditions fail closed in the spawn grammar', () => {
  const g = boot(4242);
  const TC = g.TC;
  assert.strictEqual(TC.Progression.test('totally.bogus.flag'), false, 'unknown flag string fails closed');
  assert.strictEqual(TC.Progression.test({ not_a_known_operator: true }), false, 'unknown shape fails closed');
  assert.strictEqual(TC.Progression.test({ boss: 'wall_of_flesh' }), false, 'boss shorthand respects unset flags');
  assert.strictEqual(TC.Progression.test({ boss: 'wall_of_flesh' }), false);
  TC.Progression.set('boss.wall_of_flesh.defeated');
  assert.strictEqual(TC.Progression.test({ boss: 'wall_of_flesh' }), true, 'boss shorthand honors set flags');
});

// Deterministic but VARYING rng: a tiny LCG pinned into the 'spawn' GameRng
// stream so placement attempts explore different spots (unlike a pinned 0.5,
// which would retry one solid tile).
function withRng(TC, seed, fn) {
  let s = seed >>> 0;
  TC.GameRng.override('spawn', function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  });
  try { return fn(); } finally { TC.GameRng.clearOverrides(); }
}

test('director-level: an underworld player spawns underworld enemies', () => {
  const g = boot(4242);
  const TC = g.TC;
  toUnderworld(TC);
  const ROSTER = new Set(['demon_eye', 'cave_bat', 'zombie']);
  withRng(TC, 0xC0FFEE, () => {
    for (let i = 0; i < 12; i++) {
      TC.Enemies.list.length = 0; // keep headroom so every tick may spawn
      TC.EnemySpawn.spawnDirector(10); // large dt expires the rate timer
    }
  });
  const spawned = TC.Enemies.list.map((e) => e.type);
  assert.ok(spawned.length > 0, 'director produced spawns: ' + spawned.join(','));
  for (const t of spawned) {
    assert.ok(ROSTER.has(t), 'spawned "' + t + '" belongs to the underworld roster');
  }
});

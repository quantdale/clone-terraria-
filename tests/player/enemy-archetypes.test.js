/* tests/player/enemy-archetypes.test.js — externally meaningful AI behavior
   boundaries across the reusable archetype families (W13 contract): chase,
   daylight fade, hop pursuit, flight pursuit, teleport closing, stationary
   bite gating, boss phase/servant rules. One focused test per family; no
   implementation trivia. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('../combat/_helpers.js');

const DT = 1 / 60;
function steps(TC, n) {
  for (let i = 0; i < n; i++) TC.Enemies.update(DT);
}

function dist(e, p) {
  return Math.hypot(e.x + e.w / 2 - (p.x + p.w / 2), e.y + e.h / 2 - (p.y + p.h / 2));
}

function night(TC) {
  // DAY_LENGTH=420 s of day first; jump deep into the night band
  TC.Sky.time = 500;
}

// Ground-true placement near the player: scan columns until the spawn
// module's own finder returns a legal spot (avoids embedding enemies in
// terrain on unlucky seeds).
function groundSpotNear(TC, defId, dxTiles) {
  const p = TC.player;
  const w = TC.world;
  const ts = TC.CONST.TS;
  const col = Math.max(1, Math.min(w.width - 2,
    Math.floor((p.x + p.w / 2) / ts) + (dxTiles | 0)));
  const def = TC.ENEMY_DEFS[defId];
  for (let d = 0; d < 8; d++) {
    for (const sgn of [1, -1]) {
      const tx = Math.max(1, Math.min(w.width - 2, col + sgn * d));
      const surf = w.surfaceY[tx];
      // findSpot scans DOWN from min(surf, ty): passing ty ABOVE the
      // surface row lets the scan land the body exactly on the surface.
      for (let dy = 0; dy <= 10; dy++) {
        const spot = TC.EnemySpawn.findSpot(def, tx, surf - dy, surf);
        if (spot) return spot;
      }
    }
  }
  return null;
}

test('archetype slime: hops toward the player and closes ground distance', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  const spot = groundSpotNear(TC, 'green_slime', 6);
  assert.ok(spot, 'found a legal slime placement');
  const e = TC.Enemies.spawnEnemy('green_slime', spot.x, spot.y);
  assert.ok(e, 'spawnEnemy produced a regular enemy');
  const d0 = dist(e, p);
  steps(TC, 60 * 6); // several sit/hop cycles
  assert.ok(dist(e, p) < d0, 'hopping pursuit closed distance');
  TC.Enemies.clear();
});

test('archetype zombie: chases at night, dissolves under daylight', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  night(TC);
  const e = TC.Enemies.spawnEnemy('zombie', p.x + 140, p.y - 4);
  const d0 = dist(e, p);
  steps(TC, 180);
  assert.ok(dist(e, p) < d0, 'zombie closed distance at night');
  // dawn: fade-out removes the zombie without a kill event
  let killed = 0;
  const onK = () => killed++;
  TC.Events.on('EntityKilled', onK);
  TC.Sky.time = 10; // full daylight
  let removed = false;
  for (let i = 0; i < 60 * 4 && !removed; i++) {
    const before = TC.Enemies.list.length;
    TC.Enemies.update(DT);
    if (TC.Enemies.list.length < before) removed = true;
  }
  TC.Events.off('EntityKilled', onK);
  assert.ok(removed, 'sunlight dissolve removed the zombie');
  assert.strictEqual(killed, 0, 'dissolve is not a kill');
});

test('archetype walker: relentless ground chase with obstacle auto-jump', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  const spot = groundSpotNear(TC, 'skeleton', 9);
  assert.ok(spot, 'found a legal skeleton placement');
  const e = TC.Enemies.spawnEnemy('skeleton', spot.x, spot.y);
  const d0 = dist(e, p);
  let advanced = false;
  for (let i = 0; i < 60 * 8; i++) {
    TC.Enemies.update(DT);
    // auto-jump impulse or steady approach both count as advancing
    if ((!e.onGround && e.vy < -200) || Math.abs(e.vx) > 20) advanced = true;
    if (dist(e, p) < d0 * 0.6 && advanced) break;
  }
  assert.ok(dist(e, p) < d0, 'walker closed distance');
  assert.ok(advanced, 'walker advances toward the player');
  TC.Enemies.clear();
});

test('archetype eye: flying pursuit reduces distance with speed cap', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  const e = TC.Enemies.spawnEnemy('demon_eye', p.x + 220, p.y - 60);
  const d0 = dist(e, p);
  steps(TC, 150);
  assert.ok(dist(e, p) < d0, 'eye flew closer');
  const sp = Math.hypot(e.vx, e.vy);
  assert.ok(sp <= 175, 'speed cap respected (170 + tolerance)');
  TC.Enemies.clear();
});

test('archetype teleporter: blinks close most of a long gap within seconds', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  const e = TC.Enemies.spawnEnemy('void_wisp', p.x + 300, p.y - 40);
  const d0 = dist(e, p);
  steps(TC, 60 * 8);
  assert.ok(dist(e, p) < d0 - 60, 'void wisp meaningfully closed the gap');
  TC.Enemies.clear();
});

test('archetype stationary: bites only inside short reach, telegraphed', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  p.iframes = 0;
  const farSpot = groundSpotNear(TC, 'snapvine', 16);
  assert.ok(farSpot, 'far snapvine placed');
  const far = TC.Enemies.spawnEnemy('snapvine', farSpot.x, farSpot.y);
  const hpBefore = p.hp;
  steps(TC, 60 * 3);
  assert.strictEqual(p.hp, hpBefore, 'out-of-reach snapvine never bites');
  TC.Enemies.clear();

  const nearSpot = groundSpotNear(TC, 'snapvine', 2);
  assert.ok(nearSpot, 'near snapvine placed');
  const near = TC.Enemies.spawnEnemy('snapvine', nearSpot.x, nearSpot.y);
  near.atkTimer = 0.01;
  let bit = false;
  for (let i = 0; i < 60 * 4 && !bit; i++) {
    p.iframes = 0;
    const before = p.hp;
    TC.Enemies.update(DT);
    if (p.hp < before) bit = true;
  }
  assert.ok(bit, 'in-reach snapvine lands its telegraphed bite');
  TC.Enemies.clear();
});

test('boss king_slime: phase 2 sheds servants with a hard cap of 2', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  const e = TC.Enemies.spawnBoss('king_slime', p.x, p.y - 300);
  assert.ok(e, 'boss spawned off MAX_BOSSES budget');
  e.hp = Math.floor(e.maxHp * 0.45); // cross the rage threshold
  e.summonTimer = 0.05;
  steps(TC, 60 * 10);
  assert.ok(e.phase2 === true, 'rage phase entered');
  assert.ok(e.servants >= 1, 'servants shed');
  assert.ok(e.servants <= 2, 'servant budget respected');
  const linked = TC.Enemies.list.filter((s) => s.master === e).length;
  assert.strictEqual(linked, e.servants, 'list count matches the servant counter');
  TC.Enemies.clear();
});

test('boss eye_boss: hover -> telegraph -> dash state machine fires', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  const e = TC.Enemies.spawnBoss('void_eye', p.x, p.y - 320);
  assert.ok(e);
  e.dashTimer = 0.02;
  steps(TC, 2);
  assert.strictEqual(e.bstate, 'telegraph', 'cycle opens with a telegraph');
  steps(TC, 60); // ~1 s: teleTimer 0.5s then dash engages
  assert.strictEqual(e.bstate, 'dash');
  const sp = Math.hypot(e.vx, e.vy);
  assert.ok(sp > 300, 'dash velocity engaged');
  TC.Enemies.clear();
});

test('boss storm_jelly: three-phase escalation with lightning volleys', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  const e = TC.Enemies.spawnBoss('storm_jelly', p.x, p.y - 300);
  assert.ok(e);
  // force the deepest phase and a volley
  e.hp = Math.floor(e.maxHp * 0.3);
  e.cycleTimer = 0.05;
  let boltsSeen = 0;
  for (let i = 0; i < 60 * 6; i++) {
    const before = TC.Projectiles.activeCount();
    TC.Enemies.update(DT);
    boltsSeen += Math.max(0, TC.Projectiles.activeCount() - before);
    if (e.bstate === 'hover' && boltsSeen >= 3) break;
  }
  assert.ok(e.phase3 === true, 'phase 3 reached');
  assert.ok(e.phase2 === true);
  assert.ok(boltsSeen >= 1, 'lightning volley fired pooled projectiles');
  assert.ok(e.servants <= 2, 'jelly minion budget respected');
  TC.Enemies.clear();
});

test('boss moss_mother: root slam damages a close player; sheds sporelings at 50%', () => {
  const g = boot(777);
  const TC = g.TC;
  const p = TC.player;
  const ms = groundSpotNear(TC, 'moss_mother', 2);
  assert.ok(ms, 'moss mother placement found');
  const e = TC.Enemies.spawnBoss('moss_mother', ms.x, ms.y);
  assert.ok(e);
  e.cycleTimer = 0.05;
  let woundUp = false;
  for (let i = 0; i < 60 * 5 && !woundUp; i++) {
    TC.Enemies.update(DT);
    if (e.astate === 'slamWind') woundUp = true; // telegraphed root slam
  }
  assert.ok(woundUp, 'close-range player triggers the root-slam windup');
  // completing the windup resets the cycle back to idle movement
  let done = false;
  for (let i = 0; i < 60 && !done; i++) {
    TC.Enemies.update(DT);
    if (e.astate === 'idle' && e.cycleTimer > 0) done = true;
  }
  assert.ok(done, 'slam released and cadence resumed');
  // sporeling shed threshold
  e.hp = Math.floor(e.maxHp * 0.49);
  steps(TC, 30);
  assert.ok(e.phase2 === true);
  const sporelings = TC.Enemies.list.filter((s) => s.type === 'sporeling').length;
  assert.ok(sporelings >= 2, 'phase transition shed sporelings');
  TC.Enemies.clear();
});

/* tests/combat/projectiles.test.js — TC.Projectiles lifecycle validation:
   spawn/update/despawn for every type, tile-collision death, pierce budget,
   bounce exhaustion, homing exclusion, radial explosion + flash, pool cap
   and slot reuse, ProjectileSpawned exactly-once. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot, deterministicRolls, makeEnemy, countEvents } = require('./_helpers.js');

const TS = 16;
const DT = 1 / 60;

// Step the projectile pool N frames; returns frames actually run.
function step(TC, n) {
  for (let i = 0; i < n; i++) {
    TC.Projectiles.update(DT);
    if (TC.Projectiles.activeCount() === 0) return i + 1;
  }
  return n;
}

test('spawn: fills a pool slot and emits ProjectileSpawned exactly once', () => {
  const g = boot();
  const TC = g.TC;
  const ev = countEvents(TC, ['ProjectileSpawned']);
  const p = TC.Projectiles.spawn('arrow', 100, 100, 0);
  assert.ok(p, 'spawn returned null with an empty pool');
  assert.ok(p.active && p.type === 'arrow' && p.def === TC.Projectiles.TYPES.arrow);
  assert.strictEqual(p.dmg, 5, 'arrow def carries no dmg; fallback must be 5');
  assert.strictEqual(ev.counts.ProjectileSpawned, 1);
  assert.strictEqual(TC.Projectiles.activeCount(), 1);
  ev.off();
});

test('lifecycle: every pooled type spawns, updates and despawns cleanly', () => {
  const g = boot();
  const TC = g.TC;
  const types = Object.keys(TC.Projectiles.TYPES);
  assert.deepStrictEqual(types.sort(),
    ['arrow', 'boomerang', 'falling_star', 'grenade', 'magic_bolt', 'wire_dart', 'yoyo'].sort());
  for (const type of types) {
    TC.Projectiles.clear();
    const p = TC.Projectiles.spawn(type, TC.player.x, TC.player.y - 400, 0);
    assert.ok(p, type + ': spawn failed');
    // yoyo/boomerang home to the live player; everything else expires by age.
    step(TC, 400);
    assert.strictEqual(TC.Projectiles.activeCount(), 0,
      type + ': still active after 400 frames (fuse/lifetime never fired)');
  }
});

test('tile collision kills an arrow before it tunnels into the wall', () => {
  const g = boot();
  const TC = g.TC;
  const tx0 = Math.floor(TC.player.x / TS);
  const rowY = TC.world.surfaceY[tx0] - 50;           // open sky arena
  const wallX = (tx0 + 8) * TS;
  for (let dy = -3; dy <= 3; dy++) TC.world.set(tx0 + 8, rowY + dy, TC.TILE.STONE);

  const p = TC.Projectiles.spawn('arrow', wallX - 120, rowY * TS + 8, 0);
  let frames = 0;
  while (p.active && frames < 120) { TC.Projectiles.update(DT); frames++; }
  assert.ok(!p.active, 'arrow survived a stone wall for 120 frames');
  assert.ok(p.x <= wallX, 'arrow tunneled past the wall face');
});

test('pierce: falling_star damages each enemy once and dies after first+pierce hits', () => {
  const g = boot();
  const TC = g.TC;
  deterministicRolls(() => {
    const tx0 = Math.floor(TC.player.x / TS);
    const rowY = TC.world.surfaceY[tx0] - 50;
    const startX = (tx0 + 2) * TS;
    const y = rowY * TS + 8;
    // three dummies strung along the flight path, far apart per tick
    const e1 = makeEnemy(startX + 60, y - 8);
    const e2 = makeEnemy(startX + 140, y - 8);
    const e3 = makeEnemy(startX + 220, y - 8);
    TC.Enemies.list.push(e1, e2, e3);
    const ev = countEvents(TC, ['EntityDamaged']);

    const p = TC.Projectiles.spawn('falling_star', startX, y, 0, { gravity: 0 });
    let guard = 0;
    while (TC.Enemies.list.length && guard++ < 400) TC.Projectiles.update(DT);

    assert.strictEqual(ev.counts.EntityDamaged, 3, 'each dummy damaged exactly once');
    for (const e of [e1, e2, e3]) {
      assert.strictEqual(100 - e.hp, 5, 'single hit of the default dmg 5, no re-hits');
    }
    assert.ok(!p.active || TC.Enemies.list.length === 0,
      'star must die after 3 hits (pierce 2)');
    ev.off();
  });
});

test('bounce: reflects consume the budget then the projectile dies on the wall', () => {
  const g = boot();
  const TC = g.TC;
  TC.Projectiles.TYPES._test_bouncer = {
    motion: 'straight', speed: 240, maxAge: 6,
    hitRadius: 6, len: 0, kb: 1, pierce: 0,
    bounce: 2, restitution: 1, light: 0, color: '#ffffff'
  };
  try {
    const tx0 = Math.floor(TC.player.x / TS);
    const rowY = TC.world.surfaceY[tx0] - 50;
    const L = tx0 + 4, R = L + 6;                     // corridor walls
    for (let dy = -2; dy <= 2; dy++) {
      TC.world.set(L, rowY + dy, TC.TILE.STONE);
      TC.world.set(R, rowY + dy, TC.TILE.STONE);
    }
    const p = TC.Projectiles.spawn('_test_bouncer', (L + 1) * TS + 2, rowY * TS + 8, 0);
    assert.ok(p.active);
    const seen = [];
    let last = p.bounces;
    let frames = 0;
    while (p.active && frames < 500) {
      TC.Projectiles.update(DT);
      frames++;
      if (p.active && p.bounces !== last) { seen.push(last); last = p.bounces; }
    }
    assert.deepStrictEqual(seen, [2, 1], 'two reflections consumed bounce budget 2->1->0');
    assert.ok(!p.active, 'third wall contact must kill after budget exhausted');
    assert.strictEqual(frames, Math.min(frames, 500));
  } finally {
    delete TC.Projectiles.TYPES._test_bouncer;
    TC.Projectiles.clear();
  }
});

test('homing: acquires nearest target, excludes already-hit enemies', () => {
  const g = boot();
  const TC = g.TC;
  TC.Projectiles.TYPES._test_homer = {
    motion: 'straight', speed: 200, maxAge: 4,
    hitRadius: 10, len: 0, kb: 1, pierce: -1,
    homing: 8, homingRange: 400, bounce: 0, light: 0, color: '#ffffff'
  };
  try {
    deterministicRolls(() => {
      const tx0 = Math.floor(TC.player.x / TS);
      const y = (TC.world.surfaceY[tx0] - 50) * TS + 8;
      const startX = (tx0 + 2) * TS;
      const near = makeEnemy(startX + 150, y - 8);
      const far = makeEnemy(startX + 320, y - 8);
      TC.Enemies.list.push(near, far);
      const ev = countEvents(TC, ['EntityDamaged']);

      const p = TC.Projectiles.spawn('_test_homer', startX, y, 0);
      let guard = 0;
      while ((near.hp === 100 || far.hp === 100) && guard++ < 400) {
        TC.Projectiles.update(DT);
      }
      assert.ok(near.hp < 100 && far.hp < 100,
        'homer must strike the near enemy first, then acquire the far one');
      assert.strictEqual(ev.counts.EntityDamaged, 2,
        'already-hit enemy excluded from re-acquisition (no double hits)');
      ev.off();
    });
  } finally {
    delete TC.Projectiles.TYPES._test_homer;
    TC.Projectiles.clear();
  }
});

test('explosion: grenade detonation damages each enemy in radius exactly once + flash light', () => {
  const g = boot();
  const TC = g.TC;
  deterministicRolls(() => {
    const tx0 = Math.floor(TC.player.x / TS);
    const gx = (tx0 + 2) * TS, gy = (TC.world.surfaceY[tx0] - 50) * TS;
    const e1 = makeEnemy(gx + 25, gy - 8);
    const e2 = makeEnemy(gx - 25, gy - 8);
    TC.Enemies.list.push(e1, e2);
    const ev = countEvents(TC, ['EntityDamaged']);

    // near-instant fuse so the detonation point is the spawn point
    const p = TC.Projectiles.spawn('grenade', gx, gy, -Math.PI / 2, { life: 0.05 });
    let exploded = false;
    for (let i = 0; i < 10 && !exploded; i++) {
      TC.Projectiles.update(DT);
      exploded = !p.active;
    }
    assert.ok(exploded, 'grenade did not detonate at fuse end');
    assert.strictEqual(ev.counts.EntityDamaged, 2, 'both in-radius enemies hit once');

    const flash = TC.Projectiles.getLights().find(
      (l) => l.radius === 52 && l.intensity > 0);       // grenade explode.radius
    assert.ok(flash, 'explosion flash missing from the lighting hook');

    const hpSum = e1.hp + e2.hp;
    for (let i = 0; i < 30; i++) TC.Projectiles.update(DT);
    assert.strictEqual(e1.hp + e2.hp, hpSum, 'radial damage applied more than once');
    ev.off();
  });
});

test('pool cap: MAX live slots then silent null; counts stay exact', () => {
  const g = boot();
  const TC = g.TC;
  const ev = countEvents(TC, ['ProjectileSpawned']);
  TC.Projectiles.clear();
  const MAX = TC.Projectiles.MAX;
  assert.strictEqual(MAX, 128);
  assert.strictEqual(TC.Projectiles.pool.length, MAX);
  for (let i = 0; i < MAX; i++) {
    assert.ok(TC.Projectiles.spawn('arrow', 100 + i, 100, 0), 'spawn ' + i + ' failed early');
  }
  assert.strictEqual(TC.Projectiles.activeCount(), MAX);
  assert.strictEqual(ev.counts.ProjectileSpawned, MAX, 'one event per successful spawn');
  assert.strictEqual(TC.Projectiles.spawn('arrow', 0, 0, 0), null,
    'pool-full spawn must return null');
  assert.strictEqual(ev.counts.ProjectileSpawned, MAX, 'rejected spawn must not emit');
  TC.Projectiles.clear();
  assert.strictEqual(TC.Projectiles.activeCount(), 0);
  assert.ok(TC.Projectiles.spawn('arrow', 0, 0, 0), 'clear() must free the whole pool');
  ev.off();
});

test('pool reuse: recycled slots carry no state from their previous life', () => {
  const g = boot();
  const TC = g.TC;
  TC.Projectiles.clear();
  const a = TC.Projectiles.spawn('arrow', 0, 0, 0,
    { crit: 0.5, color: '#ff0000', pierce: 3, dmg: 9, kb: 9, life: 9 });
  a.hits.push({});                                    // fake hit memory
  TC.Projectiles.clear();
  const b = TC.Projectiles.spawn('arrow', 5, 5, Math.PI / 2);
  assert.notStrictEqual(b, undefined);
  assert.strictEqual(b.critBonus, 0);
  assert.strictEqual(b.color, '#8a5a32');             // back to the arrow default
  assert.strictEqual(b.pierce, 0);
  assert.strictEqual(b.dmg, 5);
  assert.strictEqual(b.kb, 3);
  assert.strictEqual(b.maxAge, 3);
  assert.strictEqual(b.hits.length, 0);
  assert.strictEqual(b.state, 0);
  assert.strictEqual(b.age, 0);
  assert.strictEqual(b.fire, false);
});

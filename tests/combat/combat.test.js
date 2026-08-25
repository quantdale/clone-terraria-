/* tests/combat/combat.test.js — TC.Combat exactly-once validation:
   meleeStrike swingId dedup + arc culling, final-damage application through
   Enemies.damageEnemy (defense now lives in the W12 canonical resolver —
   see resolver.test.js for class/defense/crit math), EntityDamaged/Killed/
   BossDefeated emitted once per kill, hurtPlayer defense subtraction vs
   TC.Stats.resolve().defense, fall/void bypass, i-frame rejection. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot, deterministicRolls, makeEnemy, countEvents } = require('./_helpers.js');

function resetPlayer(TC) {
  const p = TC.player;
  p.iframes = 0;
  return p;
}

test('meleeStrike: each enemy hit once per swingId; arc culls enemies behind', () => {
  const g = boot();
  const TC = g.TC;
  deterministicRolls(TC, () => {
    const p = resetPlayer(TC);
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const front = makeEnemy(cx + 18, cy - 8);         // center ~cx+26: inside 34r
    const above = makeEnemy(cx - 8, cy - 38);         // center above: outside arc
    const behind = makeEnemy(cx - 38, cy - 8);        // center ~cx-30: angle PI out
    TC.Enemies.list.push(front, above, behind);
    const ev = countEvents(TC, ['EntityDamaged']);

    let hits = TC.Combat.meleeStrike(cx, cy, 34, -55 * Math.PI / 180, 55 * Math.PI / 180,
      10, 3, 5001);
    assert.strictEqual(hits, 1, 'only the front dummy is inside the arc');
    assert.strictEqual(ev.counts.EntityDamaged, 1);

    hits = TC.Combat.meleeStrike(cx, cy, 34, -55 * Math.PI / 180, 55 * Math.PI / 180,
      10, 3, 5001);
    assert.strictEqual(hits, 0, 'same swingId must not re-hit');
    assert.strictEqual(ev.counts.EntityDamaged, 1);

    hits = TC.Combat.meleeStrike(cx, cy, 34, -55 * Math.PI / 180, 55 * Math.PI / 180,
      10, 3, 5002);
    assert.strictEqual(hits, 1, 'fresh swingId strikes again');
    assert.strictEqual(ev.counts.EntityDamaged, 2);
    assert.strictEqual(front.hp, 80, 'front dummy took exactly two hits of 10');
    assert.strictEqual(above.hp + behind.hp, 200, 'out-of-arc dummies untouched');
    ev.off();
  });
});

test('damageEnemy: applies FINAL damage exactly once, min 1 floor (W12 contract)', () => {
  const g = boot();
  const TC = g.TC;
  const e = makeEnemy(0, 0, { defense: 7 });   // defense is a RESOLVER concern;
  TC.Enemies.list.push(e);                     // application must not re-apply it
  const ev = countEvents(TC, ['EntityDamaged']);
  assert.strictEqual(TC.Enemies.damageEnemy(e, 20, 1, 0, false), 20,
    'final damage passes through unmodified (no hidden defense)');
  assert.strictEqual(e.hp, 80);
  assert.strictEqual(ev.counts.EntityDamaged, 1);
  // min-1 floor stays an invariant of the application site
  TC.Enemies.damageEnemy(e, 0.2, 1, 0, false);
  assert.strictEqual(e.hp, 79, 'fractional/zero rounds up to at least 1');
  // dead enemies are rejected outright (death occurs exactly once)
  e.hp = 0;
  ev.off();
  assert.strictEqual(TC.Enemies.damageEnemy(e, 50, 1, 0, false), 0);
});

test('kill events: EntityKilled + BossDefeated emitted exactly once per boss kill', () => {
  const g = boot();
  const TC = g.TC;
  deterministicRolls(TC, () => {
    const boss = makeEnemy(0, 0,
      { name: 'Test Boss', ai: 'eye_boss', boss: true, hp: 30 }, { hp: 30 });
    TC.Enemies.list.push(boss);
    const ev = countEvents(TC, ['EntityDamaged', 'EntityKilled', 'BossDefeated']);
    TC.Enemies.damageEnemy(boss, 999, 1, 0, false);
    assert.strictEqual(ev.counts.EntityDamaged, 1);
    assert.strictEqual(ev.counts.EntityKilled, 1);
    assert.strictEqual(ev.counts.BossDefeated, 1);
    assert.ok(!TC.Enemies.list.includes(boss), 'dead boss removed from the list');
    ev.off();
  });
});

test('hurtPlayer: defense subtraction equals Stats.resolve().defense', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  p.accessories = [{ id: 'guard_ring', prefix: null }, null, null, null, null];
  const D = TC.Stats.resolve(p).defense;
  assert.strictEqual(D, 2, 'guard_ring adds flat 2 defense');

  deterministicRolls(TC, () => {
    const res = TC.Combat.hurtPlayer(50, 0, 0, 'test_slime');
    assert.strictEqual(res.finalDamage, 50 - D);
    assert.strictEqual(res.defenseApplied, D);
    assert.strictEqual(res.crit, false);
    // intake floor: even huge defense leaves 1 damage
    p.iframes = 0;
    const res2 = TC.Combat.hurtPlayer(2, 0, 0, 'test_slime');
    assert.strictEqual(res2.finalDamage, 1);
    assert.strictEqual(res2.defenseApplied, 1);
  });
});

test('hurtPlayer: fall and void bypass defense entirely', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  p.accessories = [{ id: 'guard_ring', prefix: null }, null, null, null, null];
  deterministicRolls(TC, () => {
    for (const src of ['fall', 'void']) {
      p.iframes = 0;
      const res = TC.Combat.hurtPlayer(30, 0, 0, src);
      assert.strictEqual(res.finalDamage, 30, src + ' must not lose defense');
      assert.strictEqual(res.defenseApplied, 0, src + ' must report zero defense applied');
      assert.strictEqual(res.crit, false);
    }
  });
});

test('meleeStrike: crit threshold equals st.critChance exactly (no base double-add)', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  // 'lucky' prefix: +0.03 critChance -> snapshot 0.08 base + 0.03 = 0.11
  p.accessories = [{ id: 'guard_ring', prefix: 'lucky' }, null, null, null, null];
  const stCrit = TC.Stats.resolve(p).critChance;
  assert.strictEqual(stCrit, 0.11);
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  const dummy = makeEnemy(cx + 18, cy - 8);
  TC.Enemies.list.push(dummy);

  const strikeAt = (rand) => {
    dummy.hp = 100;
    dummy.lastHitSwing = 0;
    TC.GameRng.override('combat', () => rand); // variance factor 1; roll == rand
    try {
      TC.Combat.meleeStrike(cx, cy, 34, -1, 1, 10, 0, 7001);
    } finally {
      TC.GameRng.clearOverrides();
    }
    return 100 - dummy.hp;                  // 10 = normal, 20 = crit
  };

  // Variance runs before the crit double: dmg = round(10*(0.88+rand*0.24)),
  // then x2 on crit -> rand 0.11: round(9.064)=9 no-crit / 18 crit.
  assert.strictEqual(strikeAt(0.11), 9,
    'roll == st.critChance must NOT crit (base must not be added twice)');
  assert.strictEqual(strikeAt(0.109), 18, 'roll just below st.critChance must crit');
  assert.strictEqual(strikeAt(0.15), 9,
    'roll in the [st.critChance, base+contribs) gap must NOT crit');
});

// REGRESSION — defense applied exactly once, end to end.
// Root cause (fixed): Combat.hurtPlayer applied defense (contract owner per
// AGENTS.md) and Player.damage() subtracted totalDefense() AGAIN for every
// source — including fall/void, which must bypass defense. player.js damage()
// no longer touches defense; hurtPlayer owns it.
test('REGRESSION: end-to-end hp loss equals hurtPlayer finalDamage (defense applied once)', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  p.accessories = [{ id: 'guard_ring', prefix: null }, null, null, null, null];
  deterministicRolls(TC, () => {
    const hpBefore = p.hp;
    const res = TC.Combat.hurtPlayer(50, 0, 0, 'test_slime');
    assert.strictEqual(hpBefore - p.hp, res.finalDamage,
      'player should lose exactly the returned finalDamage (48), not more');
    p.iframes = 0;
    const hpFall = p.hp;
    TC.Combat.hurtPlayer(30, 0, 0, 'fall');
    assert.strictEqual(hpFall - p.hp, 30, 'fall must bypass defense end-to-end too');
  });
});

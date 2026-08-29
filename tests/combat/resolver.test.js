/* tests/combat/resolver.test.js — TC.Combat.resolveHit contract (W12).
   Class scaling, deterministic crit/non-crit via injected rng, defense,
   min-damage floor, penetration, knockback, i-frame rejection, environmental
   bypass, status application, target mitigation policies, exact-once
   events/death, and rng determinism. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot, deterministicRolls, makeEnemy, countEvents } = require('./_helpers.js');

// Deterministic rng factory: always returns `v` (and counts calls).
function fixedRng(v) {
  let n = 0;
  const fn = () => { n++; return v; };
  fn.calls = () => n;
  return fn;
}

// Seeded LCG for reproducible multi-roll sequences.
function seqRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1103515245 * s + 12345) >>> 0;
    return s / 4294967296;
  };
}

function resetPlayer(TC) {
  const p = TC.player;
  p.iframes = 0;
  return p;
}

test('resolveHit: melee class scales through st.meleeDamage exactly', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  const rng = fixedRng(0.5);
  const base = TC.Combat.resolveHit({ base: 10, cls: 'melee', attacker: p, target: null, rng });
  assert.strictEqual(base.damage, 10);

  const unsub = TC.Stats.registerSource('test.meleemul', 500,
    (player, out) => { out.meleeDamage *= 1.5; });
  try {
    const scaled = TC.Combat.resolveHit({ base: 10, cls: 'melee', attacker: p, target: null, rng });
    assert.strictEqual(scaled.damage, 15, '10 * 1.5 melee multiplier');
    // other classes unaffected by the melee contributor
    const mag = TC.Combat.resolveHit({ base: 10, cls: 'magic', attacker: p, target: null, rng });
    assert.strictEqual(mag.damage, 10);
  } finally { unsub(); }
});

test('resolveHit: ranged and magic scale through their own stat fields', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  const unsub = TC.Stats.registerSource('test.rangemul', 500, (pl, out) => { out.rangedDamage *= 2; });
  try {
    // rng 0.5 => variance factor exactly 1, no crit
    assert.strictEqual(
      TC.Combat.resolveHit({ base: 8, cls: 'ranged', attacker: p, target: null, rng: fixedRng(0.5) }).damage, 16);
    // magic NOT affected by the ranged source
    assert.strictEqual(
      TC.Combat.resolveHit({ base: 8, cls: 'magic', attacker: p, target: null, rng: fixedRng(0.5) }).damage, 8);
  } finally { unsub(); }
});

test('resolveHit: non-player attackers never inherit player stats or crit', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  const unsub = TC.Stats.registerSource('test.huge', 500, (pl, out) => {
    out.meleeDamage *= 10; out.rangedDamage *= 10; out.magicDamage *= 10; out.critChance = 0.99;
  });
  try {
    for (const cls of ['generic', 'melee', 'ranged', 'magic']) {
      const res = TC.Combat.resolveHit({ base: 12, cls, attacker: {}, target: null, rng: fixedRng(0.5) });
      assert.strictEqual(res.damage, 12, cls + ' boss/world damage stays at base');
      assert.strictEqual(res.crit, false, cls + ' non-player hits never crit');
    }
  } finally { unsub(); }
});

test('resolveHit: deterministic crit at the injected threshold; non-crit above', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  const chance = TC.Stats.resolve(p).critChance;      // 0.08 baseline
  const below = TC.Combat.resolveHit({
    base: 10, cls: 'generic', attacker: p, target: null,
    rng: fixedRng(chance - 1e-9), noVariance: true,
  });
  assert.strictEqual(below.crit, true);
  assert.strictEqual(below.damage, 20, 'default critMul doubles');
  const above = TC.Combat.resolveHit({
    base: 10, cls: 'generic', attacker: p, target: null,
    rng: fixedRng(chance), noVariance: true,
  });
  assert.strictEqual(above.crit, false);
  assert.strictEqual(above.damage, 10);
  // custom multiplier + bonus
  const custom = TC.Combat.resolveHit({
    base: 10, cls: 'generic', attacker: p, target: null,
    rng: fixedRng(0.05), noVariance: true, critBonus: 0.1, critMul: 3,
  });
  assert.strictEqual(custom.crit, true);
  assert.strictEqual(custom.damage, 30);
});

test('resolveHit: variance consumes the first rng draw, crit the second', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  const rng = fixedRng(0.5);
  TC.Combat.resolveHit({ base: 10, cls: 'generic', attacker: p, target: null, rng });
  assert.ok(rng.calls() >= 2, 'variance + crit draws');
  // seeded sequences are reproducible
  const spec = () => ({ base: 33, cls: 'ranged', attacker: TC.player, target: null, rng: seqRng(12345) });
  assert.deepStrictEqual(TC.Combat.resolveHit(spec()), TC.Combat.resolveHit(spec()));
});

test('resolveHit: enemy defense subtracted exactly once; huge defense floors at 1', () => {
  const g = boot();
  const TC = g.TC;
  const e = makeEnemy(0, 0, { defense: 7 });
  const res = TC.Combat.resolveHit({ base: 20, cls: 'melee', attacker: TC.player, target: e, rng: fixedRng(0.5) });
  assert.strictEqual(res.damage, 13);
  assert.strictEqual(res.defenseApplied, 7);
  const tank = makeEnemy(0, 0, { defense: 500 });
  const res2 = TC.Combat.resolveHit({ base: 3, cls: 'melee', attacker: TC.player, target: tank, rng: fixedRng(0.5) });
  assert.strictEqual(res2.damage, 1, 'minimum damage');
  assert.strictEqual(res2.defenseApplied, 2, 'wasted defense beyond the floor is not reported');
});

test('resolveHit: explicit defense override and penetration', () => {
  const g = boot();
  const TC = g.TC;
  const e = makeEnemy(0, 0, { defense: 7 });
  const res = TC.Combat.resolveHit({
    base: 20, cls: 'melee', attacker: TC.player, target: e,
    pen: 5, rng: fixedRng(0.5),
  });
  assert.strictEqual(res.damage, 18, 'effective defense 7-5=2');
  assert.strictEqual(res.defenseApplied, 2);
  const over = TC.Combat.resolveHit({
    base: 20, cls: 'melee', attacker: TC.player, target: e,
    pen: 50, rng: fixedRng(0.5),
  });
  assert.strictEqual(over.damage, 20, 'pen beyond defense pierces fully');
  assert.strictEqual(over.defenseApplied, 0);
  const override = TC.Combat.resolveHit({
    base: 20, cls: 'melee', attacker: TC.player, target: e,
    defense: 4, rng: fixedRng(0.5),
  });
  assert.strictEqual(override.damage, 16, 'explicit spec.defense wins over target def');
});

test('resolveHit: knockback and mult echo onto the result', () => {
  const g = boot();
  const TC = g.TC;
  const res = TC.Combat.resolveHit({
    base: 10, cls: 'melee', attacker: TC.player, target: null,
    kb: 4.5, mult: 0.5, rng: fixedRng(0.5), noVariance: false,
  });
  assert.strictEqual(res.kb, 4.5);
  assert.strictEqual(res.damage, 5);
});

test('hitEnemy: applies resolved damage + kb + crit to a real enemy once', () => {
  const g = boot();
  const TC = g.TC;
  const e = makeEnemy(0, 0, { defense: 0, kbResist: 1 });
  TC.Enemies.list.push(e);
  const ev = countEvents(TC, ['EntityDamaged']);
  const res = TC.Combat.hitEnemy(e, 1, {
    base: 15, cls: 'ranged', attacker: TC.player, target: e,
    kb: 3, rng: fixedRng(0.5),
  });
  assert.ok(res && res.ok);
  assert.strictEqual(e.hp, 85);
  assert.strictEqual(ev.counts.EntityDamaged, 1, 'exactly one EntityDamaged');
  ev.off();
});

test('hitEnemy: lethal hit emits EntityKilled/BossDefeated exactly once; corpse rejects more', () => {
  const g = boot();
  const TC = g.TC;
  const boss = makeEnemy(0, 0, { name: 'Test Boss', ai: 'eye_boss', boss: true, hp: 30 }, { hp: 30 });
  TC.Enemies.list.push(boss);
  const ev = countEvents(TC, ['EntityDamaged', 'EntityKilled', 'BossDefeated']);
  const res = TC.Combat.hitEnemy(boss, 1, {
    base: 999, cls: 'melee', attacker: TC.player, target: boss, kb: 0, rng: fixedRng(0.5),
  });
  assert.ok(res && res.ok);
  assert.strictEqual(ev.counts.EntityDamaged, 1);
  assert.strictEqual(ev.counts.EntityKilled, 1);
  assert.strictEqual(ev.counts.BossDefeated, 1);
  assert.ok(!TC.Enemies.list.includes(boss));
  const again = TC.Combat.hitEnemy(boss, 1, {
    base: 999, cls: 'melee', attacker: TC.player, target: boss, kb: 0, rng: fixedRng(0.5),
  });
  assert.strictEqual(ev.counts.EntityKilled, 1, 'death occurs exactly once');
  assert.ok(again === null || again.ok === false || ev.counts.EntityDamaged === 1);
  ev.off();
});

test('resolveHit: registered target mitigation policy applies (skeletron pattern)', () => {
  const g = boot();
  const TC = g.TC;
  const e = makeEnemy(0, 0, { ai: 'test_shielded', defense: 0 });
  TC.Combat.registerMitigation('test_shielded', (t) => (t.shieldUp ? 0.25 : 1));
  e.shieldUp = true;
  const shielded = TC.Combat.resolveHit({ base: 40, cls: 'melee', attacker: TC.player, target: e, rng: fixedRng(0.5) });
  assert.strictEqual(shielded.damage, 10, 'mitigation multiplies before defense/rounding');
  assert.strictEqual(shielded.mitigated, 0.25);
  e.shieldUp = false;
  const exposed = TC.Combat.resolveHit({ base: 40, cls: 'melee', attacker: TC.player, target: e, rng: fixedRng(0.5) });
  assert.strictEqual(exposed.damage, 40);
  assert.strictEqual(exposed.mitigated, null);
});

test('hurtPlayer: i-frames and death reject intake without touching hp', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  const hpBefore = p.hp;
  p.iframes = 0.5;
  const res = TC.Combat.hurtPlayer(30, 0, 0, 'test_slime');
  assert.strictEqual(res.rejected, 'iframes');
  assert.strictEqual(p.hp, hpBefore, 'no hp change during iframes');
  p.iframes = 0;
  p.dead = true;
  const res2 = TC.Combat.hurtPlayer(30, 0, 0, 'test_slime');
  assert.strictEqual(res2.rejected, 'iframes');
  assert.strictEqual(p.hp, hpBefore);
  p.dead = false;
});

test('hurtPlayer: lava inflicts the Burning status declared by BUFF_DEFS.fromSource', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  const st = TC.Buffs.statusForSource('lava');
  assert.ok(st, 'accessories owns the source->status mapping');
  assert.strictEqual(st.id, 'burning');
  assert.strictEqual(st.dur, 4);
  TC.Buffs.clear();
  deterministicRolls(TC, () => {
    const res = TC.Combat.hurtPlayer(10, 0, 0, 'lava');
    assert.ok(res && !res.rejected);
  });
  assert.ok(TC.Buffs.has('burning'), 'burning applied through the policy table');
  assert.strictEqual(TC.Buffs.list[0].time, 4);
  TC.Buffs.clear();
  // ordinary defended intake does not inflict statuses
  deterministicRolls(TC, () => {
    const res2 = TC.Combat.hurtPlayer(10, 0, 0, 'test_slime');
    assert.ok(!TC.Buffs.has('burning'));
    assert.ok(res2.finalDamage >= 1);
  });
  assert.ok(!TC.Buffs.has('burning'));
  TC.Buffs.clear();
});

test('hurtPlayer: fall and void bypass defense through the resolver policy', () => {
  const g = boot();
  const TC = g.TC;
  const p = resetPlayer(TC);
  p.accessories = [{ id: 'guard_ring', prefix: null }, null, null, null, null];
  deterministicRolls(TC, () => {
    for (const src of TC.Combat.ENVIRONMENTAL_SOURCES) {
      p.iframes = 0;
      const res = TC.Combat.hurtPlayer(30, 0, 0, src);
      assert.strictEqual(res.finalDamage, 30, src + ' bypasses defense');
      assert.strictEqual(res.defenseApplied, 0);
    }
  });
});

test('resolveHit: invalid specs fail closed with ok:false', () => {
  const g = boot();
  const TC = g.TC;
  for (const bad of [null, {}, { base: 0 }, { base: -5 }, { base: NaN }, { base: 'x' }]) {
    const res = TC.Combat.resolveHit(bad);
    assert.strictEqual(res.ok, false, JSON.stringify(bad) + ' rejected');
    assert.strictEqual(res.damage, 0);
  }
  // unknown classes fall back to generic rather than failing
  const odd = TC.Combat.resolveHit({ base: 10, cls: 'psychic', attacker: TC.player, target: null, rng: fixedRng(0.5) });
  assert.strictEqual(odd.ok, true);
  assert.strictEqual(odd.cls, 'generic');
});

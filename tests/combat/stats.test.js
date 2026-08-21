/* tests/combat/stats.test.js — TC.Stats double-application audit:
   resolve() cache purity, accessory defense exact, buff mods exact,
   life-crystal bonus counted exactly once (no accessories-path duplicate),
   player.totalDefense() parity with the resolved snapshot. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./_helpers.js');

function ringOnly(TC) {
  const p = TC.player;
  p.accessories = [{ id: 'guard_ring', prefix: null }, null, null, null, null];
  return p;
}

test('resolve: two calls return the identical frozen snapshot (cache purity)', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  const a = TC.Stats.resolve(p);
  const b = TC.Stats.resolve(p);
  assert.strictEqual(a, b, 'repeat resolve must serve the same frozen snapshot');
  assert.deepStrictEqual(a, b);
  assert.ok(Object.isFrozen(a));
});

test('accessory: equipping guard_ring raises defense by exactly its flat value', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  const d0 = TC.Stats.resolve(p).defense;
  ringOnly(TC);
  const st = TC.Stats.resolve(p);
  assert.strictEqual(st.defense, d0 + 2, 'guard_ring is +2 defense');
  // prefix rides the same slot: guarded adds exactly +1 more
  p.accessories[0].prefix = 'guarded';
  assert.strictEqual(TC.Stats.resolve(p).defense, d0 + 3);
});

test('buffs: ironskin adds exactly its mods; expiry restores the baseline', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  TC.Accessories.update(1 / 60);          // establish buff session ownership
  const d0 = TC.Stats.resolve(p).defense;
  const s0 = TC.Stats.resolve(p).moveSpeed;

  assert.ok(TC.Buffs.apply('ironskin', 30));
  assert.strictEqual(TC.Stats.resolve(p).defense, d0 + 8, 'ironskin is +8 defense');
  assert.ok(TC.Buffs.apply('swiftness', 30));
  const st = TC.Stats.resolve(p);
  assert.strictEqual(st.moveSpeed, s0 * 1.25, 'swiftness is a x1.25 moveSpeed mult');
  assert.strictEqual(st.defense, d0 + 8);

  TC.Buffs.clear();
  const after = TC.Stats.resolve(p);
  assert.strictEqual(after.defense, d0);
  assert.strictEqual(after.moveSpeed, s0);
});

test('life crystals: maxHealth bonus counted exactly once through Stats only', () => {
  const g = boot();
  const TC = g.TC;
  const p = ringOnly(TC);                 // accessory equipped at the same time
  const baseMaxHp = TC.CONST.PLAYER_HP;
  assert.strictEqual(TC.Stats.resolve(p).maxHealth, baseMaxHp,
    'no crystals: base maxHealth');

  p.lifeCrystals = 3;
  const st = TC.Stats.resolve(p);
  assert.strictEqual(st.maxHealth, baseMaxHp + 60,
    '+20 per crystal (min(n,15)*20), applied by progress.lifeCrystals alone');

  // The accessories path must NOT also fold crystalBonus in anywhere.
  const m = TC.Accessories.modsOf(p);
  assert.strictEqual(m.maxHp, 0, 'Accessories.modsOf must not add crystal HP');
  assert.strictEqual(TC.Accessories.modsOf.__lootWrap, undefined,
    'legacy loot wrap on modsOf is gone; stats.js relies on it being absent');
  assert.strictEqual(TC.Loot.crystalBonus(p), 60,
    'Loot.crystalBonus mirrors the same single source of truth');
});

test('totalDefense parity with Stats.resolve().defense across gear states', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  TC.Accessories.update(1 / 60);
  const cases = [
    () => { p.accessories = null; },
    () => ringOnly(TC),
    () => { p.accessories[0].prefix = 'guarded'; },
    () => { TC.Buffs.clear(); TC.Buffs.apply('ironskin', 20); }
  ];
  for (const setup of cases) {
    setup();
    assert.strictEqual(p.totalDefense(), TC.Stats.resolve(p).defense,
      'player.totalDefense() must mirror the resolver snapshot');
  }
});

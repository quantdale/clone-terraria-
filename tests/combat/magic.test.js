/* tests/combat/magic.test.js — TC.Magic validation: mana clamps [0,maxMana],
   regen over frames respects maxMana, potion sickness blocks + expires,
   fire() scales damage by st.magicDamage exactly once and emits
   ProjectileSpawned once, mana persists through player serialize/deserialize. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot, deterministicRolls, countEvents } = require('./_helpers.js');

test('mana core: ensure/spend/restore clamp to [0, maxMana]', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  delete p.mana; delete p.maxMana;                    // fresh uninitialized player
  TC.Magic.ensureMana(p);
  assert.strictEqual(p.maxMana, TC.Magic.MANA_BASE);
  assert.strictEqual(p.mana, p.maxMana);

  assert.ok(TC.Magic.spendMana(p, 5));
  assert.strictEqual(p.mana, 15);
  assert.ok(!TC.Magic.spendMana(p, 999), 'cannot overspend');
  assert.strictEqual(p.mana, 15);

  TC.Magic.restoreMana(p, 999);
  assert.strictEqual(p.mana, p.maxMana, 'restore clamps at maxMana');

  p.mana = -5; TC.Magic.ensureMana(p);
  assert.strictEqual(p.mana, 0, 'ensureMana clamps below zero');
  p.mana = 1e9; TC.Magic.ensureMana(p);
  assert.strictEqual(p.mana, p.maxMana, 'ensureMana clamps above maxMana');
});

test('mana regen: refills over frames via stars and never exceeds maxMana', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  TC.Magic.ensureMana(p);
  p.maxMana = 40;                                     // grown pool
  p.mana = 0;
  p.manaRegenDelay = 0;
  let peak = 0;
  for (let i = 0; i < 60 * 15; i++) {                 // 15 simulated seconds
    TC.Magic.update(1 / 60);
    peak = Math.max(peak, p.mana);
    assert.ok(p.mana <= p.maxMana + 1e-9, 'regen exceeded maxMana');
  }
  assert.strictEqual(p.mana, p.maxMana, 'pool must refill fully within 15s');
  assert.ok(peak <= p.maxMana);
});

test('potion sickness: blocks drinking while active and expires over time', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  p.inventory.add('mana_potion', 2);
  const potionIdx = p.inventory.slots.findIndex((s) => s && s.id === 'mana_potion');
  assert.ok(potionIdx >= 0, 'potion must be in the bag');
  p.hotbarIndex = potionIdx;                          // select it for handleUse
  p.mana = 5;

  const realInput = TC.Input;
  TC.Input = {
    mouse: {
      x: 0, y: 0, worldX: p.x + 40, worldY: p.y - 20,
      down: true, clicked: true                       // held click each update
    },
    uiHover: false
  };
  try {
    // drink #1: sickness starts, item consumed, mana restored (clamped)
    TC.Magic.update(1 / 60);
    assert.strictEqual(p.potionSickness, TC.Magic.POTION_SICKNESS, 'sickness applied');
    assert.strictEqual(p.inventory.count('mana_potion'), 1, 'one potion consumed');
    assert.strictEqual(p.mana, p.maxMana, 'mana restored up to the cap');

    // still sick: the held-click must not consume the second potion
    TC.Magic.update(1 / 60);
    TC.Magic.update(1 / 60);
    assert.strictEqual(p.inventory.count('mana_potion'), 1, 'sickness blocked the sip');

    // expiry: countdown reaches zero (no click held) ...
    p.potionSickness = 0.05;
    p.mana = 3;
    TC.Input.mouse.clicked = false;
    for (let i = 0; i < 6 && p.potionSickness > 0; i++) TC.Magic.update(1 / 60);
    assert.strictEqual(p.potionSickness, 0, 'sickness expired');
    // ... and drinking works again afterwards
    TC.Input.mouse.clicked = true;
    TC.Magic.update(1 / 60);
    assert.strictEqual(p.inventory.count('mana_potion'), 0, 'drink allowed after expiry');
    assert.strictEqual(p.mana, p.maxMana);
  } finally {
    TC.Input = realInput;
  }
});

test('fire(): bolt launches raw and magicDamage scales exactly once at impact (W12)', () => {
  const g = boot();
  const TC = g.TC;
  deterministicRolls(TC, () => {
    const ev = countEvents(TC, ['ProjectileSpawned']);
    const unsub = TC.Stats.registerSource('test.magicmul', 500,
      (player, out) => { out.magicDamage *= 2; });
    try {
      const def = { damage: 10, speed: 300, colors: ['#ffffff'] };
      const bolt = TC.Magic.fire(def, TC.player.x, TC.player.y, 0);
      assert.ok(bolt && bolt.active, 'fire() returned a pooled bolt');
      assert.strictEqual(bolt.type, 'magic_bolt');
      // W12: no fire-time scaling — the raw base rides the pool.
      assert.strictEqual(bolt.dmg, 10, 'bolt carries unscaled def.damage');
      assert.strictEqual(ev.counts.ProjectileSpawned, 1);
      // ... and the canonical resolver applies magicDamage exactly once:
      const res = TC.Combat.resolveHit({
        base: bolt.dmg, cls: 'magic', attacker: TC.player,
        target: null, kb: bolt.kb,
      });
      assert.strictEqual(res.damage, 20,
        'round(def.damage * st.magicDamage) at resolution time, once');
      assert.strictEqual(res.cls, 'magic');
    } finally {
      unsub();
      TC.Projectiles.clear();
      ev.off();
    }
  });
});

test('mana persists through player serialize/deserialize', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  TC.Magic.ensureMana(p);
  p.maxMana = 80; p.mana = 37; p.potionSickness = 13;

  const blob = p.serialize();
  assert.deepStrictEqual(
    { mana: blob.mana, maxMana: blob.maxMana, potionSickness: blob.potionSickness },
    { mana: 37, maxMana: 80, potionSickness: 13 },
    'Player.serialize must embed Magic.captureOf fields');

  const p2 = TC.Player.deserialize(blob);
  TC.Magic.ensureMana(p2);
  assert.strictEqual(p2.maxMana, 80);
  assert.strictEqual(p2.mana, 37);
  assert.strictEqual(p2.potionSickness, 13);

  // direct pair round-trip too (the contract the provider relies on)
  const cap = TC.Magic.captureOf(p2);
  const p3 = {};
  TC.Magic.attachToPlayer(p3, cap);
  assert.deepStrictEqual(TC.Magic.captureOf(p3), cap);
});

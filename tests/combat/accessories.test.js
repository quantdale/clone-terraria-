/* tests/combat/accessories.test.js — TC.Accessories + TC.Buffs validation:
   5-slot equip/unequip round-trip (including swap semantics), deterministic
   prefix rolls, captureOf/attachToPlayer exact slot restore, deserialize
   validation, buff apply/refresh/expiry events. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./_helpers.js');

function slotIndexOf(TC, id) {
  return TC.player.inventory.slots.findIndex((s) => s && s.id === id);
}

test('equip/unequip: 5 slots, clean round-trip through the inventory', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  assert.strictEqual(TC.Accessories.SLOT_COUNT, 5);
  p.accessories = null;                               // force lazy init
  const slots = TC.Accessories.slotsOf(p);
  assert.strictEqual(slots.length, 5);
  assert.ok(slots.every((s) => s === null));

  p.inventory.add('guard_ring', 1);
  const invIdx = slotIndexOf(TC, 'guard_ring');
  assert.ok(invIdx >= 0, 'ring must be in the bag');

  assert.ok(TC.Accessories.equip(p, invIdx, 2), 'equip into slot 2');
  assert.strictEqual(slots[2].id, 'guard_ring');      // vm-realm object: compare fields
  assert.strictEqual(slots[2].prefix, null);
  assert.strictEqual(p.inventory.get(invIdx), null, 'bag slot emptied');

  assert.ok(TC.Accessories.unequip(p, 2), 'unequip back to the bag');
  assert.strictEqual(slots[2], null);
  assert.strictEqual(p.inventory.count('guard_ring'), 1);
});

test('equip swap: wearing a second accessory in the same slot returns the first', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  p.inventory.add('guard_ring', 1);
  p.inventory.add('swift_charm', 1);
  let idx = slotIndexOf(TC, 'guard_ring');
  assert.ok(TC.Accessories.equip(p, idx, 0));
  idx = slotIndexOf(TC, 'swift_charm');
  assert.ok(TC.Accessories.equip(p, idx, 0), 'swap onto occupied slot');
  const slots = TC.Accessories.slotsOf(p);
  assert.strictEqual(slots[0].id, 'swift_charm');
  assert.strictEqual(p.inventory.count('guard_ring'), 1, 'old piece stowed back');
  assert.strictEqual(p.inventory.count('swift_charm'), 0);
});

test('rollPrefix: deterministic for identical (itemId, seed)', () => {
  const gA = boot(11);
  const gB = boot(22);                                // independent module instances
  const a = gA.TC.Accessories, b = gB.TC.Accessories;
  for (let seed = 0; seed < 40; seed++) {
    const ra = a.rollPrefix('guard_ring', seed);
    assert.strictEqual(ra, b.rollPrefix('guard_ring', seed),
      'cross-instance mismatch at seed ' + seed);
    assert.strictEqual(ra, a.rollPrefix('guard_ring', seed),
      'repeat call mismatch at seed ' + seed);
    assert.ok(a.PREFIX_DEFS[ra], 'rolled prefix exists in PREFIX_DEFS');
  }
});

test('captureOf/attachToPlayer: exact slot round-trip incl. valid prefixes', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  p.accessories = [
    { id: 'guard_ring', prefix: 'guarded' },
    null,
    { id: 'swift_charm', prefix: null },
    { id: 'regen_band', prefix: 'bogus_prefix' },     // invalid -> stripped
    { id: 'power_glove', prefix: null }
  ];
  const cap = TC.Accessories.captureOf(p);
  // vm-realm objects: compare the JSON shape. capture() mirrors what is worn
  // verbatim; SANITIZING unknown prefixes is restore's job (verified below).
  assert.strictEqual(JSON.stringify(cap), JSON.stringify([
    { id: 'guard_ring', prefix: 'guarded' },
    null,
    { id: 'swift_charm', prefix: null },
    { id: 'regen_band', prefix: 'bogus_prefix' },
    { id: 'power_glove', prefix: null }
  ]));

  const p2 = {};
  assert.ok(TC.Accessories.attachToPlayer(p2, cap));
  assert.strictEqual(JSON.stringify(TC.Accessories.captureOf(p2)), JSON.stringify([
    { id: 'guard_ring', prefix: 'guarded' },
    null,
    { id: 'swift_charm', prefix: null },
    { id: 'regen_band', prefix: null },               // unknown prefix stripped
    { id: 'power_glove', prefix: null }
  ]), 'restore must reproduce valid slots exactly and sanitize bad prefixes');
});

test('deserialize: rejects non-accessory items and unknown prefixes', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  assert.ok(TC.Accessories.deserialize(p, [
    { id: 'wood', prefix: null },                     // not kind 'accessory'
    { id: 'aimer_lens', prefix: 'nope' },
    'garbage',
    null,
    undefined
  ]));
  const slots = TC.Accessories.slotsOf(p);
  assert.strictEqual(slots[0], null);
  assert.strictEqual(slots[1].id, 'aimer_lens');      // vm-realm object: compare fields
  assert.strictEqual(slots[1].prefix, null);          // unknown prefix stripped
  assert.strictEqual(slots[2], null);
  assert.strictEqual(slots[4], null);
});

test('buffs: apply/refresh/expiry emit BuffApplied/BuffExpired correctly', () => {
  const g = boot();
  const TC = g.TC;
  TC.Accessories.update(1 / 60);                      // establish session player
  const counts = { applied: 0, expired: 0 };
  TC.Events.on(TC.Events.EVENT.BuffApplied, () => counts.applied++);
  TC.Events.on(TC.Events.EVENT.BuffExpired, () => counts.expired++);

  assert.ok(TC.Buffs.apply('wrath', 0.08));
  assert.strictEqual(counts.applied, 1);
  assert.ok(TC.Buffs.has('wrath'));

  // refresh extends to the longer duration and re-emits BuffApplied
  assert.ok(TC.Buffs.apply('wrath', 5));
  assert.strictEqual(counts.applied, 2);
  const entry = TC.Buffs.list.find((b) => b.id === 'wrath');
  assert.strictEqual(entry.time, 5, 'refresh takes the longer duration');

  // natural expiry emits BuffExpired exactly once and drops the entry
  for (let i = 0; i < 60 * 6 && TC.Buffs.has('wrath'); i++) {
    TC.Accessories.update(1 / 60);
  }
  assert.ok(!TC.Buffs.has('wrath'));
  assert.strictEqual(counts.expired, 1);

  // manual remove emits BuffExpired once; removing absent id does not
  TC.Buffs.apply('slowed', 30);
  assert.ok(TC.Buffs.remove('slowed'));
  assert.ok(!TC.Buffs.remove('slowed'));
  assert.strictEqual(counts.expired, 2);

  // unknown buff id refused
  assert.ok(!TC.Buffs.apply('not_a_buff', 10));
});

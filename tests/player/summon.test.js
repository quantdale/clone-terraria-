/* tests/player/summon.test.js — boss-summon contract (W15): night gating,
   no consumption on failure, duplicate-boss safety, condition gates via the
   shared progression grammar, and successful spawns consuming one charge. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('../combat/_helpers.js');

function heldSummon(TC, itemId) {
  const p = TC.player;
  const left = p.inventory.add(itemId, 1);
  assert.strictEqual(left, 0, itemId + ' fits in the bag');
  const idx = p.inventory.slots.findIndex((s) => s && s.id === itemId);
  p.hotbarIndex = idx;
  return TC.ITEM_DEFS[itemId];
}

test('summons: daytime use is rejected and consumes nothing', () => {
  const g = boot(777);
  const TC = g.TC;
  TC.Sky.time = 10; // broad daylight
  const def = heldSummon(TC, 'storm_bell');
  TC.player.doSummon(def, 'storm_bell');
  assert.strictEqual(TC.player.inventory.count('storm_bell'), 1,
    'the bell stays in the bag');
  assert.strictEqual(TC.Enemies.list.length, 0);
});

test('summons: a live boss blocks the attempt without consuming the item', () => {
  const g = boot(777);
  const TC = g.TC;
  TC.Sky.time = 500; // night
  // occupy the single MAX_BOSSES slot through the canonical path
  assert.ok(TC.Enemies.spawnBoss('void_eye', TC.player.x, TC.player.y - 300));
  const def = heldSummon(TC, 'storm_bell');
  TC.player.doSummon(def, 'storm_bell');
  assert.strictEqual(TC.player.inventory.count('storm_bell'), 1,
    'blocked summons never consume charges');
  assert.ok(!TC.Enemies.list.some((e) => e.type === 'storm_jelly'));
});

test('summons: valid night use spawns the boss and consumes exactly one', () => {
  const g = boot(777);
  const TC = g.TC;
  TC.Sky.time = 500; // night
  const def = heldSummon(TC, 'storm_bell');
  TC.player.doSummon(def, 'storm_bell');
  assert.strictEqual(TC.player.inventory.count('storm_bell'), 0,
    'one charge consumed');
  assert.ok(TC.Enemies.list.some((e) => e.def && e.def.boss), 'storm jelly awake');
});

test('summons: optional def.condition gates declaratively (W14 grammar)', () => {
  const g = boot(777);
  const TC = g.TC;
  TC.Sky.time = 500; // night
  const def = Object.assign({}, TC.ITEM_DEFS.moss_heart, {
    name: 'Test Heart',
    condition: { boss: 'storm_jelly' },
  });
  heldSummon(TC, 'moss_heart');
  TC.player.doSummon(def, 'moss_heart');
  assert.strictEqual(TC.player.inventory.count('moss_heart'), 1,
    'gated summon does not consume while its moment has not come');
  assert.strictEqual(TC.Enemies.list.length, 0);
  // open the gate -> the same use now works end to end
  TC.Progression.set(TC.Progression.FLAGS.bossStormJelly);
  TC.player.swing = null;
  TC.player.doSummon(def, 'moss_heart');
  assert.strictEqual(TC.player.inventory.count('moss_heart'), 0);
  assert.ok(TC.Enemies.list.some((e) => e.type === 'moss_mother'));
});

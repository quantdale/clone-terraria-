/* tests/npc/economy.test.js — W2 campaign: canonical currency + transactional
   NPC shop economy.

   Contract under test:
     - TC.Economy: three denominations (1/100/10000), exact pay-with-change,
       give() deposits value losslessly, dropCoins scatters physical drops.
     - TC.Commands.ShopBuy: validate-then-apply; failure (poor, out of stock,
       full inventory) mutates NOTHING; success pays exactly once and emits
       ShopBuy.
     - TC.Commands.ShopSell: sells only goods with a base value at 1/5 price;
       coins themselves are never sellable.
     - Progression-aware stock: requires-gated rows stay hidden until the
       flag exists. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function setup(seed) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(seed == null ? 77 : seed);
  return { g, TC };
}

function purse(TC) { return TC.Economy.total(TC.player.inventory); }

test('economy: give/pay round-trips exactly across denominations', () => {
  const { TC } = setup(81);
  const inv = TC.player.inventory;
  assert.strictEqual(TC.Economy.give(inv, 12345), 12345);
  assert.strictEqual(purse(TC), 12345);
  // denomination layout: 1g 23s 45c
  assert.strictEqual(inv.count('coin_gold'), 1);
  assert.strictEqual(inv.count('coin_silver'), 23);
  assert.strictEqual(inv.count('coin_copper'), 45);

  assert.ok(TC.Economy.pay(inv, 10000));          // exactly one gold coin
  assert.strictEqual(purse(TC), 2345);            // change re-deposited small
  assert.ok(TC.Economy.pay(inv, 2345));
  assert.strictEqual(purse(TC), 0);

  // short purses never mutate
  assert.ok(TC.Economy.give(inv, 50));
  assert.strictEqual(TC.Economy.pay(inv, 51), false);
  assert.strictEqual(purse(TC), 50);
});

test('economy: dropCoins scatters value as physical coin drops', () => {
  const { TC } = setup(82);
  const n0 = TC.Items.drops.length;
  TC.Economy.dropCoins(600, 200, 250);
  const dropped = TC.Items.drops.slice(n0);
  assert.ok(dropped.length >= 2, 'expected split denominations');
  let total = 0;
  for (const d of dropped) {
    if (d.id === 'coin_silver') total += d.count * 100;
    else if (d.id === 'coin_copper') total += d.count;
    else if (d.id === 'coin_gold') total += d.count * 10000;
  }
  assert.strictEqual(total, 250, 'drop value not conserved');
});

test('shop buy: happy path pays once, adds the item, emits ShopBuy', () => {
  const { TC } = setup(83);
  const inv = TC.player.inventory;
  TC.Economy.give(inv, 500);
  const events = [];
  TC.Events.on(TC.Events.EVENT.ShopBuy, (p) => events.push(p));

  // starter kit already holds torches — assert on the delta
  const before = inv.count('torch');
  const r = TC.Commands.submit('ShopBuy', {
    player: TC.player, npcType: 'merchant', itemId: 'torch',
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.result.bought, true);
  assert.strictEqual(r.result.price, 2);
  assert.strictEqual(inv.count('torch'), before + 1);
  assert.strictEqual(purse(TC), 498);
  assert.strictEqual(events.length, 1);
});

test('shop buy: failures mutate nothing (poor / stock / capacity)', () => {
  const { TC } = setup(84);
  const inv = TC.player.inventory;

  // too poor: no coins at all
  const before = JSON.stringify(inv.serialize());
  let r = TC.Commands.submit('ShopBuy', {
    player: TC.player, npcType: 'merchant', itemId: 'gold_bar',
  });
  assert.equal(r.ok, false);
  assert.strictEqual(r.error, 'too-poor');
  assert.strictEqual(JSON.stringify(inv.serialize()), before);

  // unknown item / not in stock
  r = TC.Commands.submit('ShopBuy', {
    player: TC.player, npcType: 'merchant', itemId: 'dirt_block_xyz',
  });
  assert.strictEqual(r.error, 'unknown-item');

  // full inventory: fill every non-coin slot so nothing new can fit while
  // the purse stays payable
  TC.Economy.give(inv, 400);
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.slots[i];
    if (!s || s.id.indexOf('coin_') !== 0) {
      inv.slots[i] = { id: 'gold_pickaxe', count: 1 }; // maxStack 1 tool
    }
  }
  const snap = JSON.stringify(inv.serialize());
  r = TC.Commands.submit('ShopBuy', {
    player: TC.player, npcType: 'merchant', itemId: 'torch',
  });
  assert.equal(r.ok, false);
  assert.strictEqual(r.error, 'inventory-full');
  assert.strictEqual(JSON.stringify(inv.serialize()), snap);
});

test('shop sell: sells goods at one-fifth value and refuses junk/coins', () => {
  const { TC } = setup(85);
  const inv = TC.player.inventory;
  // gold_bar value 30 -> unit sell 6; sell 4 bars => 24 copper
  inv.slots[3] = { id: 'gold_bar', count: 4 };
  const r = TC.Commands.submit('ShopSell', {
    player: TC.player, npcType: 'merchant', slot: 3, count: 4,
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.result.sold, true);
  assert.strictEqual(r.result.proceeds, 24);
  // the bar stack is gone (the change may land in that same slot)
  const s3 = inv.get(3);
  assert.ok(!s3 || s3.id !== 'gold_bar');
  assert.strictEqual(purse(TC), 24);

  // currency itself is never sellable
  inv.slots[5] = { id: 'coin_copper', count: 10 };
  const r2 = TC.Commands.submit('ShopSell', {
    player: TC.player, npcType: 'merchant', slot: 5, count: 1,
  });
  assert.equal(r2.ok, false);
  assert.strictEqual(r2.error, 'cannot-sell-currency');
  assert.strictEqual(inv.get(5).count, 10);
});

test('shop stock: requires-gated rows hidden until progression flags exist', () => {
  const { TC } = setup(86);
  const before = TC.NPCs.shopOf('merchant').map((e) => e.itemId);
  assert.ok(before.includes('torch'));
  assert.ok(!before.includes('guard_ring'),
    'progression row leaked before boss flag');

  TC.Progression.set(TC.Progression.FLAGS.bossEyeOfVoid);
  const after = TC.NPCs.shopOf('merchant').map((e) => e.itemId);
  assert.ok(after.includes('guard_ring'), 'gated row did not unlock');

  // purchase of a gated row works once unlocked
  TC.Economy.give(TC.player.inventory, 300);
  const r = TC.Commands.submit('ShopBuy', {
    player: TC.player, npcType: 'merchant', itemId: 'guard_ring',
  });
  assert.ok(r.ok, JSON.stringify(r));
});

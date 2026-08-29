/* tests/world/lootables.test.js — TC.LootTables canonical evaluation (W13):
   guaranteed drops, chance rolls with injected RNG, stack bounds, coins,
   gated entries, malformed-table validation, and exactly-once entity loot
   through killEnemy. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot() {
  const g = loadGame();
  g.TC.newGame(4242);
  return g;
}

// Deterministic rng helpers
function always(v) {
  return () => v;
}
function seq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test('lootables: guaranteed drop rolls min..max with rng=0.5 picking low half', () => {
  const g = boot();
  const LT = g.TC.LootTables;
  const table = [{ id: 'gel', min: 2, max: 5 }];
  // rng 0.4: chance passes (0.4 < 1); count = 2 + floor(0.4 * 4) = 3
  // vm-realm result objects: compare structurally via JSON
  assert.strictEqual(JSON.stringify(LT.roll(table, { rng: always(0.4) })),
    JSON.stringify([{ id: 'gel', count: 3 }]));
  assert.strictEqual(JSON.stringify(LT.roll(table, { rng: always(0.99) })),
    JSON.stringify([{ id: 'gel', count: 5 }]));
  assert.strictEqual(JSON.stringify(LT.roll(table, { rng: always(0.0) })),
    JSON.stringify([{ id: 'gel', count: 2 }]));
});

test('lootables: chance gate honors injected rng exactly at the boundary', () => {
  const g = boot();
  const LT = g.TC.LootTables;
  const table = [{ id: 'gel', chance: 0.5 }];
  assert.strictEqual(LT.roll(table, { rng: always(0.49) }).length, 1);
  assert.strictEqual(LT.roll(table, { rng: always(0.5) }).length, 0,
    'rng() >= chance misses (half-open interval)');
});

test('lootables: seeded sequences are reproducible', () => {
  const g = boot();
  const LT = g.TC.LootTables;
  function lcg(seed) {
    let s = seed >>> 0;
    return () => ((s = (1103515245 * s + 12345) >>> 0), s / 4294967296);
  }
  const table = [
    { id: 'gel', min: 1, max: 3, chance: 0.8 },
    { id: 'stone', min: 1, max: 2, chance: 0.6 },
  ];
  const a = LT.roll(table, { rng: lcg(999) });
  const b = LT.roll(table, { rng: lcg(999) });
  assert.deepStrictEqual(a, b);
});

test('lootables: coins roll inside [min,max] and zero for malformed ranges', () => {
  const g = boot();
  const LT = g.TC.LootTables;
  for (let i = 0; i < 200; i++) {
    const n = LT.rollCoins([10, 20]);
    assert.ok(n >= 10 && n <= 20);
  }
  assert.strictEqual(LT.rollCoins([5, 5]), 5);
  assert.strictEqual(LT.rollCoins(null), 0);
  assert.strictEqual(LT.rollCoins([7]), 0);
  assert.strictEqual(LT.rollCoins('x'), 0);
  // malformed ranges coerce to [min,min] at ROLL time; validateRange is the loud path
  assert.strictEqual(LT.rollCoins([9, 3], { rng: always(0) }), 9);
});

test('lootables: requires-gated entries skip while the flag is unset', () => {
  const g = boot();
  const TC = g.TC;
  const LT = TC.LootTables;
  const table = [
    { id: 'stone', min: 1, max: 1 },
    { id: 'gel', min: 1, max: 1, requires: 'boss.storm_jelly.defeated' },
  ];
  const before = LT.roll(table, { rng: always(0) });
  assert.strictEqual(JSON.stringify(before), JSON.stringify([{ id: 'stone', count: 1 }]));
  TC.Progression.set('boss.storm_jelly.defeated');
  const after = LT.roll(table, { rng: always(0) });
  assert.strictEqual(JSON.stringify(after),
    JSON.stringify([{ id: 'stone', count: 1 }, { id: 'gel', count: 1 }]));
});

test('lootables: validate reports unknown ids, bad chances, inverted ranges', () => {
  const g = boot();
  const LT = g.TC.LootTables;
  const problems = LT.validate([
    { id: 'gel', min: 1, max: 2 },
    { id: 'not_an_item', min: 1, max: 1 },
    { id: 'stone', chance: 1.5 },
    { id: 'stone', chance: -0.1 },
    { id: 'stone', min: 5, max: 2 },
    { id: 'stone', min: 0 },
    'garbage',
  ], 'test.table');
  const text = problems.join('\n');
  assert.match(text, /unknown item id "not_an_item"/);
  assert.match(text, /chance 1\.5 outside \[0,1\]/);
  assert.match(text, /chance -0\.1 outside \[0,1\]/);
  assert.match(text, /min > max/);
  assert.match(text, /min must be an integer >= 1/);
  assert.match(text, /entry is not an object/);
  assert.strictEqual(problems.length, 6);
  assert.deepStrictEqual(LT.validate([{ id: 'gel' }], 'ok').length, 0);
});

test('lootables: validateRange flags non-integer or negative coin ranges', () => {
  const g = boot();
  const LT = g.TC.LootTables;
  assert.strictEqual(LT.validateRange([1, 2], 'c').length, 0);
  assert.strictEqual(LT.validateRange([2, 1], 'c').length, 1);
  assert.strictEqual(LT.validateRange([-1, 5], 'c').length, 1);
  assert.strictEqual(LT.validateRange([1.5, 3], 'c').length, 1);
});

test('lootables: every shipped ENEMY_DEFS drop/coin table validates clean', () => {
  const g = boot();
  const problems = g.TC.LootTables.validateAll();
  assert.strictEqual(problems.length, 0,
    'shipped content must not produce validation problems');
});

test('enemies: killEnemy scatters loot exactly once (no duplicate boss loot)', () => {
  const g = boot();
  const TC = g.TC;
  const def = TC.ENEMY_DEFS.king_slime;
  const e = {
    type: 'king_slime', def,
    x: TC.player.x, y: TC.player.y - 40, w: def.w, h: def.h,
    vx: 0, vy: 0, hp: 1, maxHp: def.hp, flashTimer: 0, master: null,
  };
  TC.Enemies.list.push(e);
  TC.Items.clearDrops();
  let coinDrops = 0;
  const origDrop = TC.Economy.dropCoins;
  TC.Economy.dropCoins = (...a) => { coinDrops++; return origDrop.apply(TC.Economy, a); };
  try {
    TC.Enemies.damageEnemy(e, 500, 1, 0, false);
    assert.strictEqual(TC.Enemies.damageEnemy(e, 500, 1, 0, false), 0,
      'dead enemies reject further application');
    // gel + gold_bar + slime_crown(chance) + one coin drop call
    const ids = TC.Items.drops.map((d) => d.id).sort();
    assert.ok(ids.includes('gel'), 'guaranteed gel dropped');
    assert.ok(ids.includes('gold_bar'), 'guaranteed gold bars dropped');
    assert.ok(coinDrops === 1, 'exactly one coin scatter per death');
    const gelCount = TC.Items.drops.filter((d) => d.id === 'gel')
      .reduce((n, d) => n + d.count, 0);
    assert.ok(gelCount >= def.drops[0].min && gelCount <= def.drops[0].max,
      'stack within declared bounds');
  } finally {
    TC.Economy.dropCoins = origDrop;
  }
});

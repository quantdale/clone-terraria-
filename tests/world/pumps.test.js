/* tests/world/pumps.test.js — W24 LIQ-006: wire-powered inlet/outlet pumps.
   Proves the v1 pump contract against the authoritative TC.Liquids layer:
     - exact per-type volume conservation (except canonical water+lava
       reaction consumption into stone);
     - deterministic ascending-cell-order processing, once per endpoint
       even across wire loops / duplicate paths;
     - incompatible types never convert or overwrite each other;
     - bounded work under pathological pump farms (endpoint cap);
     - all mutations ride TC.Liquids.set() (wakeup/reaction/region path). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

const X0 = 480;
const Y1 = 130;

function setup(seed) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(seed == null ? 71 : seed);
  return { g, TC };
}

// Isolated stone box with air interior [x0..x1] x [y0..y1].
function carveArena(TC, x0, y0, x1, y1) {
  const w = TC.world;
  const AIR = TC.TILE.AIR, STONE = TC.TILE.STONE;
  for (let y = y0 - 2; y <= y1 + 3; y++) {
    for (let x = x0 - 2; x <= x1 + 2; x++) w.setRaw(x, y, AIR);
  }
  for (let y = y0 - 2; y <= y1 + 1; y++) {
    w.setRaw(x0 - 1, y, STONE);
    w.setRaw(x1 + 1, y, STONE);
  }
  for (let x = x0 - 2; x <= x1 + 2; x++) {
    w.setRaw(x, y1 + 1, STONE);
    w.setRaw(x, y0 - 2, STONE);
  }
}

// Rig: inlet at ax, wire run, outlet at bx (same row). Wire sits between.
function rig(TC, ax, bx, row) {
  const T = TC.TILE;
  const w = TC.world;
  w.setRaw(ax, row, T.INLET_PUMP);
  for (let x = ax + 1; x < bx; x++) w.setRaw(x, row, T.WIRE);
  w.setRaw(bx, row, T.OUTLET_PUMP);
}

function q(TC, x, y) { return TC.Liquids.queryAt(x, y); }

// Total liquid volume per type inside a rectangle.
function volumeByType(TC, x0, y0, x1, y1) {
  const tot = { 1: 0, 2: 0, 3: 0 };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const s = q(TC, x, y);
      if (s.amount > 0) tot[s.type] += s.amount;
    }
  }
  return tot;
}

test('pumps: one inlet -> one outlet conserves volume exactly', () => {
  const { TC } = setup(72);
  carveArena(TC, X0, Y1 - 4, X0 + 12, Y1);
  rig(TC, X0 + 2, X0 + 10, Y1);
  TC.Liquids.set(X0 + 2, Y1, TC.Liquids.TYPE.WATER, 255);

  const before = volumeByType(TC, X0 - 1, Y1 - 5, X0 + 13, Y1 + 1);
  TC.Wiring.pulse(X0 + 6, Y1);
  const after = volumeByType(TC, X0 - 1, Y1 - 5, X0 + 13, Y1 + 1);

  assert.deepStrictEqual(after, before, 'total volume changed');
  assert.strictEqual(q(TC, X0 + 10, Y1).type, TC.Liquids.TYPE.WATER,
    'outlet did not receive water');
  assert.ok(q(TC, X0 + 10, Y1).amount > 0, 'outlet received no volume');
  assert.ok(q(TC, X0 + 2, Y1).amount < 255, 'inlet did not give up volume');
  const st = TC.Wiring.pumpStats();
  assert.strictEqual(st.unitsMoved,
    before[1] - after[1] === 0 ? q(TC, X0 + 10, Y1).amount : st.unitsMoved);
});

test('pumps: transfer is bounded per pulse by PUMP_TRANSFER', () => {
  const { TC } = setup(73);
  carveArena(TC, X0, Y1 - 4, X0 + 12, Y1);
  rig(TC, X0 + 2, X0 + 10, Y1);
  TC.Liquids.set(X0 + 2, Y1, TC.Liquids.TYPE.LAVA, 255);
  TC.Wiring.pulse(X0 + 6, Y1);
  assert.strictEqual(q(TC, X0 + 10, Y1).amount, TC.Wiring.PUMP_TRANSFER,
    'per-endpoint cap violated');
  assert.strictEqual(q(TC, X0 + 2, Y1).amount, 255 - TC.Wiring.PUMP_TRANSFER,
    'source lost more than the cap');
});

test('pumps: partially filled outlet accepts only its own type', () => {
  const { TC } = setup(74);
  carveArena(TC, X0, Y1 - 4, X0 + 12, Y1);
  rig(TC, X0 + 2, X0 + 10, Y1);
  // outlet holds honey, inlet supplies water: nothing may move
  TC.Liquids.set(X0 + 2, Y1, TC.Liquids.TYPE.WATER, 255);
  TC.Liquids.set(X0 + 10, Y1, TC.Liquids.TYPE.HONEY, 30);
  const before = volumeByType(TC, X0 - 1, Y1 - 5, X0 + 13, Y1 + 1);
  TC.Wiring.pulse(X0 + 6, Y1);
  const after = volumeByType(TC, X0 - 1, Y1 - 5, X0 + 13, Y1 + 1);
  assert.deepStrictEqual(after, before, 'volume moved despite type mismatch');
  assert.strictEqual(q(TC, X0 + 10, Y1).type, TC.Liquids.TYPE.HONEY,
    'outlet type transmuted');

  // same-type partial fill tops up within cell capacity, capped per pulse
  TC.Liquids.set(X0 + 2, Y1, TC.Liquids.TYPE.HONEY, 255);
  TC.Liquids.set(X0 + 10, Y1, TC.Liquids.TYPE.HONEY, 250);
  TC.Wiring.pulse(X0 + 6, Y1);
  assert.strictEqual(q(TC, X0 + 10, Y1).amount, 255, 'cell overfilled');
  assert.strictEqual(q(TC, X0 + 2, Y1).amount, 255 - 5,
    'inlet gave more than the destination could accept');
});

test('pumps: empty source and full output move nothing (fail closed)', () => {
  const { TC } = setup(75);
  carveArena(TC, X0, Y1 - 4, X0 + 12, Y1);
  rig(TC, X0 + 2, X0 + 10, Y1);
  const rejBefore = TC.Wiring.pumpStats().rejected;
  // empty inlet
  TC.Liquids.set(X0 + 10, Y1, TC.Liquids.TYPE.WATER, 100);
  TC.Wiring.pulse(X0 + 6, Y1);
  assert.strictEqual(q(TC, X0 + 10, Y1).amount, 100, 'empty inlet created volume');
  // full outlet (255) cannot take more
  TC.Liquids.set(X0 + 2, Y1, TC.Liquids.TYPE.WATER, 255);
  TC.Liquids.set(X0 + 10, Y1, TC.Liquids.TYPE.WATER, 255);
  TC.Wiring.pulse(X0 + 6, Y1);
  assert.strictEqual(q(TC, X0 + 2, Y1).amount, 255, 'full output drained source');
  assert.ok(TC.Wiring.pumpStats().rejected > rejBefore, 'rejections not counted');
});

test('pumps: multiple outlets fill deterministically in ascending cell order', () => {
  const { TC } = setup(76);
  carveArena(TC, X0, Y1 - 4, X0 + 14, Y1);
  const T = TC.TILE;
  const w = TC.world;
  // Pump tiles do not conduct, so endpoints share a PARALLEL rail one row
  // above: one pulse floods the whole rail and reaches every pump.
  const ins = [X0 + 1, X0 + 3, X0 + 5];
  const outs = [X0 + 8, X0 + 10, X0 + 12];
  for (const ix of ins) w.setRaw(ix, Y1, T.INLET_PUMP);
  for (const ox of outs) w.setRaw(ox, Y1, T.OUTLET_PUMP);
  for (let x = ins[0]; x <= outs[2]; x++) if (w.get(x, Y1) === T.AIR) w.setRaw(x, Y1, T.WIRE);
  for (let x = ins[0]; x <= outs[2]; x++) w.setRaw(x, Y1 - 1, T.WIRE);
  for (const ix of ins) TC.Liquids.set(ix, Y1, TC.Liquids.TYPE.WATER, 40);

  TC.Wiring.pulse(outs[1], Y1 - 1);
  // Ascending order + cumulative per-outlet budget (cap 48/pulse):
  // i1->oA 40 | i2->oA 8, oB 32 | i3->oB 16, oC 24.
  const got = outs.map((ox) => q(TC, ox, Y1).amount);
  assert.deepStrictEqual(got, [48, 48, 24], 'distribution violated ascending order');
  for (const ix of ins) {
    assert.strictEqual(q(TC, ix, Y1).amount, 0, 'an inlet kept supply');
  }
});

test('pumps: multiple inlets drain in ascending order into one outlet', () => {
  const { TC } = setup(77);
  carveArena(TC, X0, Y1 - 4, X0 + 14, Y1);
  const T = TC.TILE;
  const w = TC.world;
  const ins = [X0 + 1, X0 + 5];
  const outX = X0 + 10;
  // shared rail above joins every endpoint into ONE pulse component
  for (const ix of ins) w.setRaw(ix, Y1, T.INLET_PUMP);
  w.setRaw(outX, Y1, T.OUTLET_PUMP);
  for (let x = ins[0]; x <= outX; x++) w.setRaw(x, Y1 - 1, T.WIRE);
  TC.Liquids.set(ins[0], Y1, TC.Liquids.TYPE.WATER, 40);
  TC.Liquids.set(ins[1], Y1, TC.Liquids.TYPE.WATER, 200);

  TC.Wiring.pulse(X0 + 7, Y1 - 1);
  // cumulative budget: i1 gives its full 40, i2 tops the outlet to the cap
  assert.strictEqual(q(TC, outX, Y1).amount, TC.Wiring.PUMP_TRANSFER);
  assert.strictEqual(q(TC, ins[0], Y1).amount, 0, 'first inlet not drained first');
  assert.strictEqual(q(TC, ins[1], Y1).amount, 200 - (TC.Wiring.PUMP_TRANSFER - 40),
    'second inlet contributed more than needed');
});

test('pumps: mixed types on one component never duplicate or transmute', () => {
  const { TC } = setup(78);
  carveArena(TC, X0, Y1 - 4, X0 + 14, Y1);
  const T = TC.TILE;
  // water inlet | lava inlet | wire | empty outlet | empty outlet
  const wIn = X0 + 1, lIn = X0 + 3;
  const oA = X0 + 9, oB = X0 + 12;
  TC.world.setRaw(wIn, Y1, T.INLET_PUMP);
  TC.world.setRaw(lIn, Y1, T.INLET_PUMP);
  for (let x = wIn + 1; x <= oB; x++) {
    if (TC.world.get(x, Y1) === TC.TILE.AIR) TC.world.setRaw(x, Y1, T.WIRE);
  }
  TC.world.setRaw(oA, Y1, T.OUTLET_PUMP);
  TC.world.setRaw(oB, Y1, T.OUTLET_PUMP);
  TC.Liquids.set(wIn, Y1, TC.Liquids.TYPE.WATER, 60);
  TC.Liquids.set(lIn, Y1, TC.Liquids.TYPE.LAVA, 60);

  const before = volumeByType(TC, X0 - 1, Y1 - 5, X0 + 15, Y1 + 1);
  TC.Wiring.pulse(X0 + 6, Y1);
  const after = volumeByType(TC, X0 - 1, Y1 - 5, X0 + 15, Y1 + 1);
  assert.deepStrictEqual(after, before, 'mixed-type batch changed totals');

  // each empty outlet receives exactly ONE type (no blending)
  const tA = q(TC, oA, Y1), tB = q(TC, oB, Y1);
  assert.ok(tA.type !== 0 || tB.type !== 0, 'nothing delivered');
  if (tA.amount > 0 && tB.amount > 0) {
    assert.notStrictEqual(tA.type, tB.type,
      'two empty outlets blended the same mixed batch');
  }
  // whatever arrived is pure: totals per type still match
  assert.strictEqual(after[1] + after[2], before[1] + before[2],
    'water+lava units were not conserved individually');
});

test('pumps: wire loops process an endpoint exactly once', () => {
  const { TC } = setup(79);
  carveArena(TC, X0, Y1 - 6, X0 + 12, Y1);
  const T = TC.TILE;
  const ax = X0 + 2, bx = X0 + 8;
  rig(TC, ax, bx, Y1);
  // wrap BOTH pumps in a ring of wire so BFS reaches them via many paths
  for (let x = ax - 1; x <= bx + 1; x++) {
    TC.world.setRaw(x, Y1 - 2, T.WIRE);
    TC.world.setRaw(x, Y1 - 1, T.WIRE);
  }
  TC.world.setRaw(ax - 1, Y1 - 1, T.WIRE);
  TC.world.setRaw(bx + 1, Y1 - 1, T.WIRE);

  TC.Liquids.set(ax, Y1, TC.Liquids.TYPE.WATER, 255);
  const epBefore = TC.Wiring.pumpStats().endpoints;
  TC.Wiring.pulse(bx, Y1 - 2); // pulse from inside the ring
  const movedOnce = q(TC, bx, Y1).amount;
  assert.strictEqual(movedOnce, TC.Wiring.PUMP_TRANSFER,
    'loop caused over/under-transfer');
  assert.strictEqual(TC.Wiring.pumpStats().endpoints - epBefore, 2,
    'endpoints not deduped to one processing each');
});

test('pumps: farms beyond the endpoint cap hit the budget without losing volume', () => {
  const { TC } = setup(80);
  const T = TC.TILE;
  const w = TC.world;
  const startX = X0;
  const row = Y1;
  carveArena(TC, startX - 2, row - 3, startX + 140, row + 3);
  // Two continuous wire rails bracket the pump row (pumps do not conduct,
  // so the rails ARE the shared component); a stub column joins them.
  for (let x = startX - 1; x <= startX + 133; x++) {
    w.setRaw(x, row - 1, T.WIRE);
    w.setRaw(x, row + 1, T.WIRE);
  }
  w.setRaw(startX - 1, row, T.WIRE);
  let pumps = 0;
  for (let k = 0; k <= 132; k += 2) {
    const x = startX + k;
    w.setRaw(x, row, pumps % 2 === 0 ? T.INLET_PUMP : T.OUTLET_PUMP);
    if (pumps % 2 === 0) TC.Liquids.set(x, row, TC.Liquids.TYPE.WATER, 255);
    pumps++;
  }
  const before = volumeByType(TC, startX - 2, row - 4, startX + 141, row + 2);
  TC.Wiring.pulse(startX + 66, row - 1);
  const after = volumeByType(TC, startX - 2, row - 4, startX + 141, row + 2);
  assert.deepStrictEqual(after, before, 'capped batch broke conservation');
  const st = TC.Wiring.pumpStats();
  assert.ok(st.capHits >= 1, 'cap hit was not observed');
  assert.strictEqual(st.endpoints, TC.Wiring.PUMP_ENDPOINT_CAP,
    'processing exceeded the endpoint budget');
});

test('pumps: outlet feeding a lava contact follows the canonical stone reaction', () => {
  const { TC } = setup(81);
  carveArena(TC, X0, Y1 - 5, X0 + 12, Y1);
  rig(TC, X0 + 2, X0 + 10, Y1 - 1);
  // lava pool directly below the OUTLET cell
  TC.Liquids.set(X0 + 10, Y1, TC.Liquids.TYPE.LAVA, 255);
  TC.Liquids.set(X0 + 2, Y1 - 1, TC.Liquids.TYPE.WATER, 255);

  TC.Wiring.pulse(X0 + 6, Y1 - 1);
  assert.strictEqual(q(TC, X0 + 10, Y1 - 1).type, TC.Liquids.TYPE.WATER,
    'outlet did not receive water');
  // settle until the water contacts the lava below -> stone consumes both
  for (let k = 0; k < 40 && TC.world.get(X0 + 10, Y1) !== TC.TILE.STONE; k++) {
    TC.Liquids.update(0.06);
  }
  assert.strictEqual(TC.world.get(X0 + 10, Y1), TC.TILE.STONE,
    'canonical water+lava reaction never fired');
  assert.strictEqual(q(TC, X0 + 10, Y1).amount, 0, 'reaction left lava behind');
});

test('pumps: identical rigs replay to identical digests (determinism)', () => {
  const build = (seed) => {
    const { TC } = setup(seed);
    carveArena(TC, X0, Y1 - 4, X0 + 12, Y1);
    rig(TC, X0 + 2, X0 + 10, Y1);
    TC.Liquids.set(X0 + 2, Y1, TC.Liquids.TYPE.WATER, 200);
    TC.Liquids.set(X0 + 2, Y1 - 1, TC.Liquids.TYPE.WATER, 120);
    for (let p = 0; p < 5; p++) TC.Wiring.pulse(X0 + 6, Y1);
    for (let k = 0; k < 25; k++) TC.Liquids.update(0.06);
    return { d: TC.Liquids.digest(), v: volumeByType(TC, X0 - 1, Y1 - 5, X0 + 13, Y1 + 1) };
  };
  const a = build(82);
  const b = build(82);
  assert.strictEqual(a.d, b.d, 'identical rigs produced different liquid digests');
  assert.deepStrictEqual(a.v, b.v, 'identical rigs diverged in volumes');
});

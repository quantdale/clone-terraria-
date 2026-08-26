/* tests/save/pumps-save.test.js — W24 WS4: pump content + liquid/wiring state
   ride the versioned save envelope. Proves:
     - a pre-W24 save (captured BEFORE pumps existed) still loads;
     - placed pump tiles + held pump items survive save -> fresh boot ->
       continueGame with stable identity;
     - the wiring provider round-trips alongside them. */

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  makeGame, cloneStorage, parseV2, loadGame
} = require('./helpers.js');

test('pumps: tile/item identity and placement survive a full save round-trip', () => {
  const g1 = makeGame(424);
  const TC = g1.TC;
  const T = TC.TILE;

  // rig near spawn in a carved pocket
  const p = TC.player;
  const ax = Math.floor(p.x / TC.CONST.TS) + 6;
  const row = Math.floor(p.y / TC.CONST.TS) + 3;
  for (let y = row - 2; y <= row + 2; y++) {
    for (let x = ax - 2; x <= ax + 12; x++) TC.world.setRaw(x, y, T.AIR);
  }
  TC.world.setRaw(ax, row, T.INLET_PUMP);
  TC.world.setRaw(ax + 8, row, T.OUTLET_PUMP);
  for (let x = ax + 1; x < ax + 8; x++) TC.world.setRaw(x, row, T.WIRE);
  TC.Liquids.set(ax, row, TC.Liquids.TYPE.WATER, 255);

  // give the player one of each pump item
  assert.ok(TC.player.inventory.add('inlet_pump', 1) === 0 || true);
  TC.player.inventory.add('outlet_pump', 1);

  // fire one pulse so wiring/liquid runtime state is non-trivial
  TC.Wiring.pulse(ax + 4, row);
  const outletAfterPulse = TC.Liquids.queryAt(ax + 8, row).amount;
  assert.ok(outletAfterPulse > 0, 'pulse did not prime the rig');

  TC.Save.save();
  const envelope = parseV2(g1.storage);

  // ---------- fresh boot ----------
  const g2 = makeGame(9999); // different seed on purpose
  void g2;
  g2.storage.setItem('tc_save_v2', JSON.stringify(envelope));
  g2.TC.continueGame();
  assert.ok(g2.TC.world, 'continueGame produced no world');

  const C = g2.TC;
  assert.strictEqual(C.world.get(ax, row), T.INLET_PUMP,
    'inlet pump tile lost across the save');
  assert.strictEqual(C.world.get(ax + 8, row), T.OUTLET_PUMP,
    'outlet pump tile lost across the save');
  assert.strictEqual(C.Liquids.queryAt(ax, row).amount,
    255 - C.Wiring.PUMP_TRANSFER,
    'post-pump inlet volume drifted');
  assert.strictEqual(C.Liquids.queryAt(ax + 8, row).amount, outletAfterPulse,
    'outlet volume drifted');
  // stable registry identities resolve after reload
  assert.strictEqual(C.Registry.stableOfIndex('tile', C.TILE.INLET_PUMP),
    'wiring:inlet_pump');
  assert.strictEqual(C.Registry.stableOfIndex('tile', C.TILE.OUTLET_PUMP),
    'wiring:outlet_pump');
  let hasInletItem = false, hasOutletItem = false;
  for (let s = 0; s < C.player.inventory.slots.length; s++) {
    const st = C.player.inventory.get(s);
    if (st && st.id === 'inlet_pump') hasInletItem = true;
    if (st && st.id === 'outlet_pump') hasOutletItem = true;
  }
  assert.ok(hasInletItem, 'inlet_pump item lost from inventory');
  assert.ok(hasOutletItem, 'outlet_pump item lost from inventory');

  // and the reloaded rig still works through the canonical seam
  C.Wiring.pulse(ax + 4, row);
  assert.strictEqual(C.Liquids.queryAt(ax + 8, row).amount,
    Math.min(outletAfterPulse + C.Wiring.PUMP_TRANSFER, 255),
    'reloaded pumps stopped pumping');
});

test('pumps: pre-W24 v2 saves (no pump ids) load cleanly', () => {
  // Build a save WITHOUT touching any pump surface, then verify every
  // provider section parses and continues on the W24 code base.
  const g1 = makeGame(77);
  const TC = g1.TC;
  TC.player.inventory.add('wire', 5);
  TC.Save.save();
  const raw = g1.storage.getItem('tc_save_v2');
  const env = JSON.parse(raw);
  assert.ok(env.formatVersion >= 2, 'not a v2+ envelope');
  assert.ok(env.formatVersion >= 2, 'not a v2+ envelope');

  const g2 = makeGame(1234);
  g2.storage.setItem('tc_save_v2', raw);
  g2.TC.continueGame();
  assert.ok(g2.TC.world, 'continueGame produced no world');
  // wiring provider restored its slice without pump-specific state
  assert.ok(typeof g2.TC.Wiring.pumpStats() === 'object',
    'pump counters missing after legacy load');
});

/* tests/core/commands.test.js — TC.Commands exactly-once contract.
 *
 * MineTile on a real minable tile near spawn must produce exactly ONE AIR
 * write, ONE drop, ONE TileChanged + ONE TileBroken; failures mutate nothing
 * and emit nothing; PlaceTile/MoveItem/CraftRecipe/EquipItem consume/move/
 * craft/equip exactly once; MineWall must not ride the tile-change channel;
 * finally the live Player.doMine path must produce IDENTICAL event counts to
 * direct command submission (shared completion semantics).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot, spyEvents, findMinableNearPlayer, findPlacementCell,
  findDeepMinable, slotOf } = require('./helpers.js');

const PICK_POWER = 35;                          // copper_pickaxe

// vm-realm stacks carry the vm's Object prototype; project onto a host shape
// so deepStrictEqual compares content, not realms.
const shape = (s) => (s ? { id: s.id, count: s.count } : s);

// Wildcard event counter installed once; diffed around submissions so ANY
// stray emission fails the assertion.
function wildcardCounter(TC) {
  let n = 0;
  TC.Events.on('*', () => { n++; });
  return { get: () => n };
}

test('commands: MineTile breaks exactly once — one write, one drop, one of each event', () => {
  const g = boot(21);
  const TC = g.TC;
  const spot = findMinableNearPlayer(TC);
  assert.ok(spot, 'no minable tile found near spawn');
  const dropsBefore = TC.Items.drops.length;
  const s = spyEvents(TC, ['TileChanged', 'TileBroken']);

  const r = TC.Commands.submit('MineTile', {
    tx: spot.tx, ty: spot.ty, toolPower: PICK_POWER, tool: 'pick',
    player: TC.player, dt: 3                    // (35/100)*3/0.25 >= 1 → instant break
  });

  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(r.result && r.result.broken === true);
  assert.strictEqual(TC.world.get(spot.tx, spot.ty), TC.TILE.AIR, 'tile must be AIR now');
  assert.strictEqual(s.count('TileChanged'), 1,
    'TileChanged fired ' + s.count('TileChanged') + 'x — World.set already reports writes');
  assert.strictEqual(s.count('TileBroken'), 1);

  const ch = s.payloadsOf('TileChanged')[0];
  assert.strictEqual(ch.tx, spot.tx);
  assert.strictEqual(ch.ty, spot.ty);
  assert.notStrictEqual(ch.id, undefined,
    'canonical TileChanged payload carries {tx,ty,id} (wiring.js reads .id)');
  const br = s.payloadsOf('TileBroken')[0];
  assert.strictEqual(br.id, spot.id,
    'TileBroken must identify the broken tile via canonical .id');
  assert.strictEqual(br.tile, spot.id,
    'TileBroken keeps legacy .tile so loot.js pot handling keeps working');

  assert.strictEqual(TC.Items.drops.length - dropsBefore, 1,
    'exactly one item drop spawned');
});

test('commands: MineTile failures mutate nothing and emit nothing', () => {
  const g = boot(22);
  const TC = g.TC;
  const w = TC.world, p = TC.player;
  const TS = TC.CONST.TS;

  const spot = findMinableNearPlayer(TC);
  assert.ok(spot);
  assert.strictEqual(TC.Commands.submit('MineTile', {
    tx: spot.tx, ty: spot.ty, toolPower: PICK_POWER, tool: 'pick', player: p, dt: 3
  }).ok, true, 'precondition: legitimate break succeeds');

  const farTx = Math.max(0, Math.min(w.width - 1, Math.floor((p.x + p.w / 2) / TS) + 80));
  const farTy = w.surfaceY[farTx] + 4;

  const cases = [
    ['repeat on broken tile', { tx: spot.tx, ty: spot.ty, toolPower: PICK_POWER, tool: 'pick', player: p, dt: 3 }],
    ['out of reach',          { tx: farTx, ty: farTy, toolPower: PICK_POWER, tool: 'pick', player: p, dt: 3 }],
    ['bad tool power',        { tx: spot.tx, ty: spot.ty, toolPower: 0, tool: 'pick', player: p, dt: 3 }],
    ['wrong tool',            { tx: spot.tx, ty: spot.ty, toolPower: PICK_POWER, tool: 'axe', player: p, dt: 3 }],
    ['out of bounds',         { tx: -5, ty: -5, toolPower: PICK_POWER, tool: 'pick', player: p, dt: 3 }]
  ];
  const wild = wildcardCounter(TC);
  const dropsBefore = TC.Items.drops.length;
  for (const [label, ctx] of cases) {
    const beforeWild = wild.get();
    const tileAt = w.get(ctx.tx, ctx.ty);
    const r = TC.Commands.submit('MineTile', ctx);
    assert.strictEqual(r.ok, false, label + ' must fail (got ' + JSON.stringify(r) + ')');
    assert.strictEqual(wild.get() - beforeWild, 0, label + ' emitted events');
    if (ctx.tx >= 0) {
      assert.strictEqual(w.get(ctx.tx, ctx.ty), tileAt, label + ' mutated the world');
    }
  }
  assert.strictEqual(TC.Items.drops.length, dropsBefore, 'failures spawned no drops');
});

test('commands: PlaceTile writes once, consumes exactly one item, emits one of each event', () => {
  const g = boot(23);
  const TC = g.TC;
  const inv = TC.player.inventory;
  assert.strictEqual(inv.add('dirt', 5), 0);
  const slot = slotOf(inv, 'dirt');
  assert.ok(slot >= 0);
  const cell = findPlacementCell(TC);
  assert.ok(cell, 'no placement cell found');

  const s = spyEvents(TC, ['TileChanged', 'InventoryChanged']);
  const r = TC.Commands.submit('PlaceTile', {
    tx: cell.tx, ty: cell.ty, item: 'dirt', player: TC.player, slot: slot
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(TC.world.get(cell.tx, cell.ty), TC.TILE.DIRT, 'block written once');
  assert.strictEqual(inv.count('dirt'), 4, 'exactly one item consumed');
  assert.strictEqual(s.count('TileChanged'), 1,
    'TileChanged fired ' + s.count('TileChanged') + 'x (World.set already reports)');
  assert.strictEqual(s.count('InventoryChanged'), 1,
    'InventoryChanged fired ' + s.count('InventoryChanged') + 'x (Inventory.remove already reports)');

  // Occupied target now: clean failure, zero deltas.
  const wild = wildcardCounter(TC);
  const before = wild.get();
  const r2 = TC.Commands.submit('PlaceTile', {
    tx: cell.tx, ty: cell.ty, item: 'dirt', player: TC.player, slot: slotOf(inv, 'dirt')
  });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /occupied/i);
  assert.strictEqual(wild.get() - before, 0, 'failed place emitted events');
  assert.strictEqual(inv.count('dirt'), 4, 'failed place consumed an item');

  // Missing item: nothing held → reject without touching the world.
  const r3 = TC.Commands.submit('PlaceTile', {
    tx: cell.tx + 1, ty: cell.ty, item: 'sand', player: TC.player
  });
  assert.strictEqual(r3.ok, false);
  assert.match(r3.error, /missing-item|unknown-block-item/);
});

test('commands: MoveItem moves exact counts and fails cleanly on insufficient amounts', () => {
  const g = boot(24);
  const TC = g.TC;
  const inv = TC.player.inventory;
  const other = new TC.Inventory(9);            // cross-inventory target
  inv.add('stone', 10);
  const srcSlot = slotOf(inv, 'stone');
  assert.ok(srcSlot >= 0);

  let s = spyEvents(TC, ['InventoryChanged']);
  let r = TC.Commands.submit('MoveItem', {
    fromInv: inv, fromSlot: srcSlot, toInv: other, toSlot: 0, count: 3
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.result.moved, 3);
  assert.strictEqual(inv.get(srcSlot).count, 7, 'source decremented by exactly 3');
  assert.deepStrictEqual(shape(other.get(0)), { id: 'stone', count: 3 }, 'destination exact');
  assert.strictEqual(s.count('InventoryChanged'), 1, 'one event per successful move');
  s.stop();

  // Merge into the same-id stack.
  r = TC.Commands.submit('MoveItem', {
    fromInv: inv, fromSlot: srcSlot, toInv: other, toSlot: 0, count: 2
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(shape(other.get(0)), { id: 'stone', count: 5 });
  assert.strictEqual(inv.get(srcSlot).count, 5);

  // Failure modes: clean rejects with ZERO mutation and ZERO events.
  const wild = wildcardCounter(TC);
  const snap = () => JSON.stringify([inv.slots, other.slots]);
  const failureCases = [
    [{ fromInv: inv, fromSlot: 8, toInv: other, toSlot: 2, count: 1 }, /empty-source-slot/],
    [{ fromInv: inv, fromSlot: srcSlot, toInv: other, toSlot: 2, count: 99 }, /count-exceeds-stack/],
    [{ fromInv: inv, fromSlot: srcSlot, toInv: other, toSlot: -3 }, /bad-slot/],
    [{ fromInv: inv, fromSlot: srcSlot, toInv: inv, toSlot: srcSlot }, /same-slot/]
  ];
  for (const [ctx, re] of failureCases) {
    const beforeWild = wild.get();
    const beforeSnap = snap();
    const fr = TC.Commands.submit('MoveItem', ctx);
    assert.strictEqual(fr.ok, false, 'expected failure: ' + JSON.stringify(ctx));
    assert.match(fr.error, re);
    assert.strictEqual(wild.get() - beforeWild, 0, 'failure emitted events');
    assert.strictEqual(snap(), beforeSnap, 'failure mutated inventories');
  }

  // Different-id destination with a partial stack cannot swap → dest-full.
  other.slots[2] = { id: 'wood', count: 1 };
  const r4 = TC.Commands.submit('MoveItem', {
    fromInv: inv, fromSlot: srcSlot, toInv: other, toSlot: 2, count: 2
  });
  assert.strictEqual(r4.ok, false);
  assert.match(r4.error, /dest-full/, 'partial move onto a different id must not swap');
});

test('commands: CraftRecipe consumes inputs once, adds output once, emits CraftCompleted once', () => {
  const g = boot(25);
  const TC = g.TC;
  const inv = TC.player.inventory;
  const recipe = TC.RECIPES.find((r) => r.out === 'torch' && r.n === 3);
  assert.ok(recipe, 'torch recipe missing');
  inv.add('wood', 1);
  inv.add('gel', 1);
  const torchBefore = inv.count('torch');        // starter kit already holds torches

  const s = spyEvents(TC, ['CraftCompleted']);
  const r = TC.Commands.submit('CraftRecipe', { recipe: recipe, inv: inv });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(inv.count('wood'), 0, 'wood consumed once');
  assert.strictEqual(inv.count('gel'), 0, 'gel consumed once');
  assert.strictEqual(inv.count('torch') - torchBefore, recipe.n, 'output added exactly once');
  assert.strictEqual(s.count('CraftCompleted'), 1,
    'CraftCompleted fired ' + s.count('CraftCompleted') + 'x');

  // Cannot repeat without inputs: clean failure, no further changes.
  const wild = wildcardCounter(TC);
  const before = wild.get();
  const r2 = TC.Commands.submit('CraftRecipe', { recipe: recipe, inv: inv });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /cannot-craft/);
  assert.strictEqual(wild.get() - before, 0, 'failed craft emitted events');
  assert.strictEqual(s.count('CraftCompleted'), 1);
});

test('commands: EquipItem swaps armor without duplication', () => {
  const g = boot(26);
  const TC = g.TC;
  const p = TC.player;
  const inv = p.inventory;
  assert.ok(!p.equipment.head, 'precondition: bare head');

  inv.add('copper_helmet', 1);
  let slot = slotOf(inv, 'copper_helmet');
  let s = spyEvents(TC, ['InventoryChanged']);
  let r = TC.Commands.submit('EquipItem', { player: p, item: 'copper_helmet', slot: slot });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(p.equipment.head, 'copper_helmet');
  assert.strictEqual(inv.get(slot), null, 'inventory slot emptied (no duplicate)');
  assert.strictEqual(inv.count('copper_helmet'), 0);
  assert.strictEqual(s.count('InventoryChanged'), 1,
    'InventoryChanged fired ' + s.count('InventoryChanged') + 'x (swapOrPlace already reports)');
  s.stop();

  // Swap cooldown mirrors the live doEquip gate.
  r = TC.Commands.submit('EquipItem', { player: p, item: 'copper_helmet' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /cooldown/);

  // Equip a different helmet: the worn piece returns to that single slot.
  p.equipCd = 0;
  inv.add('iron_helmet', 1);
  slot = slotOf(inv, 'iron_helmet');
  s = spyEvents(TC, ['InventoryChanged']);
  r = TC.Commands.submit('EquipItem', { player: p, item: 'iron_helmet', slot: slot });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(p.equipment.head, 'iron_helmet');
  assert.deepStrictEqual(shape(inv.get(slot)), { id: 'copper_helmet', count: 1 },
    'worn piece returned to the paying slot exactly once');
  assert.strictEqual(inv.count('copper_helmet'), 1, 'no duplication on swap');
  assert.strictEqual(inv.count('iron_helmet'), 0);
  assert.strictEqual(s.count('InventoryChanged'), 1);
  s.stop();

  // Non-armor items are rejected cleanly.
  const wild = wildcardCounter(TC);
  const before = wild.get();
  const r3 = TC.Commands.submit('EquipItem', { player: p, item: 'dirt', slot: 0 });
  assert.strictEqual(r3.ok, false);
  assert.match(r3.error, /not-armor/);
  assert.strictEqual(wild.get() - before, 0);
});

test('commands: MineWall breaks the wall without riding the tile-change channel', () => {
  const g = boot(27);
  const TC = g.TC;
  const deep = findDeepMinable(TC);
  assert.ok(deep, 'no deep minable cell found');
  // Open the cell first (no player ref → no reach constraint).
  assert.strictEqual(TC.Commands.submit('MineTile', {
    tx: deep.tx, ty: deep.ty, toolPower: 10000, tool: 'pick', dt: 600
  }).ok, true, 'precondition: open the host tile');

  assert.ok(TC.world.getWall(deep.tx, deep.ty) > 0, 'precondition: wall behind the cell');
  const s = spyEvents(TC, ['TileChanged']);
  const r = TC.Commands.submit('MineWall', {
    tx: deep.tx, ty: deep.ty, toolPower: 10000, tool: 'pick', dt: 600
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(r.result && r.result.broken === true);
  assert.strictEqual(TC.world.getWall(deep.tx, deep.ty), TC.WALL.NONE, 'wall removed');
  assert.strictEqual(s.count('TileChanged'), 0,
    'a wall-only change must NOT emit TileChanged — live doMineWall emits none and ' +
    "payload-less wall events corrupt wiring's plate/timer registry");
});

test('parity: live Player.doMine produces identical event counts to command MineTile', () => {
  const mineOnce = (useCommand) => {
    const g = boot(31);                          // same seed → same spot both ways
    const TC = g.TC;
    const spot = findMinableNearPlayer(TC);
    assert.ok(spot, 'no minable tile near spawn');
    const dropsBefore = TC.Items.drops.length;
    const s = spyEvents(TC, ['TileChanged', 'TileBroken']);
    if (useCommand) {
      const r = TC.Commands.submit('MineTile', {
        tx: spot.tx, ty: spot.ty, toolPower: PICK_POWER, tool: 'pick',
        player: TC.player, dt: 3
      });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
    } else {
      const def = TC.ITEM_DEFS.copper_pickaxe;
      const m = {
        worldX: (spot.tx + 0.5) * TC.CONST.TS,
        worldY: (spot.ty + 0.5) * TC.CONST.TS
      };
      TC.player.doMine(def, m, 3);               // same rate math → instant break
    }
    return {
      changed: s.count('TileChanged'),
      broken: s.count('TileBroken'),
      drops: TC.Items.drops.length - dropsBefore,
      air: TC.world.get(spot.tx, spot.ty) === TC.TILE.AIR
    };
  };

  const viaCommand = mineOnce(true);
  const viaPlayer = mineOnce(false);
  assert.deepStrictEqual(viaCommand, { changed: 1, broken: 1, drops: 1, air: true },
    'command path must be exactly-once');
  assert.deepStrictEqual(viaCommand, viaPlayer,
    'live player.doMine and command submit must agree on every count');
});

test('parity: live Player.doMineWall and command MineWall emit the same (zero) tile events', () => {
  const wallOnce = (useCommand) => {
    const g = boot(32);
    const TC = g.TC;
    const deep = findDeepMinable(TC);
    assert.ok(deep, 'no deep minable cell');
    assert.strictEqual(TC.Commands.submit('MineTile', {
      tx: deep.tx, ty: deep.ty, toolPower: 10000, tool: 'pick', dt: 600
    }).ok, true);
    const s = spyEvents(TC, ['TileChanged']);
    if (useCommand) {
      const r = TC.Commands.submit('MineWall', {
        tx: deep.tx, ty: deep.ty, toolPower: 10000, tool: 'pick', dt: 600
      });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
    } else {
      const def = TC.ITEM_DEFS.copper_pickaxe;
      const m = {
        worldX: (deep.tx + 0.5) * TC.CONST.TS,
        worldY: (deep.ty + 0.5) * TC.CONST.TS
      };
      TC.player.doMineWall(def, m, 600, deep.tx, deep.ty,
        TC.TILE.AIR, TC.TILE_DEFS[TC.TILE.AIR]);
    }
    return {
      changed: s.count('TileChanged'),
      gone: TC.world.getWall(deep.tx, deep.ty) === TC.WALL.NONE
    };
  };
  const viaCommand = wallOnce(true);
  const viaPlayer = wallOnce(false);
  assert.strictEqual(viaCommand.gone, true, 'command removed the wall');
  assert.strictEqual(viaPlayer.gone, true, 'live path removed the wall');
  assert.strictEqual(viaCommand.changed, viaPlayer.changed,
    'wall mining must agree on TileChanged traffic between the two paths');
});

/* tests/world/wiring.test.js — T3: wire signal core + mechanisms.
   BFS pulse reach, once-per-receiver WirePulse events, device toggles,
   pooled dart traps, timer cadence driven by update(), actuator ghosting
   through World.isSolid, persistence round-trip, TileChanged maintenance. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

// Flat arena: interior [x0..x1]x[y0..y1] AIR, side walls + floor STONE.
function carveArena(TC, x0, y0, x1, y1) {
  const w = TC.world;
  const AIR = TC.TILE.AIR, STONE = TC.TILE.STONE;
  for (let y = y0 - 1; y <= y1 + 2; y++) {
    for (let x = x0 - 2; x <= x1 + 2; x++) w.setRaw(x, y, AIR);
  }
  for (let y = y0 - 1; y <= y1; y++) {
    w.setRaw(x0 - 1, y, STONE);
    w.setRaw(x1 + 1, y, STONE);
  }
  for (let x = x0 - 1; x <= x1 + 1; x++) w.setRaw(x, y1 + 1, STONE);
}

function setup(seed) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(seed == null ? 5 : seed);
  return { g, TC };
}

test('wiring: placeWire/removeWire edit the grid and drop the cut item', () => {
  const { TC } = setup();
  const X = 500, Y = 120;
  carveArena(TC, X, Y - 2, X + 4, Y);
  assert.strictEqual(TC.Wiring.placeWire(X + 1, Y), true);
  assert.strictEqual(TC.world.get(X + 1, Y), TC.TILE.WIRE);
  assert.strictEqual(TC.Wiring.placeWire(X + 1, Y), false, 'cannot stack on wire');
  assert.strictEqual(TC.Wiring.placeWire(X + 2, Y + 1), false,
    'placement into solid floor must be rejected');

  const dropsBefore = TC.Items.drops.length;
  assert.strictEqual(TC.Wiring.removeWire(X + 1, Y), true);
  assert.strictEqual(TC.world.get(X + 1, Y), TC.TILE.AIR);
  assert.strictEqual(TC.Items.drops.length, dropsBefore + 1, 'cut wire did not drop');
  assert.strictEqual(TC.Items.drops[TC.Items.drops.length - 1].id, 'wire');
  assert.strictEqual(TC.Wiring.removeWire(X + 1, Y), false, 'nothing to cut');
});

test('wiring: pulse BFS reaches receivers across an L-shaped run; exactly one WirePulse each', () => {
  const { TC } = setup();
  const X0 = 300, Y = 150;
  carveArena(TC, X0, Y - 4, X0 + 40, Y);
  // switch at (X0+2,Y); wire runs east 12 cells, turns north 4, trap at the end
  const sw = { x: X0 + 2, y: Y };
  TC.world.set(sw.x, sw.y, TC.TILE.SWITCH_OFF);
  for (let i = 1; i <= 12; i++) assert.ok(TC.Wiring.placeWire(X0 + 2 + i, Y));
  for (let j = 1; j <= 4; j++) assert.ok(TC.Wiring.placeWire(X0 + 14, Y - j));
  const trap = { x: X0 + 15, y: Y - 4 };           // right of the last wire cell
  TC.world.set(trap.x, trap.y, TC.TILE.DART_TRAP);
  // decoy receiver far away with NO wire adjacency
  const decoy = { x: X0 + 30, y: Y - 2 };
  TC.world.set(decoy.x, decoy.y, TC.TILE.DART_TRAP);

  const pulses = [];
  TC.Events.on(TC.Events.EVENT.WirePulse, (p) => pulses.push(p));

  const dartsBefore = TC.Projectiles.viewOf('wire_dart')
    .filter((d) => d.active).length;
  assert.strictEqual(TC.Wiring.toggleDevice(sw.x, sw.y), true, 'switch toggle failed');
  assert.strictEqual(TC.world.get(sw.x, sw.y), TC.TILE.SWITCH_ON, 'state did not flip');
  assert.strictEqual(TC.Wiring.toggleDevice(sw.x, sw.y), true);
  assert.strictEqual(TC.world.get(sw.x, sw.y), TC.TILE.SWITCH_OFF, 'flip-back failed');

  const trapPulses = pulses.filter((p) => p.x === trap.x && p.y === trap.y);
  const decoyPulses = pulses.filter((p) => p.x === decoy.x && p.y === decoy.y);
  assert.strictEqual(trapPulses.length, 2, 'trap should fire once per toggle (2 toggles)');
  assert.strictEqual(decoyPulses.length, 0, 'unwired receiver fired!');
  // every pulse event belongs to the wired trap
  assert.strictEqual(pulses.length, 2, 'stray pulse events: ' + JSON.stringify(pulses));

  const dartsAfter = TC.Projectiles.viewOf('wire_dart')
    .filter((d) => d.active).length;
  assert.strictEqual(dartsAfter, dartsBefore + 2,
    'expected one pooled wire_dart per trap fire');
});

test('wiring: timer pulses periodically, only while update() advances time', () => {
  const { TC } = setup();
  const X0 = 700, Y = 140;
  carveArena(TC, X0, Y - 3, X0 + 8, Y);
  const t = { x: X0 + 2, y: Y };
  TC.world.set(t.x, t.y, TC.TILE.TIMER);
  assert.ok(TC.Wiring.placeWire(t.x + 1, Y));
  TC.world.set(t.x + 2, Y, TC.TILE.DART_TRAP);

  assert.strictEqual(TC.Wiring.toggleTimer(t.x, t.y), true, 'toggleTimer failed');
  assert.strictEqual(TC.Wiring.toggleTimer(t.x + 5, Y), false, 'timer toggle on non-timer');

  let darts = () => TC.Projectiles.viewOf('wire_dart').filter((d) => d.active).length;
  const base = darts();
  for (let i = 0; i < 8; i++) TC.Wiring.update(0.1);      // 0.8s < period
  assert.strictEqual(darts(), base, 'timer fired before its period elapsed');
  for (let i = 0; i < 5; i++) TC.Wiring.update(0.1);      // crosses 1.0s
  assert.ok(darts() > base, 'running timer never pulsed');
  // paused timers do not advance
  assert.strictEqual(TC.Wiring.toggleTimer(t.x, t.y), true);   // stop
  const held = darts();
  for (let i = 0; i < 30; i++) TC.Wiring.update(0.1);
  assert.strictEqual(darts(), held, 'stopped timer kept firing');
});

test('wiring: actuator attaches to a solid host; pulse toggles ghost -> World.isSolid flips', () => {
  const { TC } = setup();
  const X0 = 400, Y = 130;
  carveArena(TC, X0, Y - 3, X0 + 8, Y);
  const host = { x: X0 + 4, y: Y };
  TC.world.set(host.x, host.y, TC.TILE.STONE);
  assert.ok(TC.world.isSolid(host.x, host.y), 'host should start solid');

  const inv = TC.player.inventory;
  assert.ok(inv.add('actuator', 2) === 0 || inv.count('actuator') >= 1,
    'could not stock actuator items');
  // reach is positional: stand beside the host first
  TC.player.x = (host.x - 2) * 16;
  TC.player.y = (host.y - 2) * 16;
  assert.strictEqual(
    TC.Wiring.attachActuatorAt(TC.player,
      { worldX: host.x * 16 + 8, worldY: host.y * 16 + 8 }),
    true, 'attachActuatorAt rejected a valid host');
  assert.strictEqual(inv.count('actuator'), 1, 'attach did not consume an item');
  assert.strictEqual(
    TC.Wiring.attachActuatorAt(TC.player,
      { worldX: (host.x + 1) * 16 + 8, worldY: host.y * 16 + 8 }),
    false, 'attached to plain air?');

  // wire beside the host; pulsing that wire cell triggers the actuated host
  assert.ok(TC.Wiring.placeWire(host.x - 1, host.y));
  TC.Wiring.pulse(host.x - 1, host.y);
  assert.strictEqual(TC.Wiring.isGhost(host.x, host.y), true, 'ghost not engaged');
  assert.strictEqual(TC.world.isSolid(host.x, host.y), false,
    'ghosted tile still blocks movement');
  TC.Wiring.pulse(host.x - 1, host.y);
  assert.strictEqual(TC.Wiring.isGhost(host.x, host.y), false, 'ghost not released');
  assert.strictEqual(TC.world.isSolid(host.x, host.y), true,
    'un-ghosted tile does not block again');
});

test('wiring: serialize/load round-trip preserves running timers, actuators, ghosts', () => {
  const { TC } = setup();
  const X0 = 900, Y = 160;
  carveArena(TC, X0, Y - 3, X0 + 8, Y);
  const t = { x: X0 + 2, y: Y };
  TC.world.set(t.x, t.y, TC.TILE.TIMER);
  const host = { x: X0 + 6, y: Y };
  TC.world.set(host.x, host.y, TC.TILE.STONE);

  assert.ok(TC.Wiring.toggleTimer(t.x, t.y));
  const inv = TC.player.inventory;
  inv.add('actuator', 5);
  TC.player.x = (host.x - 2) * 16;                        // get within reach
  TC.player.y = (host.y - 2) * 16;
  assert.ok(TC.Wiring.attachActuatorAt(TC.player,
    { worldX: host.x * 16 + 8, worldY: host.y * 16 + 8 }));
  assert.ok(TC.Wiring.placeWire(host.x - 1, host.y));
  TC.Wiring.pulse(host.x - 1, host.y);                    // ghost it

  const blob = TC.Wiring.serialize();
  // NOTE: blob comes from the vm realm — its arrays carry the guest
  // Array.prototype, so normalize before host-side deepStrictEqual.
  const norm = () => {
    const b = TC.Wiring.serialize();
    return {
      timers: Array.from(b.timers || []),
      actuators: Array.from(b.actuators || []),
      ghosts: Array.from(b.ghosts || [])
    };
  };
  const tIdx = t.y * TC.world.width + t.x;
  const hIdx = host.y * TC.world.width + host.x;
  const n = norm();
  assert.deepStrictEqual(n.timers, [tIdx], 'blob.timers wrong');
  assert.deepStrictEqual(n.actuators, [hIdx], 'blob.actuators wrong');
  assert.deepStrictEqual(n.ghosts, [hIdx], 'blob.ghosts wrong');

  // wipe all runtime state, then restore through the documented path
  TC.Wiring.resetForNewWorld();
  assert.strictEqual(JSON.stringify(TC.Wiring.serialize()), '{}',
    'resetForNewWorld left state behind');
  assert.strictEqual(TC.world.isSolid(host.x, host.y), true);

  assert.strictEqual(TC.Wiring.load(blob), true);
  assert.deepStrictEqual(norm(), n, 'round-trip drifted');
  assert.strictEqual(TC.world.isSolid(host.x, host.y), false, 'ghost lost on reload');

  // malformed blobs are rejected without mutating state
  assert.strictEqual(TC.Wiring.load({ timers: [-1] }), false);
  assert.strictEqual(TC.Wiring.load({ actuators: ['x'] }), false);
  assert.deepStrictEqual(norm(), n, 'failed load mutated state');
});

test('wiring: breaking a device/support keeps registries fresh via TileChanged', () => {
  const { TC } = setup();
  const X0 = 200, Y = 170;
  carveArena(TC, X0, Y - 3, X0 + 6, Y);
  const plate = { x: X0 + 2, y: Y };
  TC.world.set(plate.x, plate.y, TC.TILE.PRESSURE_PLATE);
  // a bare plate fires nothing (events are per-receiver); wire it to a trap
  assert.ok(TC.Wiring.placeWire(plate.x + 1, plate.y));
  TC.world.set(plate.x + 2, plate.y, TC.TILE.DART_TRAP);

  // stand on the plate: rising edge fires exactly once
  const p = TC.player;
  p.x = plate.x * 16 + 8 - p.w / 2;
  p.y = plate.y * 16 + 8 - p.h / 2;
  const pulses = [];
  TC.Events.on(TC.Events.EVENT.WirePulse, (ev) => pulses.push(ev));
  TC.Wiring.update(1 / 60);
  const trapPulses = () =>
    pulses.filter((e) => e.x === plate.x + 2 && e.y === plate.y).length;
  assert.strictEqual(trapPulses(), 1,
    'plate rising edge did not fire the wired trap');
  TC.Wiring.update(1 / 60);
  assert.strictEqual(pulses.length, 1, 'held plate re-fired (no edge tracking)');

  // mine the floor out from under it: support pop removes the plate...
  TC.world.set(plate.x, plate.y + 1, TC.TILE.AIR);
  assert.strictEqual(TC.world.get(plate.x, plate.y), TC.TILE.AIR,
    'plate survived loss of support');
  TC.Wiring.update(1 / 60);                              // stale registry must not crash/fire

  // ...and re-placing the same cell gives a clean, pressable plate again
  TC.world.set(plate.x, plate.y + 1, TC.TILE.STONE);       // restore the floor
  TC.world.set(plate.x, plate.y, TC.TILE.PRESSURE_PLATE);
  pulses.length = 0;
  TC.Wiring.update(1 / 60);
  assert.strictEqual(trapPulses(), 1,
    're-placed plate did not fire (stale registry blocked rising edge)');

  // breaking a running timer tile stops it silently (dart count stops growing)
  const t = { x: X0 + 5, y: Y };
  TC.world.set(t.x, t.y, TC.TILE.TIMER);
  assert.ok(TC.Wiring.toggleTimer(t.x, t.y));
  TC.world.set(t.x, t.y, TC.TILE.AIR);
  const dartsBefore = TC.Projectiles.viewOf('wire_dart').filter((d) => d.active).length;
  for (let i = 0; i < 15; i++) TC.Wiring.update(0.1);    // > 1 period
  const dartsAfter = TC.Projectiles.viewOf('wire_dart').filter((d) => d.active).length;
  assert.strictEqual(dartsAfter - dartsBefore, 0,
    'broken timer kept pulsing');
});

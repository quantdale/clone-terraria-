/* tests/net/mechanisms-multiplayer.test.js — W24 WS3: wiring mechanisms are
   authoritative over EVERY registered player, not just the primary singleton.
     - pressure plates see remote players (rising edge fires exactly once);
     - wire-toggled doors refuse to close into ANY live player's hitbox;
     - trap darts damage the actual victim — a remote player can never
       redirect damage onto the host/primary pawn. */

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame, makeDriver, msg } = require('./helpers.js');

const TS = 16;

function freshServer(seed) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed: seed == null ? 5150 : seed });
  assert.ok(server.start().ok);
  return { TC, server };
}

function join(server, driver, name) {
  server.connect(driver.ep, { name });
  driver.ep.feed(msg("hello", { name }));
  server.processInbound();
  return driver.outbox.find((m) => m.t === "welcome").p.you.pid;
}

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

// Park a player so their hitbox stands on tile (tx,ty).
function standOn(p, tx, ty) {
  p.x = tx * TS + (TS - p.w) / 2;
  p.y = (ty + 1) * TS - p.h - 0.01;
}

test("mechanisms: a remote player's weight fires a pressure plate exactly once", () => {
  const { TC, server } = freshServer(5151);
  const pidB = join(server, makeDriver(), "Remote");
  const pb = TC.Players.get(pidB);

  const X = 400, Y = 130;
  carveArena(TC, X, Y - 4, X + 12, Y);
  // inlet | wire run ... | outlet on row Y; plate ON TOP of the wire at X+5
  const T = TC.TILE, w = TC.world;
  w.setRaw(X + 1, Y, T.INLET_PUMP);
  w.setRaw(X + 10, Y, T.OUTLET_PUMP);
  for (let x = X + 2; x <= X + 9; x++) w.setRaw(x, Y, T.WIRE);
  w.setRaw(X + 5, Y - 1, T.PRESSURE_PLATE);
  TC.Liquids.set(X + 1, Y, TC.Liquids.TYPE.WATER, 255);
  TC.Wiring.resetForNewWorld();

  const outAmt = () => TC.Liquids.queryAt(X + 10, Y).amount;
  assert.strictEqual(outAmt(), 0, "rig leaked before any press");

  // remote player steps onto the plate: rising edge fires exactly one batch
  standOn(pb, X + 5, Y - 1);
  TC.Wiring.update(1 / 60);
  const first = outAmt();
  assert.strictEqual(first, TC.Wiring.PUMP_TRANSFER,
    "plate did not see the REMOTE player (moved " + first + ")");

  // held press never re-fires
  for (let i = 0; i < 30; i++) TC.Wiring.update(1 / 60);
  assert.strictEqual(outAmt(), first, "plate re-fired while continuously held");

  // release, then step back on: exactly one more batch
  pb.x += 4 * TS;
  TC.Wiring.update(1 / 60); // falling edge
  assert.strictEqual(outAmt(), first, "release pulsed");
  pb.x -= 4 * TS;
  TC.Wiring.update(1 / 60); // second rising edge
  assert.strictEqual(outAmt(), Math.min(2 * TC.Wiring.PUMP_TRANSFER, 255),
    "second press moved " + outAmt());
  server.stop();
});

function countTrapDarts(TC) {
  if (!TC.Projectiles || typeof TC.Projectiles.viewOf !== "function") return 0;
  let n = 0;
  const view = TC.Projectiles.viewOf("wire_dart");
  for (const d of view) if (d.active && d.owner == null) n++;
  return n;
}

test("mechanisms: a wire pulse never closes a door into a REMOTE player", () => {
  const { TC, server } = freshServer(5152);
  join(server, makeDriver(), "Host");
  const pidB = join(server, makeDriver(), "Doorblocker");
  const pb = TC.Players.get(pidB);

  const X = 420, Y = 128;
  carveArena(TC, X, Y - 3, X + 8, Y);
  // lever at (X+2,Y), wire east, OPEN door at (X+6,Y)
  TC.world.set(X + 2, Y, TC.TILE.LEVER_OFF);
  for (let x = X + 3; x <= X + 5; x++) assert.ok(TC.Wiring.placeWire(x, Y));
  TC.world.set(X + 6, Y, TC.TILE.DOOR_OPEN);
  TC.Wiring.resetForNewWorld();

  standOn(pb, X + 6, Y); // remote stands IN the doorway

  TC.Wiring.pulse(X + 2, Y); // lever flip pulse
  assert.strictEqual(TC.world.get(X + 6, Y), TC.TILE.DOOR_OPEN,
    "door closed into a remote player");

  // control: with the doorway clear, the same pulse closes it
  pb.x += 3 * TS;
  TC.Wiring.pulse(X + 2, Y);
  assert.strictEqual(TC.world.get(X + 6, Y), TC.TILE.DOOR_CLOSED,
    "door refused to close on an empty doorway");
  // and it reopens through wire as well
  TC.Wiring.pulse(X + 2, Y);
  assert.strictEqual(TC.world.get(X + 6, Y), TC.TILE.DOOR_OPEN);
  server.stop();
});

test("mechanisms: trap darts hit the actual victim — never the primary by proxy", () => {
  const { TC, server } = freshServer(5153);
  const pidA = join(server, makeDriver(), "Primary");
  const pidB = join(server, makeDriver(), "Victim");
  const pa = TC.Players.get(pidA);
  const pb = TC.Players.get(pidB);

  const X = 300, Y = 140;
  carveArena(TC, X, Y - 3, X + 20, Y);
  // wall off the trap's left face so facing resolves RIGHT deterministically
  TC.world.setRaw(X + 1, Y, TC.TILE.STONE);
  TC.world.set(X + 2, Y, TC.TILE.DART_TRAP);
  TC.Wiring.resetForNewWorld();

  // victim stands mid-lane INSIDE the dart's flight row; primary sits above
  // the corridor entirely
  pb.x = (X + 10) * TS;
  pb.y = Y * TS + (TS - pb.h) / 2;
  pa.x = (X + 16) * TS;
  pa.y = (Y - 6) * TS;
  pa.iframes = 0;
  pb.iframes = 0;
  const hpA0 = pa.hp, hpB0 = pb.hp;

  TC.Wiring.pulse(X + 1, Y); // fire the trap
  let guard = 240;
  // the pool owns dart flight; wiring owns the per-tick player-contact pass
  while (guard-- > 0 && pb.hp === hpB0) {
    TC.Projectiles.update(1 / 60);
    TC.Wiring.update(1 / 60);
  }

  assert.ok(pb.hp < hpB0,
    "remote victim took no damage (darts missed the registered roster)");
  assert.strictEqual(pa.hp, hpA0,
    "primary pawn damaged for a remote player's trap hit");
  server.stop();
});

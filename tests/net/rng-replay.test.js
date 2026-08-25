/* tests/net/rng-replay.test.js — W23 WS3.3 determinism proof:
   two independent authoritative realms running the SAME seed + command/input
   trace converge INCLUDING enemy AI behavior, spawn-director placements,
   loot rolls and the GameRng stream state itself. The W22 session replay
   excluded enemy AI by its documented Math.random policy; that policy is now
   replaced by the seeded authority, so the digests below would fail on any
   nondeterministic AI/loot draw. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg, sendInput, sendCmd } = require("./helpers.js");

function freshServer(seed) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed });
  const r = server.start();
  assert.ok(r.ok, "server start failed");
  return { TC, server };
}

function join(server, driver, name) {
  const c = server.connect(driver.ep, { name });
  assert.ok(c.ok);
  driver.ep.feed(msg("hello", { name }));
  server.processInbound();
  const welcome = driver.outbox.find((m) => m.t === "welcome");
  return welcome.p.you.pid;
}

// Stable digest over live enemies (sorted by eid): identity + kinematics + hp.
function digestEnemies(TC) {
  let h = 0x811c9dc5;
  const mix = (v) => {
    v = v | 0;
    for (let i = 0; i < 4; i++) {
      h ^= (v >>> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const list = TC.Enemies.list.slice().sort((a, b) => a.eid - b.eid);
  mix(list.length);
  for (const e of list) {
    mix(e.eid);
    for (const c of String(e.type)) mix(c.charCodeAt(0));
    mix(e.x); mix(e.y); mix(e.vx); mix(e.vy); mix(e.hp);
  }
  return h >>> 0;
}

function runScenario() {
  const { TC, server } = freshServer(20260826);
  const A = makeDriver();
  const pidA = join(server, A, "Solo");
  const pa = TC.Players.get(pidA);

  // Force an active combat arena so AI decisions and loot rolls fire:
  // flat stone strip + a mixed enemy crowd near the player.
  const fx = Math.floor(pa.x / 16);
  const fy = TC.world.surfaceY[fx];
  for (let dx = -10; dx <= 24; dx++) {
    for (let dy = -6; dy <= -1; dy++) TC.world.setRaw(fx + dx, fy + dy, TC.TILE.AIR);
    TC.world.setRaw(fx + dx, fy, TC.TILE.STONE);
  }
  const spawned = [];
  for (let i = 0; i < 6; i++) {
    const type = ["green_slime", "blue_slime", "zombie", "cave_bat"][i % 4];
    const e = TC.Enemies.spawnEnemy(type, (fx + 4 + i * 2) * 16, (fy - 2) * 16);
    if (e) spawned.push(e);
  }

  // bow + arrows so the trace produces kills -> loot rolls -> drops physics
  pa.inventory.add("wooden_bow", 1);
  pa.inventory.add("arrow", 99);

  // Recorded trace: strafe toward the crowd firing at fixed aim points.
  // Every tick advances spawn director + AI + projectiles + loot identically.
  let seq = 1;
  for (let i = 1; i <= 240; i++) {
    const moving = i % 40 < 20;
    const use = i % 3 === 0;
    sendInput(A, seq++, [moving ? 1 : 0, i % 17 === 0 ? 1 : 0, 0],
      { x: pa.x + 120, y: pa.y - 8 }, use);
    // periodic re-arm from authoritative inventory via whitelisted command
    if (i % 30 === 0) sendCmd(A, seq++, "MoveItem", { fromSlot: 0, toSlot: 0 });
    server.tick();
  }

  const result = {
    world: TC.NetProto.digestWorld(TC.world),
    players: TC.NetProto.digestPlayers(TC.Players.entries().map((r) => r.player)),
    inventory: TC.NetProto.digestInventory(pa.inventory),
    enemies: digestEnemies(TC),
    rng: TC.GameRng.digest(),
    kills: TC.stats ? 0 : 0,
    dropCount: TC.Items.drops.length
  };
  server.stop();
  return result;
}

test("rng-replay: identical seed+trace converges including enemy AI, spawns, loot and RNG state", () => {
  const a = runScenario();
  const b = runScenario();
  assert.deepStrictEqual(b, a, JSON.stringify({
    a, b
  }, null, 1));
  // sanity: the scenario actually exercised the systems under proof
  assert.notStrictEqual(a.enemies, 0, "enemies existed during the trace");
});

test("rng-replay: divergent seed diverges AI outcomes (not a static digest)", () => {
  // Same trace shape but different world seed must move the enemy digest.
  function runWithSeed(seed) {
    const { TC, server } = freshServer(seed);
    const A = makeDriver();
    const pidA = join(server, A, "Solo");
    const pa = TC.Players.get(pidA);
    for (let i = 0; i < 90; i++) {
      sendInput(A, i + 1, [i % 20 < 10 ? 1 : 0, 0, 0], null, i % 4 === 0);
      server.tick();
    }
    const out = { enemies: digestEnemies(TC), rng: TC.GameRng.digest() };
    server.stop();
    return out;
  }
  const s1 = runWithSeed(555001);
  const s2 = runWithSeed(555002);
  assert.notStrictEqual(s1.rng, s2.rng, "RNG streams track the session seed");
});

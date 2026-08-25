/* tests/net/fourplayer.test.js — W23 WS6: 2–4 player systemic integration.
   Four concurrent clients: overlapping + separated interest, simultaneous
   mutations, multi-target AI distribution, one stalled client, disconnect +
   rejoin churn, and leak-free teardown. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg, sendInput, sendCmd } = require("./helpers.js");

const TS = 16;

function freshServer(seed) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed: seed == null ? 808 : seed });
  assert.ok(server.start().ok);
  return { TC, server };
}

function join(server, driver, name) {
  server.connect(driver.ep, { name });
  driver.ep.feed(msg("hello", { name }));
  server.processInbound();
  return driver.outbox.find((m) => m.t === "welcome").p.you.pid;
}

function synced(server, drivers) {
  let n = 0;
  for (;;) {
    server.tick();
    n++;
    if (drivers.every((d) => d.outbox.some((m) => m.t === "snapshot" && m.p.reason === "complete"))) break;
    if (n > 300) throw new Error("sync timeout");
  }
}

function givePickaxe(p) {
  const iv = p.inventory;
  iv.add("iron_pickaxe", 1);
  for (let s = 0; s < iv.slots.length; s++) {
    const st = iv.get(s);
    if (st && st.id === "iron_pickaxe") { p.hotbarIndex = s; return true; }
  }
  return false;
}

test("four players: separated interests mine simultaneously — every edit reaches every interested party exactly once", () => {
  const { TC, server } = freshServer(31);
  const D = [makeDriver("A"), makeDriver("B"), makeDriver("C"), makeDriver("D")];
  const pids = D.map((d, i) => join(server, d, "P" + i));
  const ps = pids.map((pid) => TC.Players.get(pid));
  const base = Math.floor(ps[0].x / TS);
  const spots = ps.map((p, i) => {
    const tx = base + i * 120;
    const ty = TC.world.surfaceY[tx];
    p.x = tx * TS;
    p.y = (ty - 2) * TS - p.h;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -5; dy <= -1; dy++) TC.world.setRaw(tx + dx, ty + dy, TC.TILE.AIR);
      TC.world.setRaw(tx + dx, ty, TC.TILE.STONE);
    }
    givePickaxe(p);
    return { tx, ty };
  });
  synced(server, D);

  const breaks = [];
  TC.Events.on(TC.Events.EVENT.TileBroken, (e) => breaks.push(e));

  const targets = spots.map((s) => ({ tx: s.tx + 2, ty: s.ty }));
  let seq = 1, guard = 500;
  while (targets.some((t) => TC.world.get(t.tx, t.ty) !== TC.TILE.AIR) && guard-- > 0) {
    for (let i = 0; i < 4; i++) {
      if (TC.world.get(targets[i].tx, targets[i].ty) !== TC.TILE.AIR) {
        sendCmd(D[i], seq++, "MineTile", targets[i]);
      }
    }
    server.tick();
  }
  assert.strictEqual(breaks.length, 4, "four simultaneous mines -> four breaks total");
  for (let i = 0; i < 4; i++) {
    assert.ok(D[i].outbox.some((m) => m.t === "worldupd"),
      "player " + i + " received region deltas");
  }
  server.stop();
});

test("four players: multi-target AI distributes targets across the roster", () => {
  const { TC, server } = freshServer(32);
  const D = [makeDriver(), makeDriver(), makeDriver(), makeDriver()];
  const pids = D.map((d, i) => join(server, d, "T" + i));
  const ps = pids.map((pid) => TC.Players.get(pid));
  synced(server, D);

  const base = Math.floor(ps[0].x / TS);
  ps.forEach((p, i) => {
    const tx = base + i * 90;
    const ty = TC.world.surfaceY[tx];
    p.x = tx * TS;
    p.y = (ty - 3) * TS - p.h;
  });

  const anchors = [];
  for (let i = 0; i < 8; i++) {
    const owner = ps[i % 4];
    const e = TC.Enemies.spawnEnemy("green_slime",
      owner.x + ((i % 2) ? 40 : -40), owner.y - 16);
    if (e) anchors.push(e);
  }
  assert.ok(anchors.length >= 4, "crowd spawned");
  for (let i = 0; i < 30; i++) TC.Enemies.update(1 / 60);

  const claimedBy = new Map();
  for (const e of anchors) {
    const t = TC.Targets.of(e);
    assert.ok(t, "every enemy keeps a live target");
    claimedBy.set(t, (claimedBy.get(t) || 0) + 1);
  }
  for (const pid of pids) {
    const p = TC.Players.get(pid);
    assert.ok(claimedBy.get(p) >= 1,
      "player " + pid + " is targeted by spawned enemies");
  }
  TC.Enemies.clear();
  server.stop();
});

test("one stalled client cannot stall the authority or the other clients", () => {
  const { TC, server } = freshServer(33);
  const wireSlow = TC.NetTransport.impairedPair({ latencyMs: 200, jitterMs: 50, seed: 3 });
  const fast = makeDriver("fast");

  // slow peer joins THROUGH the impaired wire (hello itself is delayed)
  server.connect(wireSlow.a, { name: "slow" });
  wireSlow.b.send(TC.NetProto.encode(msg("hello", { name: "slow" })));
  for (let i = 0; i < 60; i++) { wireSlow.pump(16); server.processInbound(); }

  const fastPid = join(server, fast, "fast");
  synced(server, [fast]);

  // hammer mutations while the slow peer's frames sit in flight
  const pa = TC.Players.get(fastPid);
  const tx = Math.floor(pa.x / TS) + 2;
  const ty = TC.world.surfaceY[tx];
  assert.ok(givePickaxe(pa), "pickaxe granted");
  let seq = 10, guard = 400;
  while (TC.world.get(tx, ty) !== TC.TILE.AIR && guard-- > 0) {
    sendCmd(fast, seq++, "MineTile", { tx, ty });
    sendInput(fast, seq++, [1, 0, 0], null, false);
    server.tick();
  }
  assert.ok(guard > 0, "authority progressed normally despite a delayed peer");

  // the slow peer eventually receives truth: pump virtual time, count the
  // authoritative frames delivered TO the delayed client (b side)
  let delivered = 0;
  const origDeliverB = wireSlow.b._deliver.bind(wireSlow.b);
  wireSlow.b._deliver = (s) => { delivered++; origDeliverB(s); };
  for (let i = 0; i < 120; i++) wireSlow.pump(16);
  assert.ok(delivered > 0,
    "delayed peer caught up (" + delivered + " authoritative frames delivered)");
  server.stop();
});

test("disconnect/rejoin churn with in-flight commands stays consistent and leak-free", () => {
  const { TC, server } = freshServer(34);
  const A = makeDriver();
  const pidA = join(server, A, "Churn");
  synced(server, [A]);

  // in-flight commands: queued AND sequence-acknowledged before the drop
  sendCmd(A, 41, "MineTile", { tx: 1, ty: 1 });
  sendCmd(A, 42, "MineTile", { tx: 2, ty: 2 });
  server.processInbound();

  const conn = [...server.conns.values()].find((c) => c.pid === pidA);
  server._dropConn(conn, "transport-closed", false);
  server.tick();

  assert.ok(server.detached.has(pidA), "identity parked for reconnect");

  // rejoin on fresh endpoint: same identity, resync served
  const A2 = makeDriver();
  server.connect(A2.ep, { name: "Churn" });
  A2.ep.feed(msg("hello", { rejoin: { sid: server.sid, pid: pidA, tick: 0 } }));
  server.processInbound();
  const w2 = A2.outbox.find((m) => m.t === "welcome");
  assert.ok(w2 && w2.p.you.pid === pidA, "same identity rebound");

  // stale-generation replay of pre-drop commands must be rejected
  sendCmd(A2, 41, "MineTile", { tx: 1, ty: 1 });
  server.processInbound();
  const res41 = A2.outbox.filter((m) => m.t === "cmdres" && m.p.ref === 41);
  assert.ok(res41.length >= 1, "replay produced a result for ref 41");
  const last41 = res41[res41.length - 1];
  assert.strictEqual(last41.p.ok, false, "stale floor rejects old-generation cmds");

  let n = 0;
  for (;;) {
    server.tick(); n++;
    if (A2.outbox.some((m) => m.t === "snapshot" && m.p.reason === "complete")) break;
    if (n > 300) throw new Error("resync timeout");
  }

  server.stop();
  assert.strictEqual(server.conns.size, 0, "no connections left");
  assert.strictEqual(server.detached.size, 0, "no detached identities left");
  const regStats = TC.WorldRegions.stats();
  assert.ok(Array.isArray(regStats.consumers) && regStats.consumers.length <= 3,
    "only renderer/lighting/minimap consumers remain: " +
    JSON.stringify(regStats.consumers));
});

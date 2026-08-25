/* tests/net/replication2.test.js — W23 WS5: productionized entity replication.
   Baselined deltas, explicit tombstones, keyframe recovery, idle suppression,
   cadence decoupling and drop identity. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg, sendInput } = require("./helpers.js");

const TS = 16;

function freshServer(seed, opts) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create(Object.assign({ seed: seed == null ? 77 : seed }, opts));
  const r = server.start();
  assert.ok(r.ok);
  return { TC, server };
}

function join(server, driver, name) {
  server.connect(driver.ep, { name });
  driver.ep.feed(msg("hello", { name }));
  server.processInbound();
  return driver.outbox.find((m) => m.t === "welcome").p.you.pid;
}

function synced(TC, server, drivers) {
  let n = 0;
  for (;;) {
    server.tick();
    n++;
    if (drivers.every((d) => d.outbox.some((m) => m.t === "snapshot" && m.p.reason === "complete"))) break;
    if (n > 200) throw new Error("sync timeout");
  }
}

test("replication v2: idle sessions emit ZERO worldupd traffic", () => {
  const { TC, server } = freshServer(21);
  // scope note: this suite isolates REPLICATION idleness, so keep the spawn
  // director out of the picture (its legitimate spawns are content).
  TC.Enemies.spawnDirector = function () {};
  const A = makeDriver();
  join(server, A, "Idle");
  synced(TC, server, [A]);
  for (let i = 0; i < 45; i++) server.tick();   // let the first inv baseline flow
  const mark = A.outbox.length;
  for (let i = 0; i < 90; i++) server.tick();   // 1.5 s idle at 60 Hz
  const upds = A.outbox.slice(mark).filter((m) => m.t === "worldupd");
  assert.strictEqual(upds.length, 0, "no empty worldupd spam while idle");
  assert.ok(server.stats.idleTicksSkipped > 30, "idle suppression counted");
  server.stop();
});

test("replication v2: motion sends presence-based deltas, not full snapshots", () => {
  const { TC, server } = freshServer(22);
  const A = makeDriver(), B = makeDriver();
  join(server, A, "Mover");
  const pidB = join(server, B, "Watcher");
  void pidB;
  synced(TC, server, [A, B]);
  B.outbox.length = 0;

  // A walks right for a second
  for (let i = 1; i <= 60; i++) {
    sendInput(A, i, [1, 0, 0], null, false);
    server.tick();
  }
  const upds = B.outbox.filter((m) => m.t === "worldupd" && m.p.players.length > 0);
  assert.ok(upds.length > 3, "movement was replicated (" + upds.length + " upds)");
  // delta discipline: most player lines must omit at least one always-on field
  let partials = 0, totals = 0;
  for (const u of upds) {
    for (const line of u.p.players) {
      totals++;
      if (line.name === undefined || line.maxHp === undefined || line.hp === undefined) partials++;
    }
  }
  assert.ok(partials >= totals - 2,
    "deltas carry only changed fields (" + partials + "/" + totals + " partial)");
  // and they stay bounded in count
  assert.ok(totals <= 70, "no per-tick full-array spam (" + totals + " lines/60 ticks)");
  server.stop();
});

test("replication v2: death/pickup produce explicit tombstones; ids are stable", () => {
  const { TC, server } = freshServer(23);
  const A = makeDriver();
  const pid = join(server, A, "Reaper");
  synced(TC, server, [A]);
  const pa = TC.Players.get(pid);

  // enemy inside interest
  const e = TC.Enemies.spawnEnemy("green_slime", pa.x + 32, pa.y - 8);
  assert.ok(e);
  let sawId = null;
  let guard = 90;
  while (!sawId && guard-- > 0) {
    server.tick();
    const u = [...A.outbox].reverse().find((m) => m.t === "worldupd" &&
      m.p.enemies.some((l) => l.id === "e" + e.eid));
    if (u) sawId = "e" + e.eid;
  }
  assert.ok(sawId, "enemy replicated under stable id");

  TC.Enemies.damageEnemy(e, 99999, 1, 0);
  let tombstone = false;
  guard = 90;
  while (!tombstone && guard-- > 0) {
    server.tick();
    const u = [...A.outbox].reverse().find((m) => m.t === "worldupd" &&
      m.p.rm && Array.isArray(m.p.rm.e) && m.p.rm.e.indexOf(sawId) >= 0);
    if (u) tombstone = true;
  }
  assert.ok(tombstone, "explicit removal tombstone delivered");

  // drop identity: spawned loot carries 'd<did>' and is removed by tombstone
  const drop = TC.Items.spawnDrop(pa.x, pa.y - 16, "gel", 1);
  assert.ok(drop.did > 0, "drop has stable numeric identity");
  let dropSeen = false;
  guard = 90;
  while (!dropSeen && guard-- > 0) {
    server.tick();
    const u = [...A.outbox].reverse().find((m) => m.t === "worldupd" &&
      (m.p.drops || []).some((l) => l.id === "d" + drop.did));
    if (u) dropSeen = true;
  }
  assert.ok(dropSeen, "drop replicated under 'd<did>' id");
  TC.Items.drops.splice(TC.Items.drops.indexOf(drop), 1);   // picked up
  let dropRm = false;
  guard = 90;
  while (!dropRm && guard-- > 0) {
    server.tick();
    const u = [...A.outbox].reverse().find((m) => m.t === "worldupd" &&
      m.p.rm && Array.isArray(m.p.rm.d) && m.p.rm.d.indexOf("d" + drop.did) >= 0);
    if (u) dropRm = true;
  }
  assert.ok(dropRm, "pickup produced a drop tombstone");
  server.stop();
});

test("replication v2: keyframes re-baseline state so lost deltas heal", () => {
  const { TC, server } = freshServer(24, { keyframeEveryTicks: 120, replicateEveryTicks: 1 });
  const A = makeDriver();
  join(server, A, "Kf");
  synced(TC, server, [A]);
  A.outbox.length = 0;
  for (let i = 0; i < 260; i++) server.tick();
  // after the baseline wipe at tick 120 and 240, the player re-sends FULL
  // lines (name present), proving recovery does not depend on prior state
  const fullAfterKey = A.outbox.filter((m) => m.t === "worldupd" && tickOf(m) >= 120)
    .flatMap((m) => m.p.players)
    .filter((l) => l.name !== undefined);
  assert.ok(fullAfterKey.length >= 1, "keyframe re-sent full player line");
  server.stop();
  function tickOf(m) { return m.tick | 0; }
});

test("replication v2: cadence decoupling caps presentation rate below sim rate", () => {
  const { TC, server } = freshServer(25, { replicateEveryTicks: 3 });
  const A = makeDriver();
  join(server, A, "Cadence");
  synced(TC, server, [A]);
  A.outbox.length = 0;
  // continuous motion: worldupd must arrive on ~1/3 of ticks, never all
  for (let i = 1; i <= 90; i++) {
    sendInput(A, i, [i % 2, 0, 0], null, false);
    server.tick();
  }
  const upds = A.outbox.filter((m) => m.t === "worldupd").length;
  assert.ok(upds <= 31, "30 Hz cap held (upds=" + upds + "/90 ticks)");
  assert.ok(upds >= 20, "updates still flow (upds=" + upds + ")");
  server.stop();
});

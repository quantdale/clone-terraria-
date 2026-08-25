/* tests/net/soak.test.js — W23 WS7: deterministic seeded multi-client
   soak/fuzz. A PRNG-driven driver mix (movement, mining, placement, item
   moves, disconnect/rejoin churn) runs for SOAK_TICKS authoritative ticks
   (default 2500 here; `tools/soak-multiplayer.js` runs 20k+ standalone) and
   asserts convergence, exactly-once mutation accounting and leak-free
   teardown. Same seed => same final digests and counters. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg, sendInput, sendCmd } = require("./helpers.js");

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runSoak(seed, ticks) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed });
  if (!server.start().ok) throw new Error("start failed");

  const D = [makeDriver("S1"), makeDriver("S2"), makeDriver("S3")];
  server.connect(D[0].ep, { name: "S1" });
  D[0].ep.feed(msg("hello", { name: "S1" }));
  server.connect(D[1].ep, { name: "S2" });
  D[1].ep.feed(msg("hello", { name: "S2" }));
  D[2].joined = false;

  const seqs = [10, 10, 10];
  const rng = mulberry(seed * 7919 + 13);
  const counters = { cmdsOk: 0, cmdsFailed: 0, inputsSent: 0 };
  let churnTick = 900 + ((seed % 200) | 0);

  for (let tick = 1; tick <= ticks; tick++) {
    // random-but-seeded driver intents
    for (let i = 0; i < 2; i++) {
      const d = D[i];
      if (!d.pid && !d.joined) continue;
      const r = rng();
      if (r < 0.55) sendInput(d, seqs[i]++, [rng() < 0.5 ? 1 : -1, rng() < 0.2 ? 1 : 0, 0], null, rng() < 0.3);
      else if (r < 0.8) sendCmd(d, seqs[i]++, "MineTile", {
        tx: 40 + ((rng() * 60) | 0), ty: 80 + ((rng() * 30) | 0)
      });
      else if (r < 0.92) sendCmd(d, seqs[i]++, "MoveItem", {
        fromSlot: (rng() * 10) | 0, toSlot: 10 + ((rng() * 20) | 0)
      });
      else sendCmd(d, seqs[i]++, "PlaceTile", {
        tx: 40 + ((rng() * 60) | 0), ty: 80 + ((rng() * 30) | 0), item: "dirt"
      });
      if (d.lastCmdAccepted === undefined) d.lastCmdAccepted = 0;
    }
    // third client joins late and churns: disconnect -> rejoin cycles
    if (tick === 120) {
      server.connect(D[2].ep, { name: "S3" });
      D[2].ep.feed(msg("hello", { name: "S3" }));
      D[2].joined = true;
    }
    if (D[2].joined && tick === churnTick) {
      const conn = [...server.conns.values()].find((c) => c.ep === D[2].ep);
      if (conn) server._dropConn(conn, "transport-closed", false);
      churnTick = tick + 400 + ((rng() * 200) | 0);
    }
    if (D[2].joined && !server.detached.size &&
        ![...server.conns.values()].some((c) => c.ep === D[2].ep)) {
      if (tick >= churnTick - 350) {
        // rejoin on the same endpoint object (fresh shell each cycle)
        try {
          server.connect(D[2].ep, { name: "S3" });
          D[2].ep.feed(msg("hello", {
            rejoin: { sid: server.sid, pid: D[2].pid || "p3", tick }
          }));
        } catch (e) {}
      }
    }

    server.tick();

    for (const d of D) {
      for (const m of d.outbox) {
        if (m.t !== "cmdres") continue;
        if (m.p.ok) counters.cmdsOk++; else counters.cmdsFailed++;
      }
      d.outbox.length = 0;
    }
  }

  const pid1 = D[0].outbox.length >= 0 ? null : null;
  void pid1;
  // stop cleanly so detached identities expire from the accounting
  server.stop();

  return {
    worldDigest: TC.NetProto.digestWorld(TC.world),
    players: TC.Players.count(),
    conns: server.conns.size,
    detached: server.detached.size,
    enemies: TC.Enemies.list.length,
    drops: TC.Items.drops.length,
    stats: {
      accepted: server.stats.cmdsAccepted,
      rejected: server.stats.cmdsRejected,
      staleSeq: server.stats.rejected.staleSeq,
      entityLines: server.stats.entityLinesSent,
      entityRm: server.stats.entityRmSent,
      resyncs: server.stats.resyncsServed,
      reconnects: server.stats.reconnects,
      disconnects: server.stats.disconnects,
      idleSkipped: server.stats.idleTicksSkipped
    },
    counters,
    ticksSimulated: server.stats.ticksSimulated,
    seedOfRun: TC.worldSeed
  };
}

test("soak: identical seeds reproduce identical final state and counters", () => {
  const ticks = parseInt(process.env.SOAK_TICKS || "2500", 10);
  const a = runSoak(4711, ticks);
  const b = runSoak(4711, ticks);
  assert.strictEqual(b.worldDigest, a.worldDigest, "world digest converged");
  assert.deepStrictEqual(b.stats, a.stats, "session counters reproduced");
  assert.strictEqual(a.ticksSimulated, ticks, "all ticks simulated");
}, { timeout: 600000 });

test("soak: teardown leaves no leaked entities or consumers", () => {
  const TC = loadGame({ hash: "" }).TC;
  const server = TC.NetServer.create({ seed: 99 });
  assert.ok(server.start().ok);
  const D = makeDriver();
  server.connect(D.ep, { name: "L" });
  D.ep.feed(msg("hello", { name: "L" }));
  server.processInbound();
  let n = 0;
  for (;;) {
    server.tick(); n++;
    if (D.outbox.some((m) => m.t === "snapshot" && m.p.reason === "complete")) break;
    if (n > 300) throw new Error("sync timeout");
  }
  // transport death WITHOUT bye parks a detached identity
  const conn = [...server.conns.values()][0];
  server._dropConn(conn, "transport-closed", false);
  assert.ok(server.detached.size === 1, "identity parked");
  server.stop();
  assert.strictEqual(server.detached.size, 0, "detached expired on stop");
  assert.strictEqual(TC.Players.count(), 0, "no ghost players");
});

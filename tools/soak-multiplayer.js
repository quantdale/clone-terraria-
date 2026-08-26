/* tools/soak-multiplayer.js — W23 standalone seeded multi-client soak/fuzz.
   Runs the SAME deterministic scenario engine as tests/net/soak.test.js but
   for tens of thousands of authoritative ticks by default, and reports the
   durable evidence the W23 campaign requires:

     usage: node tools/soak-multiplayer.js [--seed 4711] [--ticks 20000]
                                           [--players 3]

   Tracked: final world digest, exactly-once mutation accounting (accepted /
   rejected / stale-seq commands), entity replication volume, resync /
   reconnect counts, queue high-water marks and idle-suppression counters.
   Re-running with the same seed must print identical digests + counters. */
'use strict';
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { loadGame } = require(path.join(ROOT, "tests", "helpers", "load-game.js"));
const { makeDriver, msg, sendInput, sendCmd } = require(
  path.join(ROOT, "tests", "net", "helpers.js"));

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return (i >= 0 && process.argv[i + 1] != null) ? process.argv[i + 1] : dflt;
}

const SEED = parseInt(arg("seed", "4711"), 10) | 0;
const TICKS = parseInt(arg("ticks", "20000"), 10) | 0;

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const game = loadGame({ hash: "" });
const TC = game.TC;
const server = TC.NetServer.create({ seed: SEED });
if (!server.start().ok) {
  console.error("[soak] start failed");
  process.exit(1);
}

const D = [makeDriver("S1"), makeDriver("S2"), makeDriver("S3")];
server.connect(D[0].ep, { name: "S1" });
D[0].ep.feed(msg("hello", { name: "S1" }));
server.connect(D[1].ep, { name: "S2" });
D[1].ep.feed(msg("hello", { name: "S2" }));

const seqs = [10, 10, 10];
const rng = mulberry(SEED * 7919 + 13);
let churnTick = 900 + ((SEED % 200) | 0);
let s3Joined = false;
let maxPendingSeen = 0;

// ---- W24 phase: deterministic pump rig churn ----------------------------
// Seeded host-authoritative rig near S1; pulses + top-ups ride the same sim
// ticks as everything else so replication/conservation run under load.
const T24 = TC.TILE;
const p1 = TC.world.width >> 1;
const rrow = TC.world.surfaceY[p1] + 6;
for (let y = rrow - 2; y <= rrow + 1; y++) {
  for (let x = p1; x <= p1 + 10; x++) TC.world.setRaw(x, y, T24.AIR);
}
TC.world.setRaw(p1, rrow, T24.INLET_PUMP);
TC.world.setRaw(p1 + 8, rrow, T24.OUTLET_PUMP);
TC.world.setRaw(p1 + 1, rrow, T24.STONE);
TC.world.setRaw(p1 + 7, rrow, T24.STONE);
TC.world.setRaw(p1 + 9, rrow, T24.STONE);
for (let x = p1; x <= p1 + 8; x++) TC.world.setRaw(x, rrow - 1, T24.WIRE);
if (TC.Wiring.resetForNewWorld) TC.Wiring.resetForNewWorld();
TC.Liquids.set(p1, rrow, TC.Liquids.TYPE.WATER, 255);

for (let tick = 1; tick <= TICKS; tick++) {
  for (let i = 0; i < 2; i++) {
    const d = D[i];
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
  }

  if (!s3Joined && tick === 120) {
    server.connect(D[2].ep, { name: "S3" });
    D[2].ep.feed(msg("hello", { name: "S3" }));
    s3Joined = true;
  }
  if (s3Joined && tick === churnTick) {
    const conn = [...server.conns.values()].find((c) => c.ep === D[2].ep);
    if (conn) server._dropConn(conn, "transport-closed", false);
    churnTick = tick + 400 + ((rng() * 200) | 0);
  }
  if (s3Joined && !server.detached.size &&
      ![...server.conns.values()].some((c) => c.ep === D[2].ep)) {
    if (tick >= churnTick - 350) {
      try {
        server.connect(D[2].ep, { name: "S3" });
        D[2].ep.feed(msg("hello", {
          rejoin: { sid: server.sid, pid: D[2].pid || "p3", tick }
        }));
      } catch (e) {}
    }
  }

  server.tick();
  // W24 churn: bounded pulse batch + supply top-up on a seeded schedule
  if (tick % 90 === 0) {
    TC.Wiring.pulse(p1 + 4, rrow - 1);
    if (tick % 360 === 0) TC.Liquids.set(p1, rrow, TC.Liquids.TYPE.WATER, 255);
  }
  const q = server.summary();
  if (q.stats.pendingHighWater === undefined) maxPendingSeen = Math.max(maxPendingSeen, server.conns.size);
  for (const d of D) d.outbox.length = 0;
  if (tick % 5000 === 0) console.log("[soak] tick " + tick + "/" + TICKS);
}

const st = server.stats;
console.log(JSON.stringify({
  seed: SEED,
  ticks: TICKS,
  worldDigest: TC.NetProto.digestWorld(TC.world),
  players: TC.Players.count(),
  enemies: TC.Enemies.list.length,
  drops: TC.Items.drops.length,
  cmdsAccepted: st.cmdsAccepted,
  cmdsRejected: st.cmdsRejected,
  staleSeqRejected: st.rejected.staleSeq,
  entityLinesSent: st.entityLinesSent,
  entityRmSent: st.entityRmSent,
  regionsFull: st.regionsSentFull,
  regionsDelta: st.regionsSentDelta,
  resyncsServed: st.resyncsServed,
  reconnects: st.reconnects,
  disconnects: st.disconnects,
  idleTicksSkipped: st.idleTicksSkipped,
  outBytesPeakPerTick: st.outBytesPeakPerTick,
  liquidDigest: TC.Liquids.digest(),
  pump: TC.Wiring.pumpStats()
}, null, 1));

server.stop();
console.log("[soak] post-stop players=" + TC.Players.count() +
  " detached=" + server.detached.size + " conns=" + server.conns.size);

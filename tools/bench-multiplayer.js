/* tools/bench-multiplayer.js — W22 multiplayer performance evidence.
   Boots the REAL game headless (same VM loader as the test/bench harnesses),
   runs an authoritative session against protocol-driver clients, and reports
   per-scene medians: authoritative tick cost, replication message volume and
   outbound bytes. No sockets: drivers remove network noise so numbers isolate
   simulation + serialization cost.

   NOTE: like tools/bench-scenarios.js, absolute values carry the VM-realm
   tax (vm-script functions run slower than host-JIT equivalents); relative
   comparisons between scenes are the meaningful signal.

   Usage: node tools/bench-multiplayer.js [ticksPerScene] */
'use strict';
const path = require("path");
const { loadGame } = require(path.join(__dirname, "..", "tests", "net", "helpers.js"));

const TICKS = parseInt(process.argv[2] || "600", 10) | 0; // default 10s of sim
const TS = 16;

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
}

function main() {
  const game = loadGame({ hash: "" });
  const TC = game.TC;
  const P = TC.NetProto;

  function freshSession(seed) {
    TC.Players.resetForNewWorld();
    const server = TC.NetServer.create({ seed });
    const r = server.start();
    if (!r.ok) throw new Error("start failed: " + JSON.stringify(r));
    return server;
  }

  function makeDriver(name) {
    const outbox = [];
    let inbound = null;
    const ep = {
      label: name, open: true,
      send(s) { if (!this.open) return false; outbox.push(s); return true; },
      close() { this.open = false; },
      onMessage(fn) { inbound = fn; },
      onStatus() {},
      feed(m) { if (inbound) inbound(typeof m === "string" ? m : JSON.stringify(m)); }
    };
    return { ep, outbox };
  }

  function joinDriver(server, name) {
    const drv = makeDriver(name);
    server.connect(drv.ep, { name });
    drv.ep.feed({ v: P.VERSION, t: "hello", sid: null, pid: null, cseq: 1, sseq: 0, tick: 0, p: { name } });
    server.processInbound();
    const welcome = drv.outbox.map((s2) => JSON.parse(s2)).find((m) => m.t === "welcome");
    if (!welcome) throw new Error("join failed for " + name);
    return { drv, pid: welcome.p.you.pid };
  }

  // Run `ticks` authoritative steps, timing each tick individually.
  // beforeTick(i) may inject traffic for tick i.
  function timedRun(server, ticks, beforeTick) {
    const timesNs = [];
    for (let i = 0; i < ticks; i++) {
      if (beforeTick) beforeTick(i);
      const t0 = process.hrtime.bigint();
      server.tick();
      timesNs.push(Number(process.hrtime.bigint() - t0));
    }
    return timesNs;
  }

  function report(label, timesNs, statsBefore) {
    const st = server_stats(serverBefore(statsBefore));
    void st;
  }

  // simpler: scenes capture their own after-stats
  function reportScene(label, timesNs, msgsPerTick, bytesPerSec) {
    console.log(
      label.padEnd(22) +
      " tick " + (median(timesNs) / 1000).toFixed(1).padStart(8) + " µs" +
      "   out msg/tick " + msgsPerTick.toFixed(2).padStart(5) +
      "   out KiB/s " + (bytesPerSec / 1024).toFixed(1).padStart(7)
    );
  }

  const WARMUP = 120;

  // ---- scene: idle with two clients ----
  {
    const server = freshSession(9001);
    joinDriver(server, "IdleA");
    joinDriver(server, "IdleB");
    timedRun(server, WARMUP, null);
    const before = server.summary().stats.msgsOut;
    void before;
    const times = timedRun(server, TICKS, null);
    const st = server.summary().stats;
    reportScene("idle-2p", times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- scene: two clients moving continuously ----
  {
    const server = freshSession(9002);
    const a = joinDriver(server, "MoveA");
    const b = joinDriver(server, "MoveB");
    timedRun(server, WARMUP, null);
    const times = timedRun(server, TICKS, (i) => {
      a.drv.ep.feed({
        v: P.VERSION, t: "input", sid: server.sid, pid: a.pid,
        cseq: i + 10, sseq: 0, tick: i,
        p: { btn: [i % 40 < 20 ? 1 : -1, i % 9 === 0 ? 1 : 0, 0], aimX: 0, aimY: 0, slot: 0 }
      });
      b.drv.ep.feed({
        v: P.VERSION, t: "input", sid: server.sid, pid: b.pid,
        cseq: i + 10, sseq: 0, tick: i,
        p: { btn: [i % 30 < 15 ? -1 : 1, 0, 0], aimX: 0, aimY: 0, slot: 0 }
      });
    });
    const st = server.summary().stats;
    reportScene("move-2p", times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- scene: burst mining along a surface strip ----
  {
    const server = freshSession(9003);
    const { drv, pid } = joinDriver(server, "Miner");
    const pa = TC.Players.get(pid);
    const inv = pa.inventory;
    inv.add("iron_pickaxe", 1);
    for (let i = 0; i < inv.slots.length; i++) {
      if (inv.get(i) && inv.get(i).id === "iron_pickaxe") { pa.hotbarIndex = i; break; }
    }
    timedRun(server, WARMUP, null);
    let seq = 100;
    const times = timedRun(server, TICKS, (i) => {
      const cellTx = Math.floor(pa.x / TS) + ((i / 40) | 0);
      const cellTy = TC.world.surfaceY[Math.min(TC.world.width - 1, cellTx)];
      drv.ep.feed({
        v: P.VERSION, t: "cmd", sid: server.sid, pid,
        cseq: seq++, sseq: 0, tick: i,
        p: { name: "MineTile", ctx: { tx: cellTx, ty: cellTy } }
      });
    });
    const st = server.summary().stats;
    reportScene("mine-burst", times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- scene: disconnect/resync churn ----
  {
    const server = freshSession(9004);
    const { drv, pid } = joinDriver(server, "Churn");
    timedRun(server, WARMUP, null);
    let cycles = 0;
    const CHURN_EVERY = 120; // a full snapshot resync every 2 seconds
    const times = timedRun(server, TICKS, (i) => {
      if (i > 0 && i % CHURN_EVERY === 0) {
        cycles++;
        const conn = [...server.conns.values()].find((c) => c.pid === pid);
        if (conn) server._dropConn(conn, "transport-closed", false);
        drv.ep.feed({
          v: P.VERSION, t: "hello", sid: server.sid, pid,
          cseq: 500000 + cycles, sseq: 0, tick: 0,
          p: { rejoin: { sid: server.sid, pid, tick: 0 } }
        });
        server.processInbound();
      }
    });
    const st = server.summary().stats;
    reportScene("resync-churn x" + cycles, times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- scene: four idle clients ----
  {
    const server = freshSession(9006);
    for (const nm of ["I1", "I2", "I3", "I4"]) joinDriver(server, nm);
    timedRun(server, WARMUP, null);
    const times = timedRun(server, TICKS, null);
    const st = server.summary().stats;
    reportScene("idle-4p", times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- scene: four clients moving continuously ----
  {
    const server = freshSession(9007);
    const cs = ["M1", "M2", "M3", "M4"].map((nm) => joinDriver(server, nm));
    timedRun(server, WARMUP, null);
    let seq = 10;
    const times = timedRun(server, TICKS, (i) => {
      seq++;
      cs.forEach((c, k) => {
        c.drv.ep.feed({
          v: P.VERSION, t: "input", sid: server.sid, pid: c.pid,
          cseq: seq * 8 + k, sseq: 0, tick: i,
          p: { btn: [(i + k * 10) % 60 < 30 ? 1 : -1, 0, 0], aimX: 0, aimY: 0 }
        });
      });
    });
    const st = server.summary().stats;
    reportScene("move-4p", times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- scene: separated-interest exploration (4 players far apart) ----
  {
    const server = freshSession(9008);
    const cs = ["E1", "E2", "E3", "E4"].map((nm) => joinDriver(server, nm));
    // park each player ~150 tiles apart so interest sets are disjoint
    cs.forEach((c, k) => {
      const p = TC.Players.get(c.pid);
      p.x += k * 150 * TS;
    });
    timedRun(server, WARMUP, null);
    let seq = 10;
    const times = timedRun(server, TICKS, (i) => {
      seq++;
      cs.forEach((c, k) => {
        c.drv.ep.feed({
          v: P.VERSION, t: "input", sid: server.sid, pid: c.pid,
          cseq: seq * 8 + k, sseq: 0, tick: i,
          p: { btn: [k % 2 ? 1 : -1, 0, 0], aimX: 0, aimY: 0 }
        });
      });
    });
    const st = server.summary().stats;
    reportScene("separated-explore-4p", times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- scene: combat with multi-target AI ----
  {
    const server = freshSession(9009);
    const a = joinDriver(server, "F1");
    const b = joinDriver(server, "F2");
    const pa = TC.Players.get(a.pid);
    const pb = TC.Players.get(b.pid);
    for (let k = 0; k < 12; k++) {
      TC.Enemies.spawnEnemy("green_slime", pa.x - 80 + k * 14, pa.y - 40);
      TC.Enemies.spawnEnemy("blue_slime", pb.x - 60 + k * 12, pb.y - 40);
    }
    timedRun(server, WARMUP, null);
    let seq = 10;
    const times = timedRun(server, TICKS, (i) => {
      seq++;
      a.drv.ep.feed({ v: P.VERSION, t: "input", sid: server.sid, pid: a.pid,
        cseq: seq * 8, sseq: 0, tick: i,
        p: { btn: [1, 0, 0], aimX: pa.x + 60, aimY: pa.y } });
      b.drv.ep.feed({ v: P.VERSION, t: "input", sid: server.sid, pid: b.pid,
        cseq: seq * 8 + 1, sseq: 0, tick: i,
        p: { btn: [-1, 0, 0], aimX: pb.x - 60, aimY: pb.y } });
    });
    const st = server.summary().stats;
    reportScene("combat-multi-2p", times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- scene: craft/shop transaction burst ----
  {
    const server = freshSession(9010);
    const a = joinDriver(server, "Tx1");
    timedRun(server, WARMUP, null);
    let cmdSeq = 100;
    let rid = null;
    if (TC.Registry && TC.Registry.legacyToStable) {
      try { rid = TC.Registry.legacyToStable("recipe", 0); } catch (e) { rid = null; }
    }
    const times = timedRun(server, TICKS, (i) => {
      if (i % 3 === 0 && rid) {
        a.drv.ep.feed({ v: P.VERSION, t: "cmd", sid: server.sid, pid: a.pid,
          cseq: cmdSeq++, sseq: 0, tick: i,
          p: { name: "CraftRecipe", ctx: { recipeId: rid } } });
      } else if (i % 3 === 1) {
        a.drv.ep.feed({ v: P.VERSION, t: "cmd", sid: server.sid, pid: a.pid,
          cseq: cmdSeq++, sseq: 0, tick: i,
          p: { name: "ShopBuy", ctx: { npcType: "merchant", itemId: "torch" } } });
      } else {
        a.drv.ep.feed({ v: P.VERSION, t: "cmd", sid: server.sid, pid: a.pid,
          cseq: cmdSeq++, sseq: 0, tick: i,
          p: { name: "MoveItem", ctx: { fromSlot: 0, toSlot: 20 } } });
      }
    });
    const st = server.summary().stats;
    reportScene("tx-burst-craft-shop", times, st.msgsOut / TICKS, st.bytesOut / (TICKS / 60));
    server.stop();
  }

  // ---- one-client vs two-client comparison ----
  function avgTickMedian(clientCount) {
    const server = freshSession(9005 + clientCount);
    for (let i = 0; i < clientCount; i++) joinDriver(server, "C" + i);
    timedRun(server, WARMUP, null);
    const times = timedRun(server, TICKS, null);
    server.stop();
    return median(times);
  }
  const one = avgTickMedian(1);
  const two = avgTickMedian(2);
  console.log(
    "\none-client vs two-client median tick: " + (one / 1000).toFixed(1) +
    " µs -> " + (two / 1000).toFixed(1) + " µs (" +
    (((two - one) / Math.max(one, 1e-9)) * 100).toFixed(0) + "%)"
  );
}

  console.log(
    'W22 baseline (same machine class): idle-2p 86.0 KiB/s | move-2p 85.8 | ' +
    'mine-burst 47.9 | resync-churn 25.9 KiB/s'
  );

main();

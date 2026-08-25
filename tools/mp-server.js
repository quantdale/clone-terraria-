/* tools/mp-server.js — headless authoritative multiplayer host (W22/W23).
   Boots the REAL game scripts headless (same VM loader as the test/bench
   harnesses), creates one authoritative world, and serves the W23 protocol
   over a dependency-free WebSocket endpoint.

   Usage:
     node tools/mp-server.js [--seed 1337] [--port 7777]
          [--interest 56] [--budget 4] [--rate 2] [--keyframe 600]
          [--detach-grace 300] [--max-out-kb 128]

     interest      region interest radius in tiles around each player
     budget        changed regions replicated per tick per connection
     rate          presentation replication cadence (worldupd every N ticks)
     keyframe      ticks between entity baseline resets (recovery)
     detach-grace  seconds a detached identity survives for reconnect
     max-out-kb    per-tick outbound byte budget per connection

   Clients: browser title screen -> "Join Local Server" (ws://localhost:PORT),
   or any TC.NetTransport.websocket(). The simulation advances on a wall-clock
   fixed-step driver; rendering never runs here. */
'use strict';
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const { loadGame } = require(path.join(ROOT, "tests", "helpers", "load-game.js"));
const wsShim = require(path.join(__dirname, "net", "wsserver.js"));

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return (i >= 0 && process.argv[i + 1] != null) ? process.argv[i + 1] : dflt;
}

const SEED = parseInt(arg("seed", "1337"), 10) | 0;
const PORT = parseInt(arg("port", "7777"), 10) | 0;
const INTEREST = parseInt(arg("interest", "56"), 10) | 0;
const BUDGET = parseInt(arg("budget", "4"), 10) | 0;
const RATE = parseInt(arg("rate", "2"), 10) | 0;
const KEYFRAME = parseInt(arg("keyframe", "600"), 10) | 0;
const DETACH_GRACE_S = parseFloat(arg("detach-grace", "300"));
const MAX_OUT_KB = parseFloat(arg("max-out-kb", "128"));

// ---- boot the real game headless ----
const game = loadGame({ hash: "" });
const TC = game.TC;

if (!TC.NetServer || !TC.Runtime) {
  console.error("[mp-server] net modules missing — check index.html script order");
  process.exit(1);
}

const server = TC.NetServer.create({
  seed: SEED,
  interestRadius: INTEREST,
  budgetRegionsPerTick: BUDGET,
  replicateEveryTicks: RATE,
  keyframeEveryTicks: KEYFRAME,
  detachGraceTicks: Math.max(1, Math.round(DETACH_GRACE_S * 60)),
  maxOutBytesPerTick: Math.max(8192, Math.round(MAX_OUT_KB * 1024))
});
const started = server.start();
if (!started.ok) {
  console.error("[mp-server] start failed:", started.error);
  process.exit(1);
}
// Dedicated host: register the world's built-in player as a dormant primary
// so the movement system has no ghost singleton outside the registry.
server.attachLocal("Server");

console.log(`[mp-server] session ${started.sid} seed=${TC.worldSeed} ` +
            `world=${TC.world.width}x${TC.world.height} listening on :${PORT}`);

// ---- real transport (dependency-free RFC6455 shim) ----
const httpServer = http.createServer((req, res) => {
  if (req.url === "/debug") {
    // bounded diagnostics: authoritative tick, player poses, live drops
    const drops = (TC.Items && TC.Items.drops || []).slice(0, 24).map((d) => ({
      id: d.id, x: Math.round(d.x), y: Math.round(d.y), age: Math.round(d.age * 10) / 10,
    }));
    const players = [];
    for (const rec of TC.Players.entries()) {
      players.push({ id: rec.id, x: Math.round(rec.player.x), y: Math.round(rec.player.y), hp: rec.player.hp });
    }
    // W23: authoritative target attribution for observability (journey N
    // proves enemies legitimately target non-primary players).
    const enemies = (TC.Enemies && TC.Enemies.list || []).slice(0, 40).map((e) => ({
      eid: e.eid, type: e.type,
      x: Math.round(e.x), y: Math.round(e.y),
      targetPid: (TC.Targets && TC.Targets.of) ? (() => {
        const t = TC.Targets.of(e);
        return t ? (TC.Players.idOf ? TC.Players.idOf(t) : null) : null;
      })() : null,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sid: started.sid, tick: server.summary().tick, players, enemies, drops }, null, 1));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("clone-terraria authoritative multiplayer session\n");
});
const wss = wsShim.attach(httpServer);
let connSeq = 0;
wss.onConnection((ep) => {
  const r = server.connect(ep, { name: "Guest" + (++connSeq) });
  if (!r.ok) { ep.close(r.error); return; }
  console.log(`[mp-server] transport connected (${r.cid})`);
});
httpServer.listen(PORT, () => {});

// ---- wall-clock fixed-step driver ----
server.runForever();

// ---- bounded periodic diagnostics (never per-tick spam) ----
const reportEveryMs = 10000;
const reporter = setInterval(() => {
  const s = server.summary();
  const st = s.stats;
  console.log(
    `[mp-server] t=${s.tick} players=${s.players} conns=${s.conns} ` +
    `in=${st.msgsIn}/${st.bytesOut ? st.bytesIn : 0}B out=${st.msgsOut}/${st.bytesOut}B ` +
    `regions(full/delta)=${st.regionsSentFull}/${st.regionsSentDelta} acks=${st.regionsAcked} ` +
    `cmds(+/-)=${st.cmdsAccepted}/${st.cmdsRejected}`
  );
}, reportEveryMs);

function shutdown() {
  clearInterval(reporter);
  server.haltDriver();
  server.stop("server-shutdown");
  try { httpServer.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 150);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

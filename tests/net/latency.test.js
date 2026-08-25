/* tests/net/latency.test.js — W23 WS4: latency masking without weakening
   authority. Covers the deterministic impaired transport (latency/jitter/
   stall), remote snapshot interpolation, and local prediction reconciliation
   with soft/hard correction policies. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, msg } = require("./helpers.js");

const TS = 16;

function bootRealm(seed) {
  const { TC } = loadGame({ hash: "" });
  TC.Runtime.createWorld(seed == null ? 31 : seed);
  return TC;
}

test("transport: impairedPair delivers deterministically after the configured delay", () => {
  const TC = bootRealm(1);
  const wire = TC.NetTransport.impairedPair({ latencyMs: 100, jitterMs: 0, seed: 42 });
  const got = [];
  wire.b.onMessage((s) => got.push({ t: wire.time(), s }));
  wire.a.send("hello");
  wire.pump(50);
  assert.strictEqual(got.length, 0, "not delivered before latency elapses");
  wire.pump(60);                                  // t=110 >= 100
  assert.strictEqual(got.length, 1, "delivered once past due");

  // same seed + same schedule -> identical delivery trace (jittered)
  function run(seed) {
    const w = TC.NetTransport.impairedPair({ latencyMs: 100, jitterMs: 25, seed });
    const times = [];
    w.b.onMessage(() => times.push(w.time()));
    for (let i = 0; i < 5; i++) { w.a.send("m" + i); w.pump(33); }
    return times;
  }
  assert.deepStrictEqual(run(7), run(7), "same seed reproduces delivery times");
});

test("transport: stall withholds delivery; resume releases the burst in order", () => {
  const TC = bootRealm(1);
  const wire = TC.NetTransport.impairedPair({ latencyMs: 10, jitterMs: 0, seed: 5 });
  const got = [];
  wire.b.onMessage((s) => got.push(s));
  wire.a.send("a"); wire.pump(20);
  wire.stall(500);
  wire.a.send("b"); wire.pump(100);
  assert.deepStrictEqual(got, ["a"], "stalled frames held back");
  wire.resume();
  wire.a.send("c"); wire.pump(30);
  assert.deepStrictEqual(got, ["a", "b", "c"], "ordered release after resume");
});

test("interpolation: remote mirrors hold/glide through snapshot buffers", () => {
  const TC = bootRealm(2);
  const client = TC.NetClient.create({ interp: true, predict: false });
  client.phase = "playing";
  client.pid = "p9";
  client.sid = "s";

  const feed = (x) => {
    client.inbox.push(TC.NetProto.encode(msg("worldupd", {
      regions: [], players: [{ id: "p2", x, y: 100, vx: 0, vy: 0, hp: 90, maxHp: 100, face: 1 }],
      enemies: [], drops: []
    }, { sid: "s", pid: "p9" })));
  };
  feed(200);
  for (let i = 0; i < 6; i++) { client.tickCount++; client._pump(); }
  feed(300);
  let sawIntermediate = false;
  for (let i = 0; i < 12; i++) {
    client.tickCount++;
    client._pump();
    client._interpolate();
    const rec = TC.Players.entry("p2");
    if (rec && rec.player.x > 200.5 && rec.player.x < 299.5) sawIntermediate = true;
  }
  const rec = TC.Players.entry("p2");
  assert.ok(rec, "remote player mirror exists");
  assert.ok(sawIntermediate,
    "render pose glided between snapshots (last=" +
    rec.player.x.toFixed(1) + ")");
  // buffer holds exactly the authoritative poses
  const bufRec = client.playerBufs.get("p2");
  assert.ok(bufRec, "interp buffer tracked for remote player");
  const xs = Array.from(bufRec.buf.map((b) => b.x)).sort((a, b) => a - b);
  assert.deepStrictEqual(xs, [200, 300]);
});

test("prediction: soft errors blend, hard divergences snap — authority preserved", () => {
  const TC = bootRealm(3);
  const client = TC.NetClient.create({ interp: false, predict: true });
  client.phase = "playing";
  client.pid = "p1";
  const p = TC.player;

  // soft error: server says we are 8px right of the prediction
  p.x = 1000; p.y = 500;
  client.selfCorr = { x: 1008, y: 500, vx: null, vy: null };
  client._reconcileSelf();
  assert.ok(p.x > 1000 && p.x < 1008, "soft blend moved partway (" + p.x.toFixed(2) + ")");
  assert.strictEqual(client.stats.predSoftCorrections, 1);

  // hard divergence: far beyond the snap threshold -> immediate snap
  const target = p.x + 500;
  client.selfCorr = { x: target, y: p.y, vx: 0, vy: 0 };
  client._reconcileSelf();
  assert.ok(Math.abs(p.x - target) < 0.001, "hard snap applied");
  assert.strictEqual(client.stats.predHardSnaps, 1);
  assert.strictEqual(client.inputHist.length, 0);
});

test("end-to-end: session over impaired wire converges under ~120ms RTT + jitter", () => {
  const TC = bootRealm(4);
  const wire = TC.NetTransport.impairedPair({
    latencyMs: 60, jitterMs: 25, seed: 99
  });
  const server = TC.NetServer.create({ seed: 4242 });
  assert.ok(server.start().ok);
  server.attachLocal("Host");
  server.connect(wire.a, { name: "H" });

  const client = TC.NetClient.create({ name: "Joiner", interp: false, predict: false });
  client.connect(wire.b);

  for (let i = 0; i < 240; i++) {
    server.tick();
    wire.pump(16);
    client.frame(1 / 60);
  }
  assert.strictEqual(client.phase, "playing", "join completed over impaired wire");
  assert.ok(client.pid, "identity assigned");

  // authoritative host motion replicates through the impaired wire.
  // Fixture: long flat corridor + an input source driving the host RIGHT,
  // exactly like the canonical per-player input seam drives remotes.
  const host = TC.Players.get(server.localPid);
  const fx = Math.floor(host.x / TS);
  const fy = TC.world.surfaceY[fx];
  for (let dx = -4; dx <= 220; dx++) {
    for (let dy = -10; dy <= -1; dy++) TC.world.setRaw(fx + dx, fy + dy, TC.TILE.AIR);
    TC.world.setRaw(fx + dx, fy, TC.TILE.STONE);
    TC.world.setRaw(fx + dx, fy + 1, TC.TILE.STONE);
  }
  host.x = (fx + 2) * TS; host.y = (fy - 2) * TS - host.h;
  host.inputSource = {
    axis: function () { return { x: 1, jump: false }; },
    down: function () { return false; },
    pressed: function () { return false; }
  };
  for (let i = 0; i < 30; i++) { server.tick(); wire.pump(16); client.frame(1 / 60); }
  const x0 = host.x;
  for (let i = 1; i <= 90; i++) {
    server.tick();
    wire.pump(16);
    client.frame(1 / 60);
  }
  const rec = TC.Players.entry(server.localPid);
  assert.ok(rec, "host mirror exists on the joiner");
  assert.ok(host.x > x0 + 64,
    "authoritative motion actually happened (+" + (host.x - x0).toFixed(1) + "px)");
  const lag = Math.abs(rec.player.x - host.x);
  assert.ok(lag <= 24,
    "mirror converged to authority through latency (lag=" + lag.toFixed(1) + "px)");
  client.disconnect();
  server.stop();
});

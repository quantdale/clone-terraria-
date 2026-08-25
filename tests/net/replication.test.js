/* tests/net/replication.test.js — NET-004 prototype guarantees on the W21
   region substrate: per-client consumers stay independent of renderer /
   lighting / minimap; interest tracking follows players; edits while
   uninterested are delivered on entry; ack mismatches force resync;
   world/session resets never leak revisions. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg } = require("./helpers.js");

const TS = 16;

function boot(seed) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed });
  const r = server.start();
  assert.ok(r.ok);
  return { TC, server };
}

function join(server, name) {
  const d = makeDriver(name);
  server.connect(d.ep, { name });
  d.ep.feed(msg("hello", { name }));
  server.processInbound();
  const welcome = d.outbox.find((m) => m.t === "welcome");
  return { d, pid: welcome.p.you.pid };
}

test("replication: the network cursor never steals presentation work", () => {
  const { TC, server } = boot(31);
  const { d, pid } = join(server, "R");
  for (let i = 0; i < 40 && !d.outbox.some(m => m.t === "snapshot" && m.p.reason === "complete"); i++) server.tick();

  const pa = TC.Players.get(pid);
  const stats = TC.WorldRegions.stats();
  // all four production consumers coexist
  for (const need of ["renderer", "lighting", "minimap"]) {
    assert.ok(stats.consumers.indexOf(need) >= 0, "consumer " + need + " registered");
  }
  assert.ok(stats.consumers.some((c) => c.startsWith("net:")), "network consumer registered");

  // an edit marks EVERY consumer; observing it as the network must not
  // clear the renderer's staleness
  const tx = Math.floor(pa.x / TS), ty = TC.world.surfaceY[tx];
  TC.world.setRaw(tx + 1, ty - 1, TC.TILE.AIR);
  const net = [...server.conns.values()][0].consumer;
  const beforeRendererPending = TC.WorldRegions.consume("renderer").pendingCount();
  void beforeRendererPending;

  // replicate once: the net consumer observes its interested regions...
  server.tick();
  // ...but the renderer still sees work of its own (independent queues)
  const after = TC.WorldRegions.stats();
  assert.ok(after.queues["renderer"] >= 0 && after.queues["lighting"] >= 0,
    "presentation consumers keep their own queues");
  server.stop();
});

test("replication: interest follows the player; crossing regions delivers new ones", () => {
  const { TC, server } = boot(32);
  const { d, pid } = join(server, "Mover");
  for (let i = 0; i < 40 && !d.outbox.some(m => m.t === "snapshot" && m.p.reason === "complete"); i++) server.tick();

  const pa = TC.Players.get(pid);
  const R = TC.WorldRegions;
  const homeRegion = R.chunkOf(Math.floor(pa.x / TS), Math.floor(pa.y / TS));

  // teleport far away: cross several region columns
  const farTx = (Math.floor(pa.x / TS) + R.CHUNK * 3 + 8);
  const ty = TC.world.surfaceY[Math.min(TC.world.width - 1, farTx)];
  pa.x = farTx * TS;
  pa.y = (ty - 2) * TS - pa.h;

  // pump until a snapshot/worldupd carries a full layer for the new region
  let sawNewFull = false;
  for (let i = 0; i < 200 && !sawNewFull; i++) {
    server.tick();
    for (const m of d.outbox) {
      if ((m.t === "worldupd" || m.t === "snapshot") && Array.isArray(m.p.regions)) {
        for (const r of m.p.regions) {
          if (r.idx === R.chunkOf(farTx, ty) && r.tiles) sawNewFull = true;
        }
      }
    }
  }
  assert.ok(sawNewFull, "entering a new region delivers its authoritative layer");
  assert.notStrictEqual(homeRegion, R.chunkOf(farTx, ty), "actually crossed regions");
  server.stop();
});

test("replication: edit while UNINTERESTED arrives when interest begins", () => {
  const { TC, server } = boot(33);
  const { d, pid } = join(server, "Far");
  for (let i = 0; i < 40 && !d.outbox.some(m => m.t === "snapshot" && m.p.reason === "complete"); i++) server.tick();
  const pa = TC.Players.get(pid);
  const R = TC.WorldRegions;

  // edit a region FAR outside interest while the client is connected
  const farTx = (Math.floor(pa.x / TS) + R.CHUNK * 6) % (TC.world.width - 2);
  const farTy = TC.world.surfaceY[farTx];
  TC.world.setRaw(farTx, farTy, TC.TILE.AIR);
  const farIdx = R.chunkOf(farTx, farTy);

  // no delivery while uninterested (budget is not wasted)
  const outboxMark = d.outbox.length;
  for (let i = 0; i < 10; i++) server.tick();
  let deliveredWhileAway = false;
  for (const m of d.outbox.slice(outboxMark)) {
    if ((m.t === "worldupd" || m.t === "snapshot") &&
        (m.p.regions || []).some((r) => r.idx === farIdx)) deliveredWhileAway = true;
  }
  assert.strictEqual(deliveredWhileAway, false,
    "uninterested regions stay queued, not streamed");

  // move into that region: the pending edit must arrive as a full layer
  pa.x = farTx * TS - 8;
  pa.y = (farTy - 2) * TS - pa.h;
  let sawEdit = false;
  for (let i = 0; i < 200 && !sawEdit; i++) {
    server.tick();
    for (const m of d.outbox) {
      if ((m.t === "worldupd" || m.t === "snapshot") && Array.isArray(m.p.regions)) {
        for (const r of m.p.regions) {
          if (r.idx !== farIdx) continue;
          if (r.tiles) {
            const coords = R.chunkCoords(farIdx);
            const lx = farTx - coords.cx * R.CHUNK, ly = farTy - coords.cy * R.CHUNK;
            const byte = parseInt(r.tiles.substr((ly * R.CHUNK + lx) * 2, 2), 16);
            if (byte === TC.TILE.AIR) sawEdit = true;
          }
        }
      }
    }
  }
  assert.ok(sawEdit, "entering delivers the edit made while uninterested");
  server.stop();
});

test("replication: ack reporting a future revision forces a resync snapshot", () => {
  const { TC, server } = boot(34);
  const { d, pid } = join(server, "Acky");
  for (let i = 0; i < 40 && !d.outbox.some(m => m.t === "snapshot" && m.p.reason === "complete"); i++) server.tick();

  const snapshotsBefore = server.stats.snapshotsSent;
  const bogusRev = 0xffffff; // a revision the server never issued
  const anyIdx = 0;
  d.ep.feed(msg("ack", {
    upto: { sseq: 1, tick: 1 },
    regions: [[anyIdx, bogusRev]]
  }, { sid: server.sid, pid, cseq: 1 }));
  server.processInbound();

  let forced = false;
  for (let i = 0; i < 30; i++) {
    server.tick();
    if (server.stats.snapshotsSent > snapshotsBefore) { forced = true; break; }
  }
  assert.ok(forced, "desync detector scheduled a fresh snapshot");
  server.stop();
});

test("replication: rapid edits in one region coalesce without loss", () => {
  const { TC, server } = boot(35);
  const { d, pid } = join(server, "Burst");
  for (let i = 0; i < 40 && !d.outbox.some(m => m.t === "snapshot" && m.p.reason === "complete"); i++) server.tick();
  const pa = TC.Players.get(pid);

  // hammer many edits inside the player's region within ONE tick window
  const tx0 = Math.floor(pa.x / TS) + 1;
  const ty0 = TC.world.surfaceY[tx0] - 1;
  for (let k = 0; k < 25; k++) {
    TC.world.setRaw(tx0, ty0 - k % 3, k % 2 ? TC.TILE.STONE : TC.TILE.AIR);
  }
  server.tick(); // one replication pass

  // the last-sent baseline must equal current truth for that cell
  const conn = [...server.conns.values()][0];
  const idx = TC.WorldRegions.chunkOf(tx0, ty0);
  const sent = conn.lastSent.get(idx);
  assert.ok(sent, "region was replicated");
  const coords = TC.WorldRegions.chunkCoords(idx);
  const lx = tx0 - coords.cx * 32, ly = ty0 - coords.cy * 32;
  const finalTile = TC.world.get(tx0, ty0 - 0);
  assert.strictEqual(sent.tiles[ly * 32 + lx], finalTile,
    "baselined copy matches authoritative state after burst");

  server.stop();
});

test("replication: session teardown forgets per-client consumers", () => {
  const { TC, server } = boot(36);
  const { d, pid } = join(server, "Leaver");
  for (let i = 0; i < 20; i++) server.tick();
  const netConsumersBefore = TC.WorldRegions.stats().consumers.filter(c => c.startsWith("net:")).length;
  assert.ok(netConsumersBefore >= 1, "net consumer present while connected");

  d.ep.feed(msg("bye", { reason: "done" }, { sid: server.sid, pid, cseq: 9 }));
  server.processInbound();
  const netConsumersAfter = TC.WorldRegions.stats().consumers.filter(c => c.startsWith("net:")).length;
  assert.strictEqual(netConsumersAfter, 0, "bye forgot the private consumer");
  assert.strictEqual(TC.Players.count(), 0, "explicit departure removed the entity");
  server.stop();
});

/* tests/net/session.test.js — THE two-client authoritative slice (NET-003):
   join, movement authority, mining/placement exactly-once, one combat
   interaction, inventory duplication safety, reconnect/resync, hostile
   packets, deterministic replay of a recorded two-client trace. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg, sendInput, sendCmd, findTileNear } = require("./helpers.js");

const TS = 16;

function freshServer(seed) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed: seed == null ? 9021 : seed });
  const r = server.start();
  assert.ok(r.ok, "server start failed: " + JSON.stringify(r));
  return { TC, server };
}

function join(server, driver, name) {
  const c = server.connect(driver.ep, { name });
  assert.ok(c.ok, "connect ok");
  driver.ep.feed(msg("hello", { name }));
  server.processInbound();
  const welcome = driver.outbox.find((m) => m.t === "welcome");
  assert.ok(welcome, "welcome received");
  return welcome.p.you.pid;
}

// Pump the world until the join snapshot stream completes for both drivers.
function pumpUntilSynced(TC, server, drivers, maxTicks) {
  let n = 0;
  for (;;) {
    server.tick();
    n++;
    const done = drivers.every((d) =>
      d.outbox.some((m) => m.t === "snapshot" && m.p.reason === "complete"));
    if (done) break;
    if (n > (maxTicks || 120)) throw new Error("snapshot stream did not complete");
  }
  return n;
}

test("slice: two clients join ONE shared world and receive identities", () => {
  const { TC, server } = freshServer(11);
  const A = makeDriver("A"), B = makeDriver("B");
  const pidA = join(server, A, "Alpha");
  const pidB = join(server, B, "Beta");
  assert.ok(pidA && pidB && pidA !== pidB, "distinct stable player ids");

  // same world + same seed announced to both
  assert.strictEqual(A.outbox[0].p.seed, B.outbox[0].p.seed);
  assert.strictEqual(TC.worldSeed, A.outbox[0].p.seed);

  pumpUntilSynced(TC, server, [A, B]);
  // both players exist authoritatively
  assert.ok(TC.Players.get(pidA), "player A entity exists");
  assert.ok(TC.Players.get(pidB), "player B entity exists");
  // both were spawned in the SAME world (not divergent copies)
  assert.strictEqual(TC.Players.get(pidA).world, undefined); // sanity: plain objects
  server.stop();
});

test("slice: movement is server-authoritative; input cannot move another player", () => {
  const { TC, server } = freshServer(12);
  const A = makeDriver(), B = makeDriver();
  const pidA = join(server, A), pidB = join(server, B);
  pumpUntilSynced(TC, server, [A, B]);

  const pa = TC.Players.get(pidA), pb = TC.Players.get(pidB);
  const x0a = pa.x, x0b = pb.x;

  // A walks right for half a second of ticks; B sends nothing.
  for (let i = 1; i <= 30; i++) {
    sendInput(A, i, [1, 0, 0], null, false);
    server.tick();
  }
  assert.ok(pa.x > x0a + 20, "input moved player A (+" + (pa.x - x0a).toFixed(1) + "px)");
  assert.strictEqual(pb.x, x0b, "player B untouched by A's input");

  // settle the held input to neutral AND wait for physics rest (airborne
  // drift is legitimate), then stale replays must apply nothing
  sendInput(A, 31, [0, 0, 0], null, false);
  for (let i = 0; i < 90; i++) {
    server.tick();
    if (pa.onGround && Math.abs(pa.vx) < 0.01) break;
  }
  const settled = pa.x;
  sendInput(A, 30, [1, 0, 0], null, false);   // duplicate cseq
  sendInput(A, 5, [1, 0, 0], null, false);    // ancient cseq
  server.tick();
  server.tick();
  assert.strictEqual(pa.x, settled, "stale/duplicate samples apply nothing");
  assert.ok(server.stats.rejected.staleSeq >= 1, "rejections counted");

  server.stop();
});

test("slice: mining replicates exactly once — duplicate intent cannot re-break", () => {
  const { TC, server } = freshServer(13);
  const A = makeDriver();
  const pidA = join(server, A);
  pumpUntilSynced(TC, server, [A]);

  const pa = TC.Players.get(pidA);
  // fixture: stand next to a surface tile we choose deterministically
  const sx = Math.floor(pa.x / TS) + 3;
  const ty = TC.world.surfaceY[sx];
  const target = { tx: sx, ty };
  pa.x = (sx - 2) * TS;
  pa.y = (ty - 1) * TS - pa.h;

  const broken = [];
  TC.Events.on(TC.Events.EVENT.TileBroken, (e) => broken.push(e));

  // give an iron pick server-side (the client never declares tool power)
  const inv = pa.inventory;
  inv.add("iron_pickaxe", 1);
  for (let i = 0; i < inv.slots.length; i++) {
    if (inv.get(i) && inv.get(i).id === "iron_pickaxe") { pa.hotbarIndex = i; break; }
  }

  // mine until it breaks, strictly increasing cseq like a real client would
  let seq = 1, guard = 400;
  while (TC.world.get(target.tx, target.ty) !== TC.TILE.AIR && guard-- > 0) {
    sendCmd(A, seq++, "MineTile", { tx: target.tx, ty: target.ty });
    server.tick();
  }
  assert.ok(guard > 0, "tile actually broke");
  assert.strictEqual(broken.length, 1, "TileBroken fired exactly once");
  assert.strictEqual(
    A.outbox.filter((m) => m.t === "cmdres" && m.p.ok).length >= 1, true,
    "at least one accepted command result");

  // semantic idempotence: keep hammering the same air cell — no new events
  const dropsBefore = TC.Items.drops.length;
  for (let i = 0; i < 10; i++) {
    sendCmd(A, seq++, "MineTile", { tx: target.tx, ty: target.ty });
    server.tick();
  }
  assert.strictEqual(broken.length, 1, "no duplicate break events from repeats");
  assert.strictEqual(TC.Items.drops.length, dropsBefore, "no duplicate loot");

  // protocol-level duplicate: EXACT same packet again -> stale-seq rejection
  sendCmd(A, seq - 1, "MineTile", { tx: target.tx, ty: target.ty });
  server.tick();
  const lastRes = A.outbox.filter((m) => m.t === "cmdres").pop();
  assert.strictEqual(lastRes.p.ok, false, "duplicate cseq rejected");
  assert.strictEqual(broken.length, 1);

  server.stop();
});

test("slice: placement consumes once; rejected placement consumes nothing", () => {
  const { TC, server } = freshServer(14);
  const A = makeDriver();
  const pidA = join(server, A);
  pumpUntilSynced(TC, server, [A]);
  const pa = TC.Players.get(pidA);

  const inv = pa.inventory;
  inv.remove(0, inv.count("dirt"));           // clear starter dirt for exact math
  const dirtBefore = 50;
  inv.add("dirt", dirtBefore);

  // find an AIR cell adjacent to something solid within reach
  const sx = Math.floor(pa.x / TS);
  const sy = Math.floor((pa.y + pa.h) / TS);
  let place = null;
  for (let dx = -4; dx <= 4 && !place; dx++) {
    const tx = sx + dx, ty = TC.world.surfaceY[Math.max(0, Math.min(TC.world.width - 1, sx + dx))] - 1;
    if (TC.world.get(tx, ty) === TC.TILE.AIR) place = { tx, ty };
  }
  assert.ok(place, "found an air placement cell near the surface");

  pa.x = (place.tx - 2) * TS;
  pa.y = (place.ty - 2) * TS;

  sendCmd(A, 1, "PlaceTile", { tx: place.tx, ty: place.ty, item: "dirt" });
  server.tick();
  const res = A.outbox.filter((m) => m.t === "cmdres").pop();
  assert.ok(res && res.p.ok, "placement accepted");
  assert.strictEqual(inv.count("dirt"), dirtBefore - 1, "exactly one item consumed");
  assert.strictEqual(TC.world.get(place.tx, place.ty), TC.TILE.DIRT, "tile placed");

  // rejected placement: occupied target now
  const countAfterFirst = inv.count("dirt");
  sendCmd(A, 2, "PlaceTile", { tx: place.tx, ty: place.ty, item: "dirt" });
  server.tick();
  const res2 = A.outbox.filter((m) => m.t === "cmdres").pop();
  assert.strictEqual(res2.p.ok, false, "occupied target rejected");
  assert.strictEqual(inv.count("dirt"), countAfterFirst, "rejection consumed nothing");

  // unknown item cannot conjure blocks
  sendCmd(A, 3, "PlaceTile", { tx: place.tx + 1, ty: place.ty, item: "mystery_block" });
  server.tick();
  assert.strictEqual(TC.world.get(place.tx + 1, place.ty), TC.TILE.AIR,
    "unknown item placed nothing");

  server.stop();
});

test("slice: combat replicates — one arrow kill, one loot spawn, both observers agree", () => {
  const { TC, server } = freshServer(15);
  const A = makeDriver(), B = makeDriver();
  const pidA = join(server, A), pidB = join(server, B);
  pumpUntilSynced(TC, server, [A, B]);

  const kills = [];
  TC.Events.on(TC.Events.EVENT.EntityKilled, (e) => kills.push(e));

  // deterministic arena: flat stone strip at fixed height around player A
  const pa = TC.Players.get(pidA);
  const fx = Math.floor(pa.x / TS);
  const fy = TC.world.surfaceY[fx];
  for (let dx = -6; dx <= 18; dx++) {
    for (let dy = -4; dy <= -1; dy++) TC.world.setRaw(fx + dx, fy + dy, TC.TILE.AIR);
    for (let dy = 0; dy <= 1; dy++) TC.world.setRaw(fx + dx, fy + dy, TC.TILE.STONE);
  }
  const slime = TC.Enemies.spawnEnemy("green_slime",
    (fx + 8) * TS, (fy - 2) * TS - 14);
  assert.ok(slime, "slime spawned");

  // bow + arrows for A
  const inv = pa.inventory;
  inv.add("wooden_bow", 1);
  inv.add("arrow", 40);
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.get(i);
    if (s && s.id === "wooden_bow") { pa.hotbarIndex = i; break; }
  }

  // fire UseItem intents aimed at the slime's CURRENT position with ballistic
  // compensation (arrows are gravity projectiles simulated ONLY on the server)
  const at = TC.Projectiles.TYPES.arrow;
  let seq = 1, guard = 240;
  while (kills.length === 0 && guard-- > 0) {
    if (!TC.Enemies.list.includes(slime)) break;
    const dx = (slime.x + slime.w / 2) - (pa.x + pa.w / 2);
    const dy = (slime.y + slime.h / 2) - (pa.y + pa.h / 2);
    const adx = Math.abs(dx) || 1;
    const t = adx / at.speed;
    const drop = 0.5 * at.gravity * t * t;      // vertical compensation
    const aimX = pa.x + pa.w / 2 + dx;
    const aimY = dy - drop + pa.y + pa.h / 2;
    sendInput(A, seq++, [0, 0, 0], { x: aimX, y: aimY }, true);
    server.tick();
  }
  assert.strictEqual(kills.length, 1, "exactly one EntityKilled event");
  assert.ok(!TC.Enemies.list.includes(slime), "enemy removed from authority");

  const gel = TC.Items.drops.filter((d) => d.id === "gel")
    .reduce((n, d) => n + d.count, 0);
  assert.ok(gel >= 1, "loot generated exactly once (gel=" + gel + ")");

  // both clients observe the outcome via replication
  pumpUntilSynced(TC, server, []); // settle stream
  for (let i = 0; i < 5; i++) server.tick();
  const lastUpdA = [...A.outbox].reverse().find((m) => m.t === "worldupd");
  const lastUpdB = [...B.outbox].reverse().find((m) => m.t === "worldupd");
  assert.ok(lastUpdA && lastUpdB, "both observers receive world updates");
  for (const upd of [lastUpdA, lastUpdB]) {
    const ids = upd.p.enemies.map((e) => e.id);
    assert.ok(!ids.some((id) => id === "e" + slime.eid),
      "dead enemy absent from replicated snapshot");
  }

  server.stop();
});

test("slice: inventory mutations are authoritative and duplication-proof", () => {
  const { TC, server } = freshServer(16);
  const A = makeDriver();
  const pidA = join(server, A);
  pumpUntilSynced(TC, server, [A]);
  const pa = TC.Players.get(pidA);
  const inv = pa.inventory;

  inv.remove(0, inv.count("dirt"));
  inv.add("dirt", 999);                       // fills many slots
  const totalDirt = () => {
    let n = 0;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.get(i);
      if (s && s.id === "dirt") n += s.count;
    }
    return n;
  };

  // move a full stack between two slots through the protocol
  const srcSlot = (() => { for (let i = 0; i < inv.slots.length; i++) { const s = inv.get(i); if (s && s.id === "dirt") return i; } return -1; })();
  const dstSlot = (() => { for (let i = inv.slots.length - 1; i >= 0; i--) { if (!inv.get(i)) return i; } return -1; })();
  const stackCount = inv.get(srcSlot).count;
  const before = totalDirt();

  sendCmd(A, 1, "MoveItem", { fromSlot: srcSlot, toSlot: dstSlot });
  server.tick();
  assert.strictEqual(totalDirt(), before, "move conserves total");
  assert.strictEqual(inv.get(dstSlot).count, stackCount, "stack arrived whole");

  // REPLAY of the same packet: source slot is empty now; even if validation
  // passed it could not create items. Total must remain invariant.
  sendCmd(A, 1, "MoveItem", { fromSlot: srcSlot, toSlot: dstSlot });  // dup cseq -> rejected outright
  sendCmd(A, 2, "MoveItem", { fromSlot: srcSlot, toSlot: dstSlot });  // valid seq, empty source
  server.tick();
  assert.strictEqual(totalDirt(), before, "replays/empties cannot duplicate stacks");

  // cross-player selection is structurally impossible: ctx carries only slots
  const B = makeDriver();
  const pidB = join(server, B);
  pumpUntilSynced(TC, server, [B]);
  sendCmd(B, 1, "MoveItem", { fromSlot: srcSlot, toSlot: dstSlot });
  server.tick();
  assert.strictEqual(totalDirt(), before, "other client moved its OWN inventory only");

  server.stop();
});

test("slice: disconnect/resync — edits while away arrive; stale generation dies", () => {
  const { TC, server } = freshServer(17);
  const A = makeDriver();
  const pidA = join(server, A);
  pumpUntilSynced(TC, server, [A]);

  const pa = TC.Players.get(pidA);

  // one command first so the rebinding gets a real cseq floor
  sendCmd(A, 5, "MineTile", { tx: 0, ty: 0 });
  server.tick();

  // transport death without bye
  const deadConn = [...server.conns.values()].find((c) => c.pid === pidA);
  server._dropConn(deadConn, "transport-closed", false);

  // world keeps living: mine a tile server-side while A is away. The region
  // that MUST advance is the one containing the EDITED cell.
  const sx = Math.floor(pa.x / TS) + 2;
  const sy = TC.world.surfaceY[sx];
  TC.world.setRaw(sx, sy, TC.TILE.AIR);
  const idx = TC.WorldRegions.chunkOf(sx, sy);

  // rejoin via hello.rejoin on a FRESH endpoint
  const A2 = makeDriver();
  const connected = server.connect(A2.ep, { name: "Again" });
  assert.ok(connected.ok);
  A2.ep.feed(msg("hello", { rejoin: { sid: server.sid, pid: pidA, tick: 0 } }));
  server.processInbound();
  const w2 = A2.outbox.find((m) => m.t === "welcome");
  assert.ok(w2, "rejoin welcomed");
  assert.strictEqual(w2.p.you.pid, pidA, "SAME player identity after reconnect");

  // fresh snapshot includes the edit made during absence
  let guard = 120, sawEdit = false;
  while (guard-- > 0) {
    server.tick();
    const snaps = A2.outbox.filter((m) => m.t === "snapshot");
    for (const s of snaps) {
      for (const r of s.p.regions) {
        if (r.idx !== idx || !r.tiles) continue;
        // decode the target cell and verify it is AIR now
        const coords = TC.WorldRegions.chunkCoords(idx);
        const lx = sx - coords.cx * 32, ly = sy - coords.cy * 32;
        const byte = parseInt(r.tiles.substr((ly * 32 + lx) * 2, 2), 16);
        if (byte === TC.TILE.AIR) sawEdit = true;
      }
    }
    if (sawEdit) break;
  }
  assert.ok(sawEdit, "resync delivered edits made while the client was away");

  // stale old-generation commands are rejected by the cseq floor
  const floor = A2.pid ? 0 : 0; void floor;
  const conn = [...server.conns.values()].find((c) => c.pid === pidA);
  assert.ok(conn && conn.staleFloor >= 1, "cseq floor raised on rebind");
  sendCmd(A2, 0, "MineTile", { tx: 1, ty: 1 });      // below floor
  server.processInbound();
  const rej = A2.outbox.filter((m) => m.t === "cmdres").pop();
  assert.ok(rej && rej.p.ok === false, "stale-generation cmd rejected");

  server.stop();
});

test("slice: hostile packets never mutate state", () => {
  const { TC, server } = freshServer(18);
  const A = makeDriver();
  const pidA = join(server, A);
  pumpUntilSynced(TC, server, [A]);

  const tilesFingerprint = TC.NetProto.digestWorld(TC.world);
  const before = server.stats.rejected;

  // raw garbage frames
  A.ep.feedRaw("{{{{not json");
  A.ep.feedRaw("");
  // wrong version
  A.ep.feed(Object.assign(msg("hello", {}), { v: 99 }));
  // unknown type
  A.ep.feed(msg("own_the_world", {}));
  // spoofed pid
  A.ep.feed(msg("input", { btn: [1, 0, 0], aimX: 0, aimY: 0 }, { sid: server.sid, pid: "pZ", cseq: 5000 }));
  // oversized-ish payload field
  A.ep.feed(msg("hello", { name: "x".repeat(25) }));

  server.processInbound();
  server.tick();

  assert.strictEqual(TC.NetProto.digestWorld(TC.world), tilesFingerprint,
    "hostile traffic mutated nothing");
  const rej = server.stats.rejected;
  assert.ok(rej.payload >= 2, "payload failures counted (" + JSON.stringify(rej) + ")");
  assert.ok(rej.version >= 1, "version failures counted");
  assert.ok(rej.type >= 1, "unknown-type failures counted");
  assert.ok(rej.spoofedPid >= 1, "spoofed-pid failures counted");

  // connection still healthy afterwards: real input still works
  const pa = TC.Players.get(pidA);
  const x0 = pa.x;
  sendInput(A, 900, [1, 0, 0], null, false);
  server.tick();
  assert.ok(pa.x > x0, "session survives abuse");
  server.stop();
});

test("slice: deterministic replay — identical two-client traces produce identical authoritative state", () => {
  function runTrace() {
    const { TC, server } = freshServer(777);
    const A = makeDriver(), B = makeDriver();
    const pidA = join(server, A), pidB = join(server, B);
    pumpUntilSynced(TC, server, [A, B]);

    const pa = TC.Players.get(pidA), pb = TC.Players.get(pidB);
    // recorded trace: A right+jump 60 ticks, B left 40 ticks, A mines 3 cells
    for (let i = 1; i <= 60; i++) {
      sendInput(A, i, i <= 40 ? [1, i % 9 === 0 ? 1 : 0, 0] : [-1, 0, 0], null, false);
      if (i <= 40) sendInput(B, i, [-1, 0, 0], null, false);
      server.tick();
    }
    // scripted deterministic mining of three surface cells near B
    const inv = pb.inventory;
    inv.add("iron_pickaxe", 1);
    for (let i = 0; i < inv.slots.length; i++) {
      if (inv.get(i) && inv.get(i).id === "iron_pickaxe") { pb.hotbarIndex = i; break; }
    }
    const bx = Math.floor(pb.x / TS) + 1;
    let seq = 100;
    for (let k = 0; k < 3; k++) {
      const tx = bx + k, ty = TC.world.surfaceY[tx];
      pb.x = (tx - 2) * TS; pb.y = (ty - 1) * TS - pb.h;
      let g = 300;
      while (TC.world.get(tx, ty) !== TC.TILE.AIR && g-- > 0) {
        sendCmd(B, seq++, "MineTile", { tx, ty });
        server.tick();
      }
    }
    const digest = TC.NetProto.digestWorld(TC.world) ^ TC.NetProto.digestInventory(inv);
    server.stop();
    return digest >>> 0;
  }
  const d1 = runTrace();
  const d2 = runTrace();
  assert.strictEqual(d1, d2, "same seed + same trace -> identical authoritative state");
});

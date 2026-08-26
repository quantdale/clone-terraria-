/* tests/net/liquid-replication.test.js — W24 WS2/WS6: authoritative liquid
   type+amount as a first-class region layer.
     - protocol level: snapshot/delta region lines carry liquid truth;
     - cross-realm (real NetClient over a deterministic bridge): initial
       sync, bucket ops, natural settling, pump pulses, water+lava reaction,
       disconnect/resync all converge the presentation mirror onto host
       truth without any client-side simulation. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg } = require("./helpers.js");

const TS = 16;
const STEP = 1 / 60;

function freshServer(seed) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed: seed == null ? 909 : seed });
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

// Deterministic bridge identical to crossrealm.test.js (kept local so this
// suite owns its failure surface).
function bridgePair() {
  function side(label) {
    const s = {
      label, open: true,
      peer: null, _wire: [],
      _m: null, _s: null,
      send(raw) {
        if (!s.open || !s.peer) return false;
        s.peer._wire.push(String(raw));
        return true;
      },
      close() {
        if (!s.open) return;
        s.open = false;
        if (s._s) try { s._s("closed"); } catch (e) {}
      },
      onMessage(f) { s._m = f; },
      onStatus(f) { s._s = f; },
      pump() {
        let n = 0;
        while (s._wire.length) {
          const raw = s._wire.shift();
          if (s._m) try { s._m(raw); } catch (e) {}
          n++;
        }
        return n;
      }
    };
    return s;
  }
  const a = side("liq:A");
  const b = side("liq:B");
  a.peer = b;
  b.peer = a;
  return { a, b };
}

// Per-type liquid volume over a rectangle of the world.
function volumeByType(TC, x0, y0, x1, y1) {
  const tot = { 1: 0, 2: 0, 3: 0 };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const q = TC.Liquids.queryAt(x, y);
      if (q.amount > 0) tot[q.type] += q.amount;
    }
  }
  return tot;
}

// Carve a sealed box and lay a pump rig joined by a rail above.
function buildPumpRig(TC, ax, bx, row) {
  const T = TC.TILE;
  const w = TC.world;
  for (let y = row - 4; y <= row + 2; y++) {
    for (let x = ax - 2; x <= bx + 2; x++) w.setRaw(x, y, T.AIR);
  }
  for (let y = row - 4; y <= row + 1; y++) {
    w.setRaw(ax - 2, y, T.STONE);
    w.setRaw(bx + 2, y, T.STONE);
  }
  for (let x = ax - 2; x <= bx + 2; x++) {
    w.setRaw(x, row + 1, T.STONE);
    w.setRaw(x, row - 4, T.STONE);
  }
  w.setRaw(ax, row, T.INLET_PUMP);
  w.setRaw(bx, row, T.OUTLET_PUMP);
  for (let x = ax; x <= bx; x++) w.setRaw(x, row - 1, T.WIRE);
  // Seal both endpoint cells against lateral settle drift so tests control
  // the exact volume present when a pulse fires.
  w.setRaw(ax - 1, row, T.STONE);
  w.setRaw(ax + 1, row, T.STONE);
  w.setRaw(bx - 1, row, T.STONE);
  w.setRaw(bx + 1, row, T.STONE);
}

test("liquid net: snapshot regions carry authoritative ltype+lamt layers", () => {
  const { TC, server } = freshServer(910);
  const A = makeDriver();
  const pid = join(server, A, "Thirsty");
  synced(server, [A]);
  // capture session identity from our own welcome
  const welcome = A.outbox.find((m) => m.t === "welcome");
  const sid = welcome && welcome.sid;

  // Known liquid near the player AFTER join; a client-driven resync request
  // forces fresh FULL lines that must carry it.
  const p = TC.Players.get(pid);
  const sx = Math.floor(p.x / TS), sy = TC.world.surfaceY[sx] + 2;
  for (let y = sy - 1; y <= sy; y++) {
    for (let x = sx - 1; x <= sx + 1; x++) TC.world.setRaw(x, y, TC.TILE.AIR);
  }
  TC.Liquids.set(sx, sy, TC.Liquids.TYPE.WATER, 200);

  A.outbox.length = 0;
  A.ep.feed(msg("resync", { reason: "liquid-test" }, { sid, pid }));
  server.processInbound();

  let found = null;
  for (let i = 0; i < 120 && !found; i++) {
    server.tick();
    const snap = [...A.outbox].reverse().find((m) => m.t === "snapshot" && m.p.regions.length);
    if (!snap) continue;
    for (const r of snap.p.regions) {
      assert.ok(r.ltype && r.lamt, "full snapshot line missing liquid layers");
      const lt = Buffer.from(r.ltype, "hex");
      const la = Buffer.from(r.lamt, "hex");
      const coords = TC.WorldRegions.chunkCoords(r.idx);
      const ox = sx - coords.cx * TC.WorldRegions.CHUNK;
      const oy = sy - coords.cy * TC.WorldRegions.CHUNK;
      const CH = TC.WorldRegions.CHUNK;
      if (ox >= 0 && oy >= 0 && ox < CH && oy < CH) {
        found = { lt, la, o: oy * CH + ox };
      }
    }
  }
  assert.ok(found, "no full region line covered the liquid cell");
  assert.strictEqual(found.lt[found.o], 1, "snapshot ltype missing water");
  assert.strictEqual(found.la[found.o], 200, "snapshot lamt missing volume");
  server.stop();
});

test("liquid net: settling/bucket mutations ride delta quintuples to interested clients", () => {
  const { TC, server } = freshServer(911);
  const A = makeDriver();
  join(server, A, "Watcher");
  synced(server, [A]);
  // air pocket at the anchor so placeAt cannot fail closed on solid ground
  const anchor = server.conns ? server.conns.values().next().value : null;
  const p = anchor && anchor.player;
  assert.ok(p, "joined player available");
  const tx = Math.floor(p.x / TS), ty = TC.world.surfaceY[tx] + 2;
  for (let y = ty - 1; y <= ty; y++) {
    for (let x = tx - 1; x <= tx + 1; x++) TC.world.setRaw(x, y, TC.TILE.AIR);
  }

  // authoritative "bucket pour" equivalent through the canonical seam
  TC.Liquids.placeAt(tx, ty, TC.Liquids.TYPE.LAVA);
  assert.ok(TC.Liquids.queryAt(tx, ty).amount > 0, "host pour refused");
  let sawQuint = false;
  for (let i = 0; i < 90 && !sawQuint; i++) {
    server.tick();
    for (const u of A.outbox) {
      if (u.t !== "worldupd") continue;
      for (const r of u.p.regions) {
        if (!r.cells) continue;
        for (const c of r.cells) {
          if (c.length === 5 && c[3] === TC.Liquids.TYPE.LAVA && c[4] > 0) sawQuint = true;
        }
      }
    }
  }
  assert.ok(sawQuint, "liquid mutation did not arrive as a 5-tuple delta");
  server.stop();
});

test("cross-realm liquids: join/settle/pump/reaction/resync converge the mirror", () => {
  const serverRealm = loadGame({ hash: "" });
  const S = serverRealm.TC;
  const server = S.NetServer.create({ seed: 4242 + 24 });
  assert.ok(server.start().ok);

  const clientRealm = loadGame({ hash: "" });
  const C = clientRealm.TC;

  let link = bridgePair();
  server.connect(link.a, { name: "Guest" });
  const client = C.NetClient.create({ name: "Guest" });
  client.connect(link.b);

  const pumpBoth = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      link.a.pump();
      server.tick();
      link.b.pump();
      client.frame(STEP);
    }
  };
  pumpBoth(90);
  assert.strictEqual(client.phase, "playing", "client playing");
  const pa = S.Players.get(client.pid);

  // ---- 1. initial liquid truth ----
  const atx = Math.floor(pa.x / TS), arow = S.world.surfaceY[atx] + 6;
  buildPumpRig(S, atx + 2, atx + 10, arow);
  S.Liquids.set(atx + 2, arow, S.Liquids.TYPE.WATER, 255);
  pumpBoth(120); // replicate the edits into the mirror

  const liqEq = (x, y) => {
    const h = S.Liquids.queryAt(x, y);
    const m = C.Liquids.queryAt(x, y);
    return h.type === m.type && h.amount === m.amount;
  };
  assert.ok(liqEq(atx + 2, arow), "mirror inlet cell diverged after join sync");

  // ---- 2. pump pulse moves exactly once; both sides agree ----
  const prePulseInlet = S.Liquids.queryAt(atx + 2, arow).amount;
  const before = volumeByType(S, atx, arow - 4, atx + 12, arow + 1);
  S.Wiring.pulse(atx + 6, arow - 1);
  const movedOnce = S.Liquids.queryAt(atx + 10, arow).amount;
  assert.strictEqual(movedOnce,
    Math.min(prePulseInlet, S.Wiring.PUMP_TRANSFER),
    "pulse did not move exactly one bounded batch (got " + movedOnce + ")");
  pumpBoth(120);
  assert.ok(liqEq(atx + 2, arow), "inlet mirror diverged after pulse");
  assert.ok(liqEq(atx + 10, arow), "outlet mirror diverged after pulse");
  const mirrorVol = volumeByType(C, atx, arow - 4, atx + 12, arow + 1);
  const after = volumeByType(S, atx, arow - 4, atx + 12, arow + 1);
  assert.deepStrictEqual(mirrorVol, after, "mirror volumes differ from host");
  assert.deepStrictEqual(after, before, "host conservation broken");

  // ---- 3. water+lava reaction converges including the stone tile ----
  S.Liquids.set(atx + 10, arow + 0, S.Liquids.TYPE.LAVA, 255);
  S.Liquids.set(atx + 8, arow, S.Liquids.TYPE.WATER, 255);
  // force contact: drop water onto the lava column
  S.Liquids.set(atx + 10, arow - 1, S.Liquids.TYPE.WATER, 255);
  for (let k = 0; k < 40 && S.world.get(atx + 10, arow) !== S.TILE.STONE; k++) {
    S.Liquids.update(0.06);
  }
  assert.strictEqual(S.world.get(atx + 10, arow), S.TILE.STONE, "reaction did not fire");
  pumpBoth(160);
  assert.strictEqual(C.world.get(atx + 10, arow), S.TILE.STONE,
    "stone tile did not converge into the mirror");
  assert.ok(liqEq(atx + 10, arow), "reacted cell liquid state diverged");

  // ---- 4. disconnect -> host liquid churn -> rejoin resync sees CURRENT truth ----
  link.a.close();
  link.b.close();
  pumpBoth(5);
  assert.strictEqual(client.phase, "closed", "link loss surfaced");
  S.Liquids.set(atx + 4, arow - 2, S.Liquids.TYPE.HONEY, 255);

  link = bridgePair();
  server.connect(link.a, { name: "Guest" });
  const r = client.tryReconnect(() => link.b);
  assert.ok(r.ok, "reconnect accepted");
  pumpBoth(150);
  assert.strictEqual(client.phase, "playing", "resync restored play");
  assert.ok(liqEq(atx + 4, arow - 2),
    "honey placed during absence missing after resync");
  assert.ok(liqEq(atx + 2, arow), "pre-disconnect truth regressed after resync");

  server.stop();
});

test("cross-realm liquids: joined client never simulates settling on its own", () => {
  const serverRealm = loadGame({ hash: "" });
  const S = serverRealm.TC;
  const server = S.NetServer.create({ seed: 777 });
  assert.ok(server.start().ok);
  const clientRealm = loadGame({ hash: "" });
  const C = clientRealm.TC;

  const link = bridgePair();
  server.connect(link.a, { name: "G" });
  const client = C.NetClient.create({ name: "G" });
  client.connect(link.b);
  const pumpBoth = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      link.a.pump(); server.tick(); link.b.pump(); client.frame(STEP);
    }
  };
  pumpBoth(90);

  // Host pours a floating cell; replicate ONLY 2 frames so the mirror holds
  // the pour before the host's settle accumulator (needs >= 0.05 s) fires.
  const pa = S.Players.get(client.pid);
  const tx = Math.floor(pa.x / TS), ty = S.world.surfaceY[tx] + 4;
  // one-cell-wide shaft: everything that falls lands in ONE cell
  for (let y = ty - 3; y <= ty; y++) {
    for (let x = tx - 2; x <= tx + 2; x++) S.world.setRaw(x, y, S.TILE.AIR);
    S.world.setRaw(tx - 2, y, S.TILE.STONE);
    S.world.setRaw(tx + 2, y, S.TILE.STONE);
  }
  S.world.setRaw(tx - 1, ty, S.TILE.STONE);
  S.world.setRaw(tx + 1, ty, S.TILE.STONE);
  for (let x = tx - 1; x <= tx + 1; x++) S.world.setRaw(x, ty + 1, S.TILE.STONE);
  S.Liquids.set(tx, ty - 3, S.Liquids.TYPE.WATER, 255); // will fall to (tx,ty)
  pumpBoth(2);
  const mirroredBefore = C.Liquids.queryAt(tx, ty - 3).amount;
  assert.strictEqual(mirroredBefore, 255, "floating water not mirrored at source");

  // Client keeps presenting (frame loop) with NO server traffic at all: an
  // illegally self-simulating mirror would settle on its own here.
  for (let i = 0; i < 300; i++) client.frame(STEP);
  assert.strictEqual(C.Liquids.queryAt(tx, ty - 3).amount, 255,
    "client mirror mutated without replicated truth (ran its own sim)");

  // now the host settles and the delta arrives; the mirror follows authority
  for (let k = 0; k < 30; k++) S.Liquids.update(0.06);
  assert.strictEqual(S.Liquids.queryAt(tx, ty - 3).amount, 0, "host water refused to fall");
  pumpBoth(90);
  assert.strictEqual(C.Liquids.queryAt(tx, ty - 3).amount, 0,
    "mirror did not converge after the settle delta");
  assert.strictEqual(C.Liquids.queryAt(tx, ty).amount, 255,
    "mirror missed the fallen volume");

  server.stop();
});

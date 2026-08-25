/* tests/net/crossrealm.test.js — the SHIPPED client controller (TC.NetClient)
   joined to a real TC.NetServer across two isolated VM realms over a
   deterministic bridge. Proves the production join path end-to-end:
   handshake -> snapshot mirror -> authoritative command round-trip ->
   disconnect -> rejoin/resync with edits made while absent. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame } = require("./helpers.js");

const STEP = 1 / 60;

// Deterministic host-side bridge implementing the endpoint contract on both
// ends. send() enqueues for the PEER; pump() delivers this side's inbound.
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
  const a = side("bridge:A");
  const b = side("bridge:B");
  a.peer = b;
  b.peer = a;
  return { a, b };
}

test("cross-realm: real NetClient joins, mirrors world state, round-trips commands and resyncs", () => {
  // ---- authority realm ----
  const serverRealm = loadGame({ hash: "" });
  const S = serverRealm.TC;
  const server = S.NetServer.create({ seed: 4242 });
  const started = server.start();
  assert.ok(started.ok);

  // ---- presentation realm (the joining game instance) ----
  const clientRealm = loadGame({ hash: "" });
  const C = clientRealm.TC;

  let link = bridgePair();
  const connectClient = () => {
    const client = C.NetClient.create({ name: "Guest" });
    client.connect(link.b);
    C.__netClient = client;
    return client;
  };

  // both endpoints need owners: the server attaches to side A
  server.connect(link.a, { name: "Guest" });
  let client = connectClient();

  // drive both realms deterministically until the client is playing
  const pumpBoth = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      link.a.pump();   // frames toward the server
      server.tick();
      link.b.pump();   // frames toward the client
      client.frame(STEP);
    }
  };
  pumpBoth(90);
  assert.strictEqual(client.phase, "playing", "client reached playing phase");
  assert.strictEqual(client.pid ? typeof client.pid : "", "string", "player identity assigned");
  assert.strictEqual(client.seed, 4242, "mirror world uses the authoritative seed");
  assert.ok(C.world, "client realm built its presentation mirror");

  // mirror truth check: spawn-region tiles match the authority exactly
  const SR = S.WorldRegions, CR = C.WorldRegions;
  const pa = S.Players.get(client.pid);
  const anchorIdx = SR.chunkOf(Math.floor(pa.x / TS()), Math.floor(pa.y / TS()));
  function TS() { return 16; }
  const sLayers = regionTiles(S, anchorIdx), cLayers = regionTiles(C, anchorIdx);
  assert.deepEqual(Array.from(cLayers), Array.from(sLayers), "mirror region equals authority");

  // authoritative command round-trip: client proposes a placement, the
  // server validates + executes, the delta replicates back into the mirror
  const px = Math.floor(pa.x / TS()) - 2;
  const py = S.world.surfaceY[px] - 1;
  S.Players.get(client.pid).inventory.add("dirt", 20);
  const before = tileAt(C, px, py);
  assert.strictEqual(before, S.TILE.AIR, "target cell starts air in the mirror too");

  client.sendCmd("PlaceTile", { tx: px, ty: py, item: "dirt" });
  let mirrored = false;
  for (let i = 0; i < 120 && !mirrored; i++) {
    link.a.pump(); server.tick(); link.b.pump(); client.frame(STEP);
    if (tileAt(C, px, py) === S.TILE.DIRT) mirrored = true;
  }
  assert.ok(mirrored, "placement replicated into the client mirror");
  assert.strictEqual(tileAt(S, px, py), S.TILE.DIRT, "authority placed exactly once");

  // ---- disconnect while edits continue ----
  link.a.close();          // kill the server-side transport
  link.b.close();
  pumpBoth(5);
  assert.strictEqual(client.phase, "closed", "link loss surfaced explicitly");

  // world mutates while the client is away
  const editTx = Math.floor(pa.x / TS()) + 1;
  const editTy = S.world.surfaceY[editTx];
  S.world.setRaw(editTx, editTy, S.TILE.AIR);

  // rejoin: fresh transport, SAME identity, resync snapshot
  link = bridgePair();
  server.connect(link.a, { name: "Guest" });   // new shell connection
  const r = client.tryReconnect(() => link.b);
  assert.ok(r.ok, "reconnect accepted");
  const snapsBefore = client.stats.snapshotsApplied;
  pumpBoth(120);
  assert.strictEqual(client.phase, "playing", "resync restored play state");
  assert.ok(client.stats.snapshotsApplied > snapsBefore, "fresh snapshot applied");
  assert.strictEqual(tileAt(C, editTx, editTy), S.TILE.AIR,
    "edit made during absence present after resync");
  assert.strictEqual(tileAt(C, px, py), S.TILE.DIRT, "earlier placement survived resync");

  server.stop();
});

function tileAt(TC, tx, ty) { return TC.world.get(tx, ty); }
function regionTiles(TC, idx) {
  const R = TC.WorldRegions;
  const coords = R.chunkCoords(idx);
  const w = TC.world;
  const out = new Uint8Array(R.CHUNK * R.CHUNK);
  for (let y = 0; y < R.CHUNK; y++) {
    for (let x = 0; x < R.CHUNK; x++) {
      const wx = coords.cx * R.CHUNK + x, wy = coords.cy * R.CHUNK + y;
      out[y * R.CHUNK + x] = w.tiles[wy * w.width + wx];
    }
  }
  return out;
}

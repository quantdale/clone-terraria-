/* tests/net/proto.test.js — hostile protocol validation (NET-002).
   Every malformed shape must fail closed WITHOUT reaching any mutation API. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg } = require("./helpers.js");

const TC = loadGame({ hash: "" }).TC;
const P = TC.NetProto;

function rejects(name, raw) {
  const v = typeof raw === "string" ? P.decode(raw) : P.validate(raw);
  if (typeof raw === "string" && raw.length > 512 * 1024) {
    assert.ok(!v.ok, name + ": oversize must reject");
    return;
  }
  assert.ok(!v.ok, name + ": must be rejected");
}

function accepts(m) {
  const v = P.validate(m);
  assert.ok(v.ok, "valid message rejected: " + (v.error || ""));
}

test("proto: valid baseline messages pass validation", () => {
  accepts(msg("hello", { name: "A" }));
  accepts(msg("input", { btn: [1, 0, 1], aimX: 3.5, aimY: -2 }, { cseq: 7 }));
  accepts(msg("cmd", { name: "MineTile", ctx: { tx: 3, ty: 4 } }, { cseq: 1 }));
  accepts(msg("ack", { upto: { sseq: 3, tick: 9 }, regions: [[5, 12]] }));
});

test("proto: unknown/absent fields and wrong types fail closed", () => {
  // envelope
  rejects("not an object", null);
  rejects("array envelope", []);
  rejects("unknown top-level field", Object.assign(msg("hello", {}), { zzz: 1 }));
  rejects("missing type", { v: 1, p: {}, cseq: 0, sseq: 0, tick: 0 });
  rejects("unknown type", msg("rootkit", {}));
  rejects("bad version", Object.assign(msg("hello", {}), { v: 999 }));
  rejects("float version", Object.assign(msg("hello", {}), { v: 1.5 }));
  rejects("string version", Object.assign(msg("hello", {}), { v: "1" }));
  rejects("negative cseq", msg("input", { btn: [0, 0, 0], aimX: 0, aimY: 0 }, { cseq: -1 }));
  rejects("non-uint tick", Object.assign(msg("hello", {}), { tick: 1.5 }));
  rejects("payload not object", Object.assign(msg("hello", {}), { p: "x" }));
  rejects("payload array", Object.assign(msg("hello", {}), { p: [] }));
  // payload-level
  rejects("unknown payload field", msg("hello", { name: "A", hack: true }));
  rejects("name too long", msg("hello", { name: "x".repeat(25) }));
  rejects("btn wrong arity", msg("input", { btn: [1, 0], aimX: 0, aimY: 0 }));
  rejects("btn non-int", msg("input", { btn: [0.5, 0, 0], aimX: 0, aimY: 0 }));
  rejects("btn out of range", msg("input", { btn: [5, 0, 0], aimX: 0, aimY: 0 }));
  rejects("aim NaN", msg("input", { btn: [0, 0, 0], aimX: NaN, aimY: 0 }));
  rejects("aim infinite", msg("input", { btn: [0, 0, 0], aimX: Infinity, aimY: 0 }));
  rejects("use not bool-ish", msg("input", { btn: [0, 0, 0], aimX: 0, aimY: 0, use: 2 }));
  rejects("unknown command", msg("cmd", { name: "SpawnItem", ctx: {} }));
  rejects("command ctx not object", msg("cmd", { name: "MineTile", ctx: "x" }));
  rejects("cmdres bad ok", msg("cmdres", { ref: 1, ok: "yes" }));
  rejects("ack region bad tuple", msg("ack", { upto: { sseq: 1, tick: 1 }, regions: [[1]] }));
  rejects("bye reason too long", msg("bye", { reason: "x".repeat(65) }));
});

test("proto: decode fails closed on garbage and oversize frames", () => {
  rejects("empty frame", "");
  rejects("not json", "{{{");
  rejects("json scalar", "42");
  const big = JSON.stringify(msg("hello", { name: "y".repeat(600 * 1024) }));
  rejects("oversize frame", big);
});

test("proto: region codec round-trips and diffs deterministically", () => {
  const tiles = new Uint8Array(1024);
  const walls = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) { tiles[i] = i % 251; walls[i] = (i * 7) % 200; }
  const full = P.buildFullRegion(17, 42, tiles, walls);
  const decT = new Uint8Array(1024), decW = new Uint8Array(1024);
  // decode via the same hex path the client uses
  for (let i = 0; i < 1024; i++) {
    decT[i] = parseInt(full.tiles.substr(i * 2, 2), 16);
    decW[i] = parseInt(full.walls.substr(i * 2, 2), 16);
  }
  assert.deepEqual(decT, tiles, "tile layer round-trip");
  assert.deepEqual(decW, walls, "wall layer round-trip");

  const curT = tiles.slice(), curW = walls.slice();
  curT[10] = (tiles[10] + 1) % 250; curW[999] = (walls[999] + 1) % 200;
  const cells = P.diffRegion(tiles, walls, curT, curW);
  // cross-realm arrays: compare by value, not prototype
  assert.strictEqual(JSON.stringify(cells), JSON.stringify([[10, curT[10], walls[10]], [999, curT[999], curW[999]]]),
    "only changed cells diffed");
});

test("proto: digests are stable and order-insensitive where required", () => {
  const worldish = { tiles: new Uint8Array([1, 2, 3]), walls: new Uint8Array([4]) };
  const d1 = P.digestWorld(worldish);
  const d2 = P.digestWorld({ tiles: new Uint8Array([1, 2, 3]), walls: new Uint8Array([4]) });
  assert.strictEqual(d1, d2, "identical state -> identical digest");
  assert.notStrictEqual(d1, P.digestWorld({ tiles: new Uint8Array([1, 2, 4]), walls: new Uint8Array([4]) }));
  const pl = [
    { id: "p2", x: 1, y: 2, hp: 10, maxHp: 20, vx: 0, vy: 0 },
    { id: "p1", x: 3, y: 4, hp: 5, maxHp: 20, vx: 1, vy: 0 }
  ];
  assert.strictEqual(P.digestPlayers(pl), P.digestPlayers(pl.slice().reverse()),
    "player digest is id-sorted");
});

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
  rejects("missing type", { v: TC.NetProto.VERSION, p: {}, cseq: 0, sseq: 0, tick: 0 });
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

test("proto: region codec round-trips and diffs deterministically (v3 liquid layers)", () => {
  const tiles = new Uint8Array(1024);
  const walls = new Uint8Array(1024);
  const ltype = new Uint8Array(1024);
  const lamt = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    tiles[i] = i % 251; walls[i] = (i * 7) % 200;
    ltype[i] = i % 4; lamt[i] = (i * 13) % 256;
  }
  const full = P.buildFullRegion(17, 42, tiles, walls, ltype, lamt);
  const decT = new Uint8Array(1024), decW = new Uint8Array(1024);
  const decLT = new Uint8Array(1024), decLA = new Uint8Array(1024);
  // decode via the same hex path the client uses
  for (let i = 0; i < 1024; i++) {
    decT[i] = parseInt(full.tiles.substr(i * 2, 2), 16);
    decW[i] = parseInt(full.walls.substr(i * 2, 2), 16);
    decLT[i] = parseInt(full.ltype.substr(i * 2, 2), 16);
    decLA[i] = parseInt(full.lamt.substr(i * 2, 2), 16);
  }
  assert.deepEqual(decT, tiles, "tile layer round-trip");
  assert.deepEqual(decW, walls, "wall layer round-trip");
  assert.deepEqual(decLT, ltype, "liquid type layer round-trip");
  assert.deepEqual(decLA, lamt, "liquid amount layer round-trip");
  assert.ok(P.validate({ v: P.VERSION, t: "worldupd", sid: null, pid: null,
    cseq: 0, sseq: 0, tick: 0,
    p: { regions: [full], players: [], enemies: [], drops: [] } }).ok,
    "v3 full region line validates");
  // identical state -> identical encoding (deterministic bytes)
  const full2 = P.buildFullRegion(17, 42, tiles, walls, ltype, lamt);
  assert.strictEqual(JSON.stringify(full), JSON.stringify(full2),
    "identical region state -> identical encoding");

  const cur = { tiles: tiles.slice(), walls: walls.slice(),
    ltype: ltype.slice(), lamt: lamt.slice() };
  cur.tiles[10] = (tiles[10] + 1) % 250;
  cur.walls[999] = (walls[999] + 1) % 200;
  cur.ltype[500] = 3; cur.lamt[777] = (lamt[777] + 40) % 256;
  const cells = P.diffRegion({ tiles, walls, ltype, lamt }, cur);
  // Expected per the v3 compact rule: a changed DRY cell encodes as a
  // triple [i,t,w] (implying no liquid); a changed WET cell restates all
  // five authoritative fields.
  const expected = [];
  const prevAll = { tiles, walls, ltype, lamt };
  for (let i = 0; i < 1024; i++) {
    const ch = prevAll.tiles[i] !== cur.tiles[i] || prevAll.walls[i] !== cur.walls[i] ||
      prevAll.ltype[i] !== cur.ltype[i] || prevAll.lamt[i] !== cur.lamt[i];
    if (!ch) continue;
    if (cur.ltype[i] === 0 && cur.lamt[i] === 0) expected.push([i, cur.tiles[i], cur.walls[i]]);
    else expected.push([i, cur.tiles[i], cur.walls[i], cur.ltype[i], cur.lamt[i]]);
  }
  assert.strictEqual(JSON.stringify(cells), JSON.stringify(expected),
    "diff matches the compact-dry/wet-quintuple rule exactly");
  assert.ok(cells.every((c) => [10, 500, 777, 999].includes(c[0])),
    "only the four genuinely changed cells appear");

  // applyCells restores all four layers exactly
  const out = { tiles: tiles.slice(), walls: walls.slice(),
    ltype: ltype.slice(), lamt: lamt.slice() };
  out.tiles[10] ^= 0xff; out.lamt[500] = 9;
  P.applyCells(out.tiles, out.walls, cells, out.ltype, out.lamt);
  assert.deepEqual(out.tiles, cur.tiles, "delta applies tiles");
  assert.deepEqual(out.ltype, cur.ltype, "delta applies liquid types");
  assert.deepEqual(out.lamt, cur.lamt, "delta applies liquid amounts");
});

test("proto: stale protocol versions are rejected cleanly (v3 gate)", () => {
  for (const v of [1, 2, 4, 99]) {
    const m = msg("hello", { name: "A" });
    m.v = v;
    rejects("v" + v + " rejected", m);
  }
  // the rejection names the expected version so old clients get a clean signal
  const bad = msg("hello", { name: "A" });
  bad.v = 2;
  const res = P.validate(bad);
  assert.ok(!res.ok && /expected 3/.test(res.error || ""),
    "v2 rejection states expected version");
});

test("proto: liquid region lines fail closed on malformed shapes (W24)", () => {
  // a WET region carries both layers; a DRY one omits them (authoritative
  // absence) — build wet fixtures so partial-layer mutations are meaningful
  const mkWet = () => {
    const lt = new Uint8Array(1024); const la = new Uint8Array(1024);
    lt[7] = 1; la[7] = 9;
    return P.buildFullRegion(0, 1,
      new Uint8Array(1024), new Uint8Array(1024), lt, la);
  };
  // a genuinely dry region encodes WITHOUT liquid keys and validates
  const dry = P.buildFullRegion(0, 1,
    new Uint8Array(1024), new Uint8Array(1024),
    new Uint8Array(1024), new Uint8Array(1024));
  assert.ok(dry.ltype === undefined && dry.lamt === undefined,
    "dry regions must omit liquid layers (payload economy)");
  accepts((() => ({ v: P.VERSION, t: "worldupd", sid: null, pid: null,
    cseq: 0, sseq: 0, tick: 0,
    p: { regions: [dry], players: [], enemies: [], drops: [] } }))());

  const worldupd = (regions) => ({ v: P.VERSION, t: "worldupd", sid: null,
    pid: null, cseq: 0, sseq: 0, tick: 0, p: { regions, players: [], enemies: [], drops: [] } });

  // partial layer sets are ambiguous — never validate
  const missingLamt = mkWet();
  delete missingLamt.lamt;
  rejects("full line missing lamt", worldupd([missingLamt]));
  const missingLT = mkWet();
  delete missingLT.ltype;
  rejects("full line missing ltype", worldupd([missingLT]));

  // unequal layer lengths fail closed
  const shortLayers = mkWet();
  shortLayers.ltype = "00".repeat(1023);
  rejects("ltype shorter than tiles", worldupd([shortLayers]));

  // unknown region fields are rejected
  const extra = mkWet();
  extra.zorp = 1;
  rejects("unknown region field", worldupd([extra]));

  // delta cells may be compact triples (dry — zeros implied by v3) or full
  // quintuples; anything else is malformed and rejected
  const goodQuint = { idx: 3, rev: 7, cells: [[5, 0, 0, 0, 0]] };
  accepts(worldupd([goodQuint]));
  const goodTriple = { idx: 3, rev: 7, cells: [[5, 0, 0]] };
  accepts(worldupd([goodTriple]));
  const mixedLine = { idx: 3, rev: 7, cells: [[5, 0, 0], [6, 1, 2, 3, 4]] };
  accepts(worldupd([mixedLine]));
  rejects("delta cell quadruple", worldupd([{ idx: 3, rev: 7, cells: [[5, 0, 0, 0]] }]));
  rejects("delta cell sextuple", worldupd([{ idx: 3, rev: 7, cells: [[5, 0, 0, 0, 0, 9]] }]));
  rejects("liq type out of range", worldupd([{ idx: 3, rev: 7, cells: [[5, 0, 0, 256, 0]] }]));
  rejects("liq amount negative", worldupd([{ idx: 3, rev: 7, cells: [[5, 0, 0, -1, 0]] }]));
  rejects("cell idx over region size", worldupd([{ idx: 3, rev: 7, cells: [[1024, 0, 0, 0, 0]] }]));
  rejects("float liq amount", worldupd([{ idx: 3, rev: 7, cells: [[5, 0, 0, 1, 1.5]] }]));
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

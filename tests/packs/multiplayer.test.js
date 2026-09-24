/* tests/packs/multiplayer.test.js — WS7/WS11: gameplay pack-set identity on
   the v4 handshake. Matching sets join; mismatches reject BEFORE any player
   entity binds or world state moves; resource-only differences are
   explicitly compatible. */
'use strict';
const test = require("node:test");
const assert = require("node:assert");
const path = require('path');
const { loadGame, makeDriver, msg } = require("../net/helpers.js");

function bootHost(seed) {
  const { TC } = loadGame({});
  TC.Packs.setActive(["testpack"]);
  const server = TC.NetServer.create({ seed: seed == null ? 4242 : seed });
  const r = server.start();
  assert.ok(r.ok, "server start failed");
  return { TC, server };
}

test("mp packs: matching gameplay set joins and the welcome echoes identity", () => {
  const { TC, server } = bootHost();
  const A = makeDriver("A");
  assert.ok(server.connect(A.ep, { name: "Alpha" }).ok);
  A.ep.feed(msg("hello", {
    name: "Alpha",
    packs: { fp: TC.Packs.digest(), list: ["testpack@1.0.0"] },
  }));
  server.processInbound();
  const welcome = A.outbox.find((m) => m.t === "welcome");
  assert.ok(welcome, "join accepted with matching pack set");
  assert.ok(welcome.p.packs, "welcome carries pack identity");
  assert.strictEqual(welcome.p.packs.fp, TC.Packs.digest());
});

test("mp packs: digest mismatch rejects before binding a player", () => {
  const { TC, server } = bootHost();
  const before = TC.Players.count();
  const A = makeDriver("A");
  assert.ok(server.connect(A.ep, { name: "Mallory" }).ok);
  A.ep.feed(msg("hello", {
    name: "Mallory",
    packs: { fp: "deadbeef", list: ["otherpack@9.9.9"] },
  }));
  server.processInbound();
  const reject = A.outbox.find((m) => m.t === "reject");
  assert.ok(reject, "mismatch rejected");
  assert.ok(/content-mismatch/.test(reject.p.reason), "reason names the mismatch");
  assert.strictEqual(TC.Players.count(), before, "no player entity leaked");
  assert.strictEqual(A.outbox.some((m) => m.t === "welcome" || m.t === "snapshot"), false,
    "no world state ever flowed to the rejected peer");

  // rejoining a detached identity with wrong packs must also be refused
  // (gate sits in front of ALL hello paths)
  const B = makeDriver("B");
  assert.ok(server.connect(B.ep, { name: "Rejoiner" }).ok);
  B.ep.feed(msg("hello", {
    name: "Rejoiner",
    packs: { fp: "", list: [] },
    rejoin: { sid: server.sid, pid: "p_ghost", tick: 0 },
  }));
  server.processInbound();
  const rj = B.outbox.find((m) => m.t === "reject");
  assert.ok(rj && /content-mismatch/.test(rj.p.reason),
    "rejoin path gated by the same check");
});

test("mp packs: resource-only difference stays compatible end to end", () => {
  const { TC } = loadGame({});
  TC.Packs.provide({
    manifest: 1, id: "skins", name: "Skins", version: "1.0.0", type: "resource",
    resources: { locale: { en: { ui: { menu: { new_world: "NEW!" } } } } },
  });
  TC.Packs.setActive(["skins", "testpack"]);
  const server = TC.NetServer.create({ seed: 4242 });
  assert.ok(server.start().ok, "server start failed");
  const host = { TC, server };
  const clientRealm = loadGame({});
  const TCc = clientRealm.TC;
  // client runs the same GAMEPLAY set but WITHOUT the resource pack
  TCc.Packs.setActive(["testpack"]);
  assert.strictEqual(TCc.Packs.digest(), host.TC.Packs.digest(),
    "resource packs never enter the gameplay fingerprint");

  const C = makeDriver("C");
  assert.ok(host.server.connect(C.ep, { name: "Guest" }).ok);
  C.ep.feed(msg("hello", {
    name: "Guest",
    packs: { fp: TCc.Packs.digest(), list: ["testpack@1.0.0"] },
  }));
  host.server.processInbound();
  const welcome = C.outbox.find((m) => m.t === "welcome");
  assert.ok(welcome, "resource-only difference joins fine");
});


test("mp packs: gameplay digest covers resource-induced dense order", () => {
  function realm(includeResource) {
    const TC = loadGame({}).TC;
    TC.Packs.provide({
      manifest: 1, id: "b_pack", name: "B", version: "1.0.0", type: "data",
      content: { items: [{ key: "b_item", name: "B", kind: "material" }] },
    });
    TC.Packs.provide({
      manifest: 1, id: "bridge_res", name: "Bridge", version: "1.0.0", type: "resource",
      requires: { packs: { b_pack: "^1.0.0" } },
      resources: { locale: { en: { ui: { packs: { hint: "BRIDGE" } } } } },
    });
    TC.Packs.provide({
      manifest: 1, id: "a_pack", name: "A", version: "1.0.0", type: "data",
      optional: { packs: { bridge_res: "^1.0.0" } },
      content: { items: [{ key: "a_item", name: "A", kind: "material" }] },
    });
    const requested = includeResource ? ["a_pack", "b_pack", "bridge_res"] : ["a_pack", "b_pack"];
    TC.Packs.setActive(requested);
    return TC;
  }
  const withoutResource = realm(false);
  const withResource = realm(true);
  assert.notStrictEqual(withoutResource.Packs.digest(), withResource.Packs.digest());
  assert.strictEqual(withoutResource.Packs.active().join(","), "a_pack,b_pack");
  assert.strictEqual(withResource.Packs.active().join(","), "b_pack,bridge_res,a_pack");
});

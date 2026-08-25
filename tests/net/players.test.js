/* tests/net/players.test.js — TC.Players identity registry (W22 §4):
   stable ids, primary aliasing, remote mirrors, teardown hygiene. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame } = require("./helpers.js");

const { TC } = loadGame({ hash: "" });

function fakePlayer(x, y) {
  return { x: x || 0, y: y || 0, vx: 0, vy: 0, hp: 100, maxHp: 100, w: 12, h: 21 };
}

test("players: create assigns stable ids and elects the first local as primary", () => {
  TC.Players.resetForNewWorld();
  const a = TC.Players.create(fakePlayer(1, 2), { id: "pA" });
  assert.ok(a, "first create ok");
  assert.strictEqual(a.id, "pA", "explicit id honored");
  assert.strictEqual(TC.Players.primaryId(), "pA", "local auto-primary");
  assert.strictEqual(TC.player, a.player, "TC.player aliases the primary");

  const b = TC.Players.create(fakePlayer(3, 4), {}); // auto id
  assert.notStrictEqual(b.id, "pA", "auto ids are unique");
  assert.strictEqual(TC.Players.count(), 2);
});

test("players: duplicate explicit id is rejected with a fresh unique id", () => {
  TC.Players.resetForNewWorld();
  const a = TC.Players.create(fakePlayer(), { id: "px" });
  const b = TC.Players.create(fakePlayer(), { id: "px" });
  assert.notStrictEqual(a.id, b.id);
});

test("players: remote entities never become primary; removal re-elects locals", () => {
  TC.Players.resetForNewWorld();
  const host = TC.Players.create(fakePlayer(), { id: "h1" });
  const r = TC.Players.create(fakePlayer(), { id: "r1", remote: true });
  assert.strictEqual(TC.Players.primaryId(), "h1", "remote did not steal primary");
  assert.strictEqual(TC.Players.remove("h1"), true);
  // only remotes remain: singleton must NOT alias a mirror
  assert.strictEqual(TC.Players.primaryId(), null);
  assert.strictEqual(TC.player, null, "no silent mirror aliasing");
  TC.Players.remove("r1");
  const again = TC.Players.create(fakePlayer(), {});
  assert.strictEqual(TC.player, again.player, "re-election restores alias");
});

test("players: retainOnly drops everything else (session teardown hygiene)", () => {
  TC.Players.resetForNewWorld();
  const a = TC.Players.create(fakePlayer(), { id: "keep" });
  TC.Players.create(fakePlayer(), { id: "drop1", remote: true });
  TC.Players.create(fakePlayer(), { id: "drop2" });
  TC.Players.retainOnly(["keep"]);
  assert.strictEqual(TC.Players.count(), 1);
  assert.strictEqual(TC.Players.get("drop1"), null);
  assert.strictEqual(TC.Players.get("drop2"), null);
  assert.strictEqual(TC.Players.primary(), a.player);
});

test("players: resetForNewWorld clears all state so sessions cannot leak", () => {
  TC.Players.create(fakePlayer(), { id: "z" });
  TC.Players.resetForNewWorld();
  assert.strictEqual(TC.Players.count(), 0);
  assert.strictEqual(TC.Players.primaryId(), null);
});

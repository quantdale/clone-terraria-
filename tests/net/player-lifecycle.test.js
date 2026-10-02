/* tests/net/player-lifecycle.test.js — TC.Players coherence across world
   transitions (fix-player-registry-world-transition). */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg } = require("./helpers.js");

function join(server, driver, name) {
  const c = server.connect(driver.ep, { name });
  assert.ok(c.ok, "connect ok");
  driver.ep.feed(msg("hello", { name }));
  server.processInbound();
  const welcome = driver.outbox.find((m) => m.t === "welcome");
  assert.ok(welcome, "welcome received");
  return welcome.p.you.pid;
}

test("lifecycle: host → join → leave → quit/save → new world → continue", () => {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed: 9021 });
  // hosting a running world requires adoptWorld for an existing world; a
  // fresh server owns its world
  const r = server.start();
  assert.ok(r.ok);
  const hostPlayer = TC.player;
  const a = server.attachLocal();
  assert.ok(a.ok);
  assert.strictEqual(TC.Players.count(), 1, "attachLocal returned the existing p1");
  assert.strictEqual(TC.Players.primaryId(), "p1");
  assert.strictEqual(TC.Players.primary(), hostPlayer);

  const A = makeDriver("A");
  const pidA = join(server, A, "Alpha");
  assert.strictEqual(TC.Players.count(), 2, "join seats the remote");

  // client leaves via transport death: identity parks for reconnect
  const deadConn = [...server.conns.values()].find((c) => c.pid === pidA);
  server._dropConn(deadConn, "transport-closed", false);
  assert.strictEqual(server.detached.size, 1, "identity parked for reconnect");
  assert.strictEqual(TC.Players.count(), 2, "parked identity still registered");

  server.stop();
  assert.strictEqual(TC.Players.count(), 1, "stop retains only the local primary");
  assert.strictEqual(server.detached.size, 0, "detached identities die with stop");
  const oldPrimary = TC.Players.primary();
  assert.strictEqual(oldPrimary, hostPlayer, "stop did not drop the local primary");

  TC.quitToTitle();
  assert.strictEqual(TC.state, "title");
  assert.ok(TC.Save.hasSave(), "quit wrote a save");

  const saved = TC.Save.load();
  assert.ok(saved && saved.player, "save still carries the host player");

  // New world after a host session: the registry must be rebuilt, and the
  // new player must be the simulated one.
  TC.newGame(777);
  assert.strictEqual(TC.Players.count(), 1, "registry rebuilt for the new world");
  const newPlayer = TC.player;
  assert.ok(newPlayer !== hostPlayer, "new player object");
  assert.strictEqual(TC.Players.primary(), newPlayer, "new player is the primary");
  assert.ok(!TC.Players.all().includes(hostPlayer), "old player not in registry");
  assert.strictEqual(TC.Targets.anchor(), newPlayer, "Targets resolves to the live player");

  // The new player is the one advanced by the simulation; the old one is not
  // stepped anymore (it is no longer referenced by the registry).
  const oldY = hostPlayer.y, newY0 = newPlayer.y;
  newPlayer.y -= 96;                 // lift into the air so gravity must act
  newPlayer.vy = 0;
  TC.Runtime.advanceTicks(30);
  assert.strictEqual(hostPlayer.y, oldY, "old player is not simulated");
  assert.notStrictEqual(newPlayer.y, newY0 - 96, "new player advanced");

  // Continue the saved world: the stored host character comes back as the
  // sole registered primary.
  TC.continueGame();
  assert.strictEqual(TC.Players.count(), 1);
  assert.strictEqual(TC.Players.primary(), TC.player, "save character is the primary");
  assert.strictEqual(TC.Players.primaryId(), "p1");
});

test("createWorld without attachLocal does not pre-register; first remote gets p1", () => {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed: 313 });
  assert.ok(server.start().ok);
  assert.strictEqual(TC.Players.count(), 0, "no local primary registered");
  const A = makeDriver("A");
  const pidA = join(server, A, "Solo");
  assert.strictEqual(pidA, "p1", "first remote takes p1");
  server.stop();
});

test("refused pack-incompatible continue does not reset the registry", () => {
  const { TC } = loadGame({ hash: "" });
  TC.newGame(42);
  const seated = TC.Players.count();
  assert.strictEqual(seated, 1);
  const realSaveLoad = TC.Save.load;
  const realClassify = TC.Packs.classifySave;
  TC.Save.load = () => ({ __envelope: { packs: "garbage" } });
  TC.Packs.classifySave = () => ({ ok: false, problems: ["boom"] });
  let dialogShown = false;
  const ui = TC.UI;
  const realDialog = ui.showPackProblem;
  ui.showPackProblem = () => { dialogShown = true; };
  try {
    TC.continueGame();
    assert.ok(dialogShown, "problem surfaced");
    assert.strictEqual(TC.Players.count(), seated, "registry untouched");
    assert.strictEqual(TC.state, "playing", "still in the current world");
  } finally {
    TC.Save.load = realSaveLoad;
    TC.Packs.classifySave = realClassify;
    ui.showPackProblem = realDialog;
  }
});

test("attachLocal is idempotent after newGame already seated the player", () => {
  const { TC } = loadGame({ hash: "" });
  TC.newGame(555);
  const server = TC.NetServer.create({ seed: 555, adoptWorld: true });
  const r = server.start();
  assert.ok(r.ok);
  const a1 = server.attachLocal();
  assert.ok(a1.ok && a1.pid === "p1");
  const a2 = server.attachLocal();
  assert.strictEqual(a2.pid, "p1");
  assert.strictEqual(TC.Players.count(), 1);
  server.stop();
});

test("create idempotence holds across a browser re-seat", () => {
  const { TC } = loadGame({ hash: "" });
  TC.newGame(888);
  const p = TC.player;
  const rec1 = TC.Players.create(p, { primary: true });
  const rec2 = TC.Players.create(p, { primary: true });
  assert.strictEqual(rec1, rec2);
  assert.strictEqual(TC.Players.count(), 1);
});

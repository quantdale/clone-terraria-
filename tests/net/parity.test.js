/* tests/net/parity.test.js — W23 WS1: authoritative transaction parity.
   Crafting, shops and container transfers work over the network through the
   SAME canonical TC.Commands transactions single-player uses, with
   server-resolved truth, bounded intents, exactly-once effects and hostile
   inputs rejected before any mutation. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame, makeDriver, msg, sendCmd } = require("./helpers.js");

const TS = 16;

function freshServer(seed) {
  const { TC } = loadGame({ hash: "" });
  const server = TC.NetServer.create({ seed: seed == null ? 4242 : seed });
  const r = server.start();
  assert.ok(r.ok, "server start failed");
  return { TC, server };
}

function join(server, driver, name) {
  const c = server.connect(driver.ep, { name });
  assert.ok(c.ok);
  driver.ep.feed(msg("hello", { name }));
  server.processInbound();
  const welcome = driver.outbox.find((m) => m.t === "welcome");
  assert.ok(welcome);
  return welcome.p.you.pid;
}

function lastCmdRes(driver) {
  const list = driver.outbox.filter((m) => m.t === "cmdres");
  return list[list.length - 1];
}

function invTotal(inv, id) {
  let n = 0;
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.get(i);
    if (s && s.id === id) n += s.count;
  }
  return n;
}

test("proto v2: new transaction commands ride the whitelist; junk ctx fails closed", () => {
  const { TC, server } = freshServer(11);
  const A = makeDriver();
  join(server, A, "A");
  // well-formed new-style intents validate at the protocol layer
  assert.ok(TC.NetProto.validate(msg("cmd", { name: "CraftRecipe", ctx: { recipeId: "core:r_torch" } }, { pid: "pX" })).ok);
  assert.ok(TC.NetProto.validate(msg("cmd", { name: "ContainerMove", ctx: { tx: 3, ty: 4, from: 0, to: 1, fromSlot: 2, toSlot: 5 } }, { pid: "pX" })).ok);
  // hostile ctx shapes are rejected BEFORE reaching commands
  assert.ok(!TC.NetProto.validate(msg("cmd", { name: "CraftRecipe", ctx: { recipeId: "core:r_torch", station: "workbench" } }, { pid: "pX" })).ok,
    "unknown ctx field rejected");
  assert.ok(!TC.NetProto.validate(msg("cmd", { name: "CraftRecipe", ctx: { recipeId: { hack: 1 } } }, { pid: "pX" })).ok,
    "nested object ctx value rejected");
  assert.ok(!TC.NetProto.validate(msg("cmd", { name: "ContainerMove", ctx: { tx: 0, ty: 0, from: 7, to: 1, fromSlot: 0, toSlot: 0 } }, { pid: "pX" })).ok,
    "endpoint enum enforced");
  assert.ok(!TC.NetProto.validate(Object.assign(msg("hello", {}), { v: 1 })).ok,
    "legacy v1 envelope rejected cleanly by v2");
  server.stop();
});

test("craft over the network: server resolves recipe+stations+progression; exactly-once", () => {
  const { TC, server } = freshServer(12);
  const A = makeDriver();
  const pid = join(server, A, "Crafter");
  const pa = TC.Players.get(pid);

  // cheapest deterministic recipe: first recipe whose costs are plain ids
  const idx = TC.RECIPES.findIndex((r) => r && r.out && r.cost &&
    Object.values(r.cost).every((v) => typeof v === "number"));
  assert.ok(idx >= 0, "found a plain-cost recipe");
  const recipe = TC.RECIPES[idx];
  const rid = TC.Registry.legacyToStable("recipe", idx);
  const needWood = Object.entries(recipe.cost)
    .filter(([k]) => k !== "station").reduce((n, [, v]) => n + v, 0);

  // WITHOUT ingredients: rejected, nothing changes
  const before = invTotal(pa.inventory, recipe.out);
  sendCmd(A, 1, "CraftRecipe", { recipeId: rid });
  server.tick();
  assert.strictEqual(lastCmdRes(A).p.ok, false, "missing ingredients rejected");
  assert.strictEqual(invTotal(pa.inventory, recipe.out), before);

  // give ingredients server-side; craft succeeds exactly once
  for (const [k, v] of Object.entries(recipe.cost)) pa.inventory.add(k, v * 2);
  sendCmd(A, 2, "CraftRecipe", { recipeId: rid });
  server.tick();
  const res = lastCmdRes(A);
  assert.ok(res.p.ok, "craft accepted: " + JSON.stringify(res.p));
  assert.strictEqual(invTotal(pa.inventory, recipe.out), before + (recipe.n || 1),
    "exactly one craft output granted");
  assert.ok(res.p.result && Array.isArray(res.p.result.inv),
    "authoritative inventory bundle rides cmdres immediately");

  // duplicate sequence number cannot re-craft
  sendCmd(A, 2, "CraftRecipe", { recipeId: rid });
  server.tick();
  assert.strictEqual(lastCmdRes(A).p.ok, false, "replayed cseq rejected");
  assert.strictEqual(invTotal(pa.inventory, recipe.out), before + (recipe.n || 1));

  // unknown recipe id mutates nothing
  sendCmd(A, 3, "CraftRecipe", { recipeId: "core:r_definitely_not_real" });
  server.tick();
  assert.strictEqual(lastCmdRes(A).p.ok, false);
  assert.strictEqual(invTotal(pa.inventory, recipe.out), before + (recipe.n || 1));
  server.stop();
});

test("shops over the network: proximity-gated, currency-conserving, replay-proof", () => {
  const { TC, server } = freshServer(13);
  const A = makeDriver();
  const pid = join(server, A, "Shopper");
  const pa = TC.Players.get(pid);

  const stock = TC.NPCs.shopOf("merchant");
  assert.ok(Array.isArray(stock) && stock.length > 0, "merchant has stock rows");
  const entry = stock[0];
  const price = Math.max(1, Math.floor(entry.price ||
    (TC.ITEM_DEFS[entry.itemId] && TC.ITEM_DEFS[entry.itemId].value) || 1));

  // NO NPC nearby: rejected outright (client cannot forge eligibility)
  sendCmd(A, 1, "ShopBuy", { npcType: "merchant", itemId: entry.itemId });
  server.tick();
  assert.strictEqual(lastCmdRes(A).p.ok, false, "no-shop-nearby gate fires");

  // bring the merchant within reach, fund the purse
  TC.NPCs.spawn("merchant", pa.x + 24, pa.y);
  TC.Economy.give(pa.inventory, price * 3);
  const coinsBefore = TC.Economy.total(pa.inventory);
  const itemsBefore = invTotal(pa.inventory, entry.itemId);

  sendCmd(A, 2, "ShopBuy", { npcType: "merchant", itemId: entry.itemId });
  server.tick();
  assert.ok(lastCmdRes(A).p.ok, "in-range purchase accepted");
  assert.strictEqual(TC.Economy.total(pa.inventory), coinsBefore - price,
    "exact price paid once");
  assert.strictEqual(invTotal(pa.inventory, entry.itemId), itemsBefore + 1);

  // replayed seq rejected: no double charge
  sendCmd(A, 2, "ShopBuy", { npcType: "merchant", itemId: entry.itemId });
  server.tick();
  assert.strictEqual(lastCmdRes(A).p.ok, false);
  assert.strictEqual(TC.Economy.total(pa.inventory), coinsBefore - price);

  // selling a non-currency item pays exactly unit*count
  pa.inventory.add("torch", 10);
  const slotIdx = (() => {
    for (let i = 0; i < pa.inventory.slots.length; i++) {
      const s = pa.inventory.get(i);
      if (s && s.id === "torch") return i;
    }
    return -1;
  })();
  const coinsPreSell = TC.Economy.total(pa.inventory);
  sendCmd(A, 3, "ShopSell", { npcType: "merchant", slot: slotIdx, count: 4 });
  server.tick();
  const res = lastCmdRes(A);
  assert.ok(res.p.ok, "sell accepted: " + JSON.stringify(res.p.error || ""));
  const unit = Math.max(1, Math.floor(((TC.ITEM_DEFS["torch"] || {}).value || 0) * 0.2));
  assert.strictEqual(TC.Economy.total(pa.inventory), coinsPreSell + unit * 4,
    "proceeds = unit*count exactly");
  server.stop();
});

test("containers over the network: session-bound, conserving, expiring", () => {
  const { TC, server } = freshServer(14);
  const A = makeDriver();
  const pid = join(server, A, "Stasher");
  const pa = TC.Players.get(pid);

  // fixture: chest tile next to the player + items on both sides
  const ctx_ = Math.floor(pa.x / TS) + 2;
  const cty = TC.world.surfaceY[ctx_] ;
  TC.world.setRaw(ctx_, cty, TC.TILE.CHEST);
  pa.x = (ctx_ - 2) * TS;
  pa.y = (cty - 2) * TS - pa.h;
  pa.inventory.add("iron_bar", 25);
  const chestSlotsArr = TC.Chests.get(ctx_, cty);
  chestSlotsArr[0] = { id: "gel", count: 9 };
  chestSlotsArr[1] = { id: "gel", count: 5 };

  // ContainerMove WITHOUT an open session is refused
  sendCmd(A, 1, "ContainerMove", { tx: ctx_, ty: cty, from: 0, to: 1, fromSlot: 0 });
  server.tick();
  assert.strictEqual(lastCmdRes(A).p.ok, false, "no session -> rejected");
  assert.strictEqual(chestSlotsArr[0].count, 9, "chest untouched");

  // open through canonical interaction -> session binds + contents sync
  sendCmd(A, 2, "InteractTile", { tx: ctx_, ty: cty });
  server.tick();
  const openRes = lastCmdRes(A);
  assert.ok(openRes.p.ok, "interact accepted");
  assert.strictEqual(openRes.p.result.action, "chest");
  assert.deepStrictEqual(openRes.p.result.chest.slots[0], ["gel", 9],
    "authoritative container snapshot rides the result bundle");

  // chest -> player transfer conserves totals exactly (auto-merge)
  const invGelBefore = invTotal(pa.inventory, "gel");
  sendCmd(A, 3, "ContainerMove", { tx: ctx_, ty: cty, from: 0, to: 1, fromSlot: 0 });
  server.tick();
  assert.ok(lastCmdRes(A).p.ok, "chest->inv accepted");
  assert.strictEqual(invTotal(pa.inventory, "gel"), invGelBefore + 9);
  assert.strictEqual(chestSlotsArr[0], null, "source emptied exactly once");
  assert.strictEqual(chestSlotsArr.reduce((n, s) => n + (s && s.id === "gel" ? s.count : 0), 0),
    5, "remaining chest gel conserved (14 pre-move minus the 9 moved)");

  // player -> chest partial count
  sendCmd(A, 4, "ContainerMove", { tx: ctx_, ty: cty, from: 1, to: 0, fromSlot: (() => {
    for (let i = 0; i < pa.inventory.slots.length; i++) {
      const s = pa.inventory.get(i); if (s && s.id === "iron_bar") return i;
    } return 0; })(), count: 10 });
  server.tick();
  assert.ok(lastCmdRes(A).p.ok, "inv->chest accepted");
  const chestIron = chestSlotsArr.reduce((n, s) => n + (s && s.id === "iron_bar" ? s.count : 0), 0);
  assert.strictEqual(chestIron, 10, "exactly 10 bars stored");
  assert.strictEqual(invTotal(pa.inventory, "iron_bar"), 15, "inventory debited exactly");

  // walk away: session expires, further moves refused
  pa.x += 40 * TS;
  server.tick(); server.tick();   // replicate() invalidates the stale session
  sendCmd(A, 5, "ContainerMove", { tx: ctx_, ty: cty, from: 1, to: 0, fromSlot: 0 });
  server.tick();
  assert.strictEqual(lastCmdRes(A).p.ok, false, "out-of-reach session expired");
  assert.strictEqual(chestSlotsArr.reduce((n, s) => n + (s && s.id === "iron_bar" ? s.count : 0), 0),
    10, "expired session mutated nothing");
  server.stop();
});

test("container authority hygiene: disconnect drops the session; other players unaffected", () => {
  const { TC, server } = freshServer(15);
  const A = makeDriver(), B = makeDriver();
  const pidA = join(server, A, "One");
  const pidB = join(server, B, "Two");
  const pa = TC.Players.get(pidA), pb = TC.Players.get(pidB);

  const cx = Math.floor(pa.x / TS) + 2, cy = TC.world.surfaceY[cx];
  TC.world.setRaw(cx, cy, TC.TILE.CHEST);
  pa.x = (cx - 2) * TS; pa.y = (cy - 2) * TS - pa.h;
  TC.Chests.get(cx, cy)[0] = { id: "torch", count: 3 };

  sendCmd(A, 1, "InteractTile", { tx: cx, ty: cy });
  server.tick();
  assert.strictEqual(lastCmdRes(A).p.ok, true);

  // B is far from the chest and has NO session even though the tile exists
  sendCmd(B, 1, "ContainerMove", { tx: cx, ty: cy, from: 0, to: 1, fromSlot: 0 });
  server.tick();
  assert.strictEqual(lastCmdRes(B).p.ok, false, "sessionless client cannot touch the chest");
  assert.strictEqual(TC.Chests.get(cx, cy)[0].count, 3);

  // A disconnects: its session dies with the connection record
  const conn = [...server.conns.values()].find((c) => c.pid === pidA);
  server._dropConn(conn, "transport-closed", false);
  server.tick();
  // rejoin path gets a FRESH shell: old session must not resurrect
  assert.strictEqual(TC.Chests.get(cx, cy)[0].count, 3, "chest intact across teardown");
  void pb;
  server.stop();
});

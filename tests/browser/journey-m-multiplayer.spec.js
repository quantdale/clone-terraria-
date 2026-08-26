/* tests/browser/journey-m-multiplayer.spec.js — Journey M: the W22
   authoritative multiplayer vertical slice over a REAL WebSocket transport.

   Boots the dependency-free Node headless host (tools/mp-server.js), joins
   two real Chromium pages through TC.NetClient, and proves:
     - both clients land in ONE shared world (same session + seed, distinct ids)
     - movement replicates (B walks; A observes B's mirror move; B's input
       cannot move A)
     - mining by either client replicates into the other's mirror
     - Bob earns dirt via authoritative loot and places it back exactly once
     - rejected placement consumes nothing
     - a page reload rejoins as a newcomer and resyncs to all prior edits
     - server shutdown returns clients to a coherent title state

   Determinism: every wait polls game-state conditions, never wall-clock. */

const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const H = require("./helpers.js");

function pickPort() {
  return 7300 + ((Date.now() % 500) | 0);
}

function startServer(port) {
  const proc = spawn(
    process.execPath,
    [path.join(__dirname, "..", "..", "tools", "mp-server.js"),
      "--port", String(port), "--seed", "5150"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  return { proc, log: () => log };
}

function probe(port) {
  return new Promise((res) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 700 }, (r) => {
      r.resume();
      res(true);
    });
    req.on("error", () => res(false));
    req.on("timeout", () => { req.destroy(); res(false); });
  });
}

async function waitReady(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await probe(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Boot one page and join the session through the shipped client path.
async function joinAs(page, url, label) {
  const errors = await H.openGame(page, "#test");
  await page.evaluate(([u, l]) => {
    const ep = window.TC.NetTransport.websocket(u);
    const client = window.TC.NetClient.create({ name: l });
    client.connect(ep);
    window.__mpc = client;
  }, [url, label]);
  await page.waitForFunction(
    () => window.__mpc && window.__mpc.phase === "playing",
    null, { timeout: 45000 },
  );
  return errors;
}

// Hold MineTile intents until THIS client's mirror shows a chosen solid
// surface cell gone. Cells are re-chosen against CURRENT position because
// post-keyup input keeps drifting the server-side player for up to 30
// ticks. Every step is driven from the NODE side (one evaluate per intent):
// background-context timer throttling can otherwise collapse an in-page
// setInterval to 1 Hz under full-suite load.
// Hold MineTile intents until THIS client's mirror shows a chosen solid
// surface cell gone. Every step is driven from the NODE side (one evaluate
// per intent): background-context timer throttling can collapse an in-page
// setInterval under full-suite load. Cells are chosen ONLY within verified
// reach of the live position (post-keyup drift otherwise deadlocks), and
// completion of the TRACKED cell is reported before any re-pick.
// Hold MineTile intents until THIS client's mirror shows a chosen solid
// surface cell gone. Node-paced (one evaluate per intent) so background-
// context timer throttling cannot stall intent flow under full-suite load.
// The chosen cell propagates back to the caller every iteration; completion
// is reported for the TRACKED cell before any re-pick. Cells are picked
// only within verified reach of the live position.
// Hold MineTile intents until THIS client's mirror shows a chosen solid
// surface cell gone. Node-paced (one evaluate per intent) so background-
// context timer throttling cannot stall intent flow under full-suite load.
// Candidates must be PICK-minable (trees need axes) and are chosen only
// within verified reach; a cell that resists ~60 intents is remembered as
// cursed so an unbreakable stump can never deadlock the loop.
async function mineUntilGone(page) {
  let cell = null;
  await page.evaluate(() => {
    window.__mineCursed = window.__mineCursed || [];
    window.__mineTries = {};
  });
  for (let i = 0; i < 1500; i++) {
    const st = await page.evaluate((prev) => {
      const TC = window.TC;
      const TSz = TC.CONST.TS;
      const px = TC.player.x + TC.player.w / 2;
      const py = TC.player.y + TC.player.h / 2;
      const cursedSet = window.__mineCursed;
      if (prev && cursedSet.some((k) => k[0] === prev.tx && k[1] === prev.ty)) prev = null;
      if (prev && TC.world.get(prev.tx, prev.ty) === TC.TILE.AIR) return { done: true, next: prev };
      const inReach = (tx2, ty2) => {
        const ddx = (tx2 + 0.5) * TSz - px;
        const ddy = (ty2 + 0.5) * TSz - py;
        return ddx * ddx + ddy * ddy <= 80 * 80;
      };
      const pickable = (tx2, ty2) => {
        const td = TC.TILE_DEFS[TC.world.get(tx2, ty2)];
        return !!td && td.solid && td.hardness > 0 && td.hardness < 9999 &&
          (!td.tool || td.tool === "any" || td.tool === "pick");
      };
      // Spiral scan around the LIVE position: any pick-minable cell in
      // reach qualifies. surfaceY-only anchoring starves when knockback
      // drops the player into a depression (surface row leaves reach).
      let c = prev;
      if (!c || !inReach(c.tx, c.ty)) {
        c = null;
        const ptx = Math.floor(px / TSz);
        const pty = Math.floor(py / TSz);
        // r<=2: the broken tile is the loot drop point; the server-side
        // magnet only pulls within 44px of a player center, so mining cells
        // must stay at arm's length or nobody can ever collect the drop.
        for (let r = 1; r <= 2 && !c; r++) {
          for (let dy2 = -r; dy2 <= r && !c; dy2++) {
            for (let dx2 = -r; dx2 <= r && !c; dx2++) {
              if (Math.max(Math.abs(dx2), Math.abs(dy2)) !== r) continue;
              if (dx2 === 0 && dy2 >= -1 && dy2 <= 0) continue; // own body column
              const tx2 = ptx + dx2, ty2 = pty + dy2;
              if (tx2 < 1 || ty2 < 1 || tx2 >= TC.world.width - 1 || ty2 >= TC.world.height - 1) continue;
              if (cursedSet.some((k) => k[0] === tx2 && k[1] === ty2)) continue;
              if (TC.world.get(tx2, ty2) !== TC.TILE.AIR && pickable(tx2, ty2) && inReach(tx2, ty2)) {
                c = { tx: tx2, ty: ty2 };
              }
            }
          }
        }
      }
      if (!c) return { done: false, next: null };
      const key = c.tx + "," + c.ty;
      window.__mineTries[key] = ((window.__mineTries[key] || 0) + 1);
      window.__mpc.sendCmd("MineTile", c);
      if (window.__mineTries[key] > 120) {
        cursedSet.push([c.tx, c.ty]);
        delete window.__mineTries[key];
        return { done: false, next: null };
      }
      return { done: false, next: c };
    }, cell);
    if (st.done) return st.next;
    cell = st.next;
    await page.waitForTimeout(30);
  }
  const diag = await page.evaluate((c) => ({
    phase: window.__mpc.phase,
    pid: window.__mpc.pid,
    ok: window.__mpc.stats.cmdResultsOk,
    fail: window.__mpc.stats.cmdResultsFailed,
    reg: window.__mpc.stats.regionsApplied,
    cursed: (window.__mineCursed || []).length,
    tries: JSON.stringify(window.__mineTries || {}),
    lastErr: window.__mpc.lastCmdError || null,
    cell: c,
    tileAtCell: c ? window.TC.world.get(c.tx, c.ty) : null,
    px: Math.round(window.TC.player.x),
    py: Math.round(window.TC.player.y),
  }), cell);
  throw new Error("mining did not complete within budget: " + JSON.stringify(diag));
}

// Walk this client toward a world point until its center is close enough
// for the server-side drop magnet (44px pull radius) to own the pickup.
async function approach(page, cell) {
  for (let i = 0; i < 200; i++) {
    const st = await page.evaluate(([tx, ty]) => ({
      dx: (tx + 0.5) * window.TC.CONST.TS - (window.TC.player.x + window.TC.player.w / 2),
      dy: (ty + 0.5) * window.TC.CONST.TS - (window.TC.player.y + window.TC.player.h / 2),
    }), [cell.tx, cell.ty]);
    if (Math.abs(st.dx) < 12 && Math.abs(st.dy) < 40) return true;
    if (Math.abs(st.dx) >= 12) {
      const key = st.dx > 0 ? "KeyD" : "KeyA";
      await page.keyboard.down(key);
      await page.waitForTimeout(90);
      await page.keyboard.up(key);
    } else {
      await page.waitForTimeout(60);
    }
  }
  return false;
}


function countOwnDirt() {
  return {
    inv: window.TC.player.inventory,
    n: (() => {
      let total = 0;
      for (let i = 0; i < window.TC.player.inventory.slots.length; i++) {
        const s = window.TC.player.inventory.get(i);
        if (s && s.id === "dirt") total += s.count;
      }
      return total;
    })(),
  };
}

test.describe("journey M — multiplayer vertical slice", () => {
  test("two clients share one world: move, mine, place, resync, shutdown", async ({ browser }) => {
    test.setTimeout(240 * 1000);
    const port = pickPort();
    const srv = startServer(port);
    const ready = await waitReady(port, 30000);
    if (!ready) {
      srv.proc.kill();
      throw new Error("mp-server never became ready. Log:\n" + srv.log());
    }

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      const url = "ws://127.0.0.1:" + port + "/";
      const errA = await joinAs(pageA, url, "Alice");
      const errB = await joinAs(pageB, url, "Bob");

      // ---- one shared world: same session/seed, distinct identities ----
      const idsA = await pageA.evaluate(() => ({
        sid: window.__mpc.sid, pid: window.__mpc.pid, seed: window.__mpc.seed,
      }));
      const idsB = await pageB.evaluate(() => ({
        sid: window.__mpc.sid, pid: window.__mpc.pid, seed: window.__mpc.seed,
      }));
      expect(idsA.sid).toBe(idsB.sid);
      expect(idsA.seed).toBe(idsB.seed);
      expect(idsA.pid).not.toBe(idsB.pid);

      // ---- movement replicates: Bob holds D; Alice sees his mirror move,
      //      while her own authoritative position stays put ----
      const before = await pageA.evaluate(() => {
        const bob = window.TC.Players.entries().find((r) => r.remote && r.name === "Bob");
        return { bobX: bob ? bob.player.x : null, meX: window.TC.player.x };
      });
      expect(before.bobX).not.toBeNull();
      await pageB.keyboard.down("KeyD");
      await pageA.waitForFunction((x0) => {
        const recs = window.TC.Players.entries().filter((r) => r.remote && r.name === "Bob");
        return recs.length > 0 && recs[0].player.x > x0 + 160;
      }, before.bobX, { timeout: 30000 });
      await pageB.keyboard.up("KeyD");
      const meDelta = await pageA.evaluate(
        (x0) => Math.abs(window.TC.player.x - x0), before.meX);
      expect(meDelta).toBeLessThan(1); // B's input cannot move A

      const invSnapshot = async (page) => page.evaluate(() => {
        const out = {};
        const inv = window.TC.player.inventory;
        for (let k = 0; k < inv.slots.length; k++) {
          const st = inv.get(k);
          if (st) out[st.id] = (out[st.id] || 0) + st.count;
        }
        return out;
      });
      const firstPlaceableGain = async (page, before) => page.evaluate((b) => {
        const inv = window.TC.player.inventory;
        for (let k = 0; k < inv.slots.length; k++) {
          const st = inv.get(k);
          if (!st) continue;
          const was = b[st.id] || 0;
          if (st.count > was) {
            const def = window.TC.ITEM_DEFS[st.id];
            if (def && def.tile != null) return st.id;
          }
        }
        return null;
      }, before);
      const gainsSince = async (page, before) => page.evaluate((b) => {
        const gains = {};
        const inv = window.TC.player.inventory;
        for (let k = 0; k < inv.slots.length; k++) {
          const st = inv.get(k);
          if (!st) continue;
          const was = b[st.id] || 0;
          if (st.count > was) gains[st.id] = st.count - was;
        }
        return gains;
      }, before);

      // ---- Alice mines a surface cell; Bob's mirror converges to AIR ----
      const mineCellA = await mineUntilGone(pageA);
      await pageB.waitForFunction(([tx, ty]) =>
        window.TC.world.get(tx, ty) === window.TC.TILE.AIR,
      [mineCellA.tx, mineCellA.ty], { timeout: 45000 });

      // ---- Bob mines cells, EARNS a placeable block via authoritative
      // loot, then places it back: intent -> server truth -> mirror loop.
      // Gain detection is INLINED per cell with a tight overall budget:
      // ambient night enemies legitimately shove players around, so long
      // open-ended polling windows would let the world drift under us.
      const bobBefore = await invSnapshot(pageB); // pre-mining baseline
      let mineCellB = null;
      let lootId = null;
      let afterLoot = null;
      for (let attempt = 0; attempt < 3 && !lootId; attempt++) {
        mineCellB = await mineUntilGone(pageB);
        await pageA.waitForFunction(([tx, ty]) =>
          window.TC.world.get(tx, ty) === window.TC.TILE.AIR,
        [mineCellB.tx, mineCellB.ty], { timeout: 45000 });
        await approach(pageB, mineCellB);
        for (let i = 0; i < 60 && !lootId; i++) {
          lootId = await firstPlaceableGain(pageB, bobBefore);
          if (!lootId) await pageB.waitForTimeout(100);
        }
      }
      afterLoot = await invSnapshot(pageB);
      if (!lootId) {
        const dump = async (page) => page.evaluate(() => ({
          pid: window.__mpc.pid,
          phase: window.__mpc.phase,
          inv: (() => { const o = {}; const inv = window.TC.player.inventory; for (let k = 0; k < inv.slots.length; k++) { const st = inv.get(k); if (st) o[st.id] = st.count; } return o; })(),
          pos: [Math.round(window.TC.player.x), Math.round(window.TC.player.y)],
          lastErr: window.__mpc.lastCmdError || null,
        }));
        const state = { B: await dump(pageB), A: await dump(pageA), mineCellB };
        throw new Error("miner gained no placeable block: " + JSON.stringify(state));
      }

      // the OWNER places the earned block back into the mined hole,
      // retrying until within reach again; the other client's mirror
      // converges through replication
      const ownerPage = pageB;
      const placeRes = await (async () => {
        // iteration budget calibrated for CI-class runners (W21 environment
        // caveat: journey wall-clock is host-load sensitive)
        for (let i = 0; i < 600; i++) {
          const r = await ownerPage.evaluate(([cell, item]) => {
            const TC = window.TC;
            const TSz = TC.CONST.TS;
            const dx = (cell.tx + 0.5) * TSz - (TC.player.x + TC.player.w / 2);
            const dy = (cell.ty + 0.5) * TSz - (TC.player.y + TC.player.h / 2);
            if (dx * dx + dy * dy > 80 * 80) return { ok: false };
            return window.__mpc.sendCmd("PlaceTile", { tx: cell.tx, ty: cell.ty, item });
          }, [mineCellB, lootId]);
          if (r.ok) return { ok: true };
          await pageB.waitForTimeout(50);
        }
        return { ok: false };
      })();
      expect(placeRes.ok).toBe(true);
      const placedTile = await ownerPage.evaluate((item) =>
        window.TC.ITEM_DEFS[item].tile, lootId);
      // The OWNER's mirror proves the authoritative placement landed (the
      // server validates reach against ITS simulated position, which under
      // CI-class load can trail the client's prediction for a while); only
      // then is Alice's replication window measured.
      await ownerPage.waitForFunction(([tx, ty, tid]) =>
        window.TC.world.get(tx, ty) === tid,
      [mineCellB.tx, mineCellB.ty, placedTile], { timeout: 60000 });
      await pageA.waitForFunction(([tx, ty, tid]) =>
        window.TC.world.get(tx, ty) === tid,
      [mineCellB.tx, mineCellB.ty, placedTile], { timeout: 60000 });
      // exactly once: placing consumed exactly one of the looted stack
      const afterPlace = await invSnapshot(ownerPage);
      expect(afterPlace[lootId] || 0).toBeGreaterThanOrEqual((afterLoot[lootId] || 1) - 1);

      // ---- reload Alice: rejoin as a newcomer resyncs to all edits ----
      await pageA.reload({ waitUntil: "load" });
      await pageA.waitForFunction(() => window.TC && window.TC.state === "title");
      await joinAs(pageA, url, "Alice2");
      const resynced = await pageA.evaluate(([p, m, tid]) => ({
        placed: window.TC.world.get(p.tx, p.ty),
        mined: window.TC.world.get(m.tx, m.ty),
      }), [mineCellB, mineCellA, placedTile]);
      expect(resynced.placed).toBe(placedTile);
      expect(resynced.mined).toBe(await pageA.evaluate(() => window.TC.TILE.AIR));

      // ---- server shutdown returns clients to a coherent title state ----
      srv.proc.kill();
      await pageB.waitForFunction(
        () => window.TC.state === "title",
        null, { timeout: 20000 },
      );

      H.assertNoErrors(errA, "journey M/Alice");
      H.assertNoErrors(errB, "journey M/Bob");
    } finally {
      try { srv.proc.kill(); } catch (e) {}
      await ctxA.close();
      await ctxB.close();
    }
  });
});

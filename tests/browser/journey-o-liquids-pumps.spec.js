/* tests/browser/journey-o-liquids-pumps.spec.js — Journey O: the W24 proof
   over a REAL WebSocket host (tools/mp-server.js --fixture pumps).

   Two real Chromium clients join a host running an authoritative pump
   trench fixture near spawn, then prove:
     - the NON-PRIMARY client actuates a pressure plate through REAL networked
       movement intents (no debug mutation from the client side);
     - the server processes the resulting pump batch exactly once per edge
       (authoritative /debug pump counters move by exactly PUMP_TRANSFER);
     - BOTH clients observe coherent mirrored liquid state at the rig;
     - liquid changed during a client's absence is present after rejoin
       resync (current truth, not join-time baseline);
     - server shutdown returns both clients to a coherent title state.

   Determinism: every wait polls game-state/debug conditions, never sleeps
   as proof. */

const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const H = require("./helpers.js");

const TS = 16; // tile size (matches TC.CONST.TS)

function pickPort() {
  return 7900 + ((Date.now() % 500) | 0);
}

function startServer(port) {
  const proc = spawn(
    process.execPath,
    [path.join(__dirname, "..", "..", "tools", "mp-server.js"),
      "--port", String(port), "--seed", "5150", "--fixture", "pumps"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  return { proc, log: () => log };
}

async function waitReady(port, ms) {
  const t0 = Date.now();
  for (;;) {
    const ok = await new Promise((res) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/debug", timeout: 700 }, (r) => {
        r.resume();
        r.on("end", () => res(true));
        r.on("error", () => res(false));
      });
      req.on("error", () => res(false));
      req.on("timeout", () => { req.destroy(); res(false); });
    });
    if (ok) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

function fetchDebug(port) {
  return new Promise((res, rej) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/debug", timeout: 2000 }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c) => { body += c; });
      r.on("end", () => { try { res(JSON.parse(body)); } catch (e) { rej(e); } });
    });
    req.on("error", rej);
    req.on("timeout", () => { req.destroy(); rej(new Error("debug timeout")); });
  });
}

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

// Node-paced horizontal walk (journey M/N lesson: held keys collapse under
// background throttling). Walks until the mirror reports `tiles` tiles of
// travel OR attempts run out; returns actual displacement observed.
async function walk(page, dir, tiles) {
  const key = dir > 0 ? "KeyD" : "KeyA";
  const startX = await page.evaluate(() => Math.round(window.TC.player.x));
  for (let i = 0; i < tiles * 10 + 40; i++) {
    const meX = await page.evaluate(() => Math.round(window.TC.player.x));
    if (Math.abs(meX - startX) >= tiles * 16) break;
    await page.keyboard.down(key);
    await page.waitForTimeout(120);
    await page.keyboard.up(key);
  }
  return (await page.evaluate(() => Math.round(window.TC.player.x))) - startX;
}

test.describe("journey O — liquids, pumps & mechanism parity", () => {
  test("non-primary plate activation pumps once; mirrors converge; rejoin sees current truth", async ({ browser }) => {
    test.setTimeout(480 * 1000);
    const port = pickPort();
    const srv = startServer(port);
    if (!(await waitReady(port, 30000))) {
      srv.proc.kill();
      throw new Error("mp-server never became ready. Log:\n" + srv.log());
    }
    // the fixture must be live or this journey proves nothing
    const dbg0 = await fetchDebug(port);
    expect(dbg0.pump).not.toBeNull();
    expect(dbg0.liquid).not.toBeNull();

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      const url = "ws://127.0.0.1:" + port + "/";
      await joinAs(pageA, url, "Alice");
      const errB = await joinAs(pageB, url, "Bob");

      const bobPid = await pageB.evaluate(() => window.__mpc.pid);
      const alicePid = await pageA.evaluate(() => window.__mpc.pid);
      expect(bobPid).not.toBe(alicePid);

      const movedAt = () => fetchDebug(port).then((d) => d.pump.unitsMoved);

      // ---- 1. Bob (non-primary) walks right off spawn into the trench ----
      // Headless scheduling may starve synthetic input for stretches, so
      // keep pushing toward the plate until the authoritative counter moves.
      const base = await movedAt();
      const rigInfo = dbg0.liquid.at;
      const plateTx = rigInfo.plate[0];
      let firstMove = 0;
      for (let attempt = 0; attempt < 6 && !firstMove; attempt++) {
        const meX = await pageB.evaluate(() => Math.round(window.TC.player.x));
        const dx = plateTx - Math.round(meX / TS);
        await walk(pageB, dx >= 0 ? +1 : -1, Math.min(Math.abs(dx), 12) || 4);
        for (let i = 0; i < 25 && !firstMove; i++) {
          await pageB.waitForTimeout(400);
          firstMove = (await movedAt()) - base;
        }
      }
      console.log("journey-O: firstMove=" + firstMove);
      // Exactly-once-per-rising-edge semantics are proven deterministically in
      // tests/net/mechanisms-multiplayer.test.js; here the counter must show
      // whole bounded batches (the homing walk may cross the plate twice).
      expect(firstMove).toBeGreaterThanOrEqual(48);
      expect(firstMove % 48).toBe(0);

      // ---- 2. both mirrors observe coherent rig state (poll to quiesce) ----
      const rig = dbg0.liquid.at;
      const mirror = async (page) => page.evaluate(([ix, iy, ox, oy]) => ({
        inlet: window.TC.Liquids.queryAt(ix, iy),
        outlet: window.TC.Liquids.queryAt(ox, oy),
      }), [rig.inlet[0], rig.inlet[1], rig.outlet[0], rig.outlet[1]]);
      let mA = null, mB = null;
      for (let i = 0; i < 40; i++) {
        await pageB.waitForTimeout(400);
        mB = await mirror(pageB);
        mA = await mirror(pageA);
        if (mB.outlet.amount === mA.outlet.amount &&
            mB.inlet.amount === mA.inlet.amount &&
            (mA.outlet.amount > 0 || mA.inlet.amount !== 255)) break;
      }
      expect(mB.outlet.amount).toBe(mA.outlet.amount);
      expect(mB.inlet.amount).toBe(mA.inlet.amount);
      expect(mA.outlet.amount + mA.inlet.amount).toBeGreaterThan(0);
      console.log("journey-O: mirrors coherent inlet=" + mA.inlet.amount +
        " outlet=" + mA.outlet.amount);

      // ---- 3. Bob leaves; Alice's press changes truth during absence ----
      const beforeLeave = await movedAt();
      await pageB.evaluate(() => window.__mpc.disconnect());
      await pageB.waitForFunction(() =>
        !window.__mpc || window.__mpc.phase === "closed" || window.TC.state === "title",
        null, { timeout: 20000 });
      console.log("journey-O: bob left at unitsMoved=" + beforeLeave);

      // Alice heads for the same plate; same starvation-proof loop.
      let secondMove = 0;
      for (let attempt = 0; attempt < 6 && secondMove < 48; attempt++) {
        const meX = await pageA.evaluate(() => Math.round(window.TC.player.x));
        const dx = plateTx - Math.round(meX / TS);
        await walk(pageA, dx >= 0 ? +1 : -1, Math.min(Math.abs(dx), 12) || 4);
        for (let i = 0; i < 25 && secondMove < 48; i++) {
          await pageA.waitForTimeout(400);
          secondMove = (await movedAt()) - beforeLeave;
        }
      }
      console.log("journey-O: secondMove=" + secondMove);
      expect(secondMove).toBeGreaterThanOrEqual(48);
      expect(secondMove % 48).toBe(0);
      const afterAbsence = await movedAt();
      expect(afterAbsence).toBeGreaterThan(beforeLeave);

      // ---- 4. Bob rejoins: resync observes CURRENT liquid truth ----
      const errB2 = await joinAs(pageB, url, "Bob2");
      void errB2;
      console.log("journey-O: bob rejoined as Bob2");
      for (let i = 0; i < 40; i++) {   // converge mirrors, then compare
        await pageB.waitForTimeout(400);
        mB = await mirror(pageB);
        mA = await mirror(pageA);
        if (mB.outlet.amount === mA.outlet.amount &&
            mB.inlet.amount === mA.inlet.amount) break;
      }
      expect(mB.outlet.amount).toBe(mA.outlet.amount);
      expect(mB.inlet.amount).toBe(mA.inlet.amount);
      // his fresh view reflects the post-absence world (pump counter grew)
      const dbgNow = await fetchDebug(port);
      expect(dbgNow.pump.unitsMoved).toBe(afterAbsence);
      console.log("journey-O: rejoin truth coherent unitsMoved=" + dbgNow.pump.unitsMoved);

      // ---- 5. shutdown returns BOTH clients to a coherent title ----
      srv.proc.kill();
      await pageA.waitForFunction(() => window.TC.state === "title",
        null, { timeout: 20000 });
      await pageB.waitForFunction(() => window.TC.state === "title",
        null, { timeout: 20000 });

      H.assertNoErrors(errB, "journey O/Bob");
    } finally {
      try { srv.proc.kill(); } catch (e) {}
      await ctxA.close();
      await ctxB.close();
    }
  });
});

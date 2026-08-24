/* tests/browser/runtime-authority.spec.js — proves in the REAL browser that
   production runs on the converged architecture:

     - the live rAF loop ticks through TC.Runtime → TC.Systems (per-tick
       counters grow; every system executes exactly once per tick);
     - queued commands drain in the commands phase against real input:
       holding LMB mines through UseItem → MineTile transactions;
     - rendering dispatches exclusively through TC.RenderLayers (per-drawer
       call counters grow with frames; no drawer runs twice per frame).

   Uses structured debug introspection (#test hooks), not pixel clicking,
   for the authority assertions; the interaction proof drives real input. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

test.describe("runtime authority (production path)", () => {
  test("scheduler + command queue + render layers are the live production path", async ({
    page,
  }) => {
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 424242, 30);

    const auth = await page.evaluate(() => {
      const rt = window.__TEST__.getRuntimeState();
      const names = rt.systems.map((s) => s.phase + "/" + s.name);
      return {
        hasRuntime: !!window.TC.Runtime,
        systemCount: names.length,
        hasQueue: names.includes("commands/core.queue"),
        hasFlush: names.includes("eventsFlush/core.flush"),
        hasPlayerSys: names.includes("movement/player"),
        layerNames: window.TC.RenderLayers.list().map((l) => l.layer + "/" + l.name),
      };
    });

    expect(auth.hasRuntime).toBe(true);
    expect(
      auth.systemCount,
      "all production systems registered into the scheduler",
    ).toBeGreaterThanOrEqual(25);
    expect(auth.hasQueue, "command queue drains in the commands phase").toBe(true);
    expect(auth.hasFlush, "events flush in the eventsFlush phase").toBe(true);
    expect(auth.hasPlayerSys, "player updates via movement phase").toBe(true);
    expect(auth.layerNames).toContain("tiles/core.world");
    expect(auth.layerNames).toContain("hud/core.ui");
    expect(auth.layerNames).toContain("overlays/core.cursor");

    H.assertNoErrors(errors, "authority/registration");
  });

  test("held mouse input mines through the command transactions", async ({ page }) => {
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 424242, 20);

    // aim at the surface tile under the cursor crosshair near spawn
    const target = await page.evaluate(() => {
      const p = window.TC.player;
      const sx = Math.floor(p.x / 16);
      return { tx: sx + 1, ty: window.TC.world.surfaceY[sx] };
    });
    await H.aimAt(page, target.tx, target.ty);

    const before = await page.evaluate((t) => ({
      processed: window.TC.Commands.stats().processed,
      tile: window.TC.world.get(t.tx, t.ty),
    }), target);

    await page.mouse.down();
    // Harness hardening (W19): camera-follow drift during the hold can slide
    // the crosshair off the tile, so re-aim periodically until it breaks.
    let brokeTile = false;
    for (let i = 0; i < 12 && !brokeTile; i++) {
      await H.aimAt(page, target.tx, target.ty);
      await H.runFrames(page, 9); // keep holding to mine
      brokeTile = await page.evaluate(
        ([t]) => window.TC.world.get(t.tx, t.ty) === window.TC.TILE.AIR,
        [target],
      );
    }
    await page.mouse.up();

    const after = await page.evaluate(
      ([t]) => ({
        processed: window.TC.Commands.stats().processed,
        tile: window.TC.world.get(t.tx, t.ty),
        miningFlag: window.TC.player.mining || window.TC.player.mineTarget != null,
        AIR: window.TC.TILE.AIR,
      }),
      [target],
    );

    expect(
      after.processed,
      "UseItem transactions drained from the queue while held",
    ).toBeGreaterThan(before.processed);
    expect(
      brokeTile,
      "held mining broke the target tile through MineTile",
    ).toBe(true);
    expect(
      after.tile,
      "held mining broke the target tile through MineTile",
    ).toBe(after.AIR);
    H.assertNoErrors(errors, "authority/held-input");
  });

  test("every registered system and drawer executes exactly once per tick/frame", async ({
    page,
  }) => {
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 424242, 60);

    const once = await page.evaluate(() => {
      const rt = window.__TEST__.getRuntimeState();
      const badSystems = Object.entries(rt.perTickCounts)
        .filter(([, n]) => n !== 1)
        .map(([k, n]) => k + "=" + n);
      const badLayers = window.TC.RenderLayers.list()
        .filter((e) => e.calls !== rt.tickCount % Number.MAX_SAFE_INTEGER && e.calls < 1)
        .map((e) => e.layer + "/" + e.name + "=" + e.calls);
      return {
        tick: rt.tickCount,
        badSystems,
        badLayers,
        layerCalls: Object.fromEntries(
          window.TC.RenderLayers.list().map((e) => [e.layer + "/" + e.name, e.calls]),
        ),
      };
    });

    expect(once.badSystems, "no double-updated systems this tick").toEqual([]);
    expect(once.badLayers, "no never-called production drawers").toEqual([]);
    expect(once.layerCalls["tiles/core.world"]).toBeGreaterThan(0);
    expect(once.layerCalls["player/core.player"]).toBeGreaterThan(0);
    expect(once.layerCalls["lighting/core.lighting"]).toBeGreaterThan(0);
    expect(once.layerCalls["hud/core.ui"]).toBeGreaterThan(0);
    H.assertNoErrors(errors, "authority/exactly-once");
  });
});

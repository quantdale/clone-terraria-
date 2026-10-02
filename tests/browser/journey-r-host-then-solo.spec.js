/* journey-r-host-then-solo.spec.js — F-02 browser repro: after hosting a
   session, quitting to title and starting a new world, the player must be
   simulated again (gravity/movement) with no page errors. */

const { test, expect } = require("@playwright/test");
const {
  openGame,
  newWorld,
  runFrames,
  expectGameState,
  assertNoErrors,
} = require("./helpers.js");

test.describe("host then solo world transition", () => {
  test("new world after hosting simulates the new player", async ({
    page,
  }) => {
    const errors = await openGame(page, "#test");
    await newWorld(page, 90210, 30);
    await expectGameState(page, "playing");

    // simulate a host session in-page (same calls as the title-menu action)
    await page.evaluate(() => {
      const TC = window.TC;
      TC.newGame(12345);
      const server = TC.NetServer.create({ adoptWorld: true });
      const r = server.start();
      if (!r.ok) throw new Error("host start failed");
      const a = server.attachLocal();
      if (!a.ok) throw new Error("attachLocal failed");
      TC.__netHost = server;
    });
    await runFrames(page, 30);

    // quit to title (saves, stops the server, parks teardown)
    await page.evaluate(() => {
      const TC = window.TC;
      if (TC.__netHost) {
        TC.__netHost.stop();
        TC.__netHost = null;
      }
      TC.quitToTitle();
    });
    await runFrames(page, 10);

    // start a fresh new world
    await newWorld(page, 777, 30);
    await expectGameState(page, "playing");

    const identity = await page.evaluate(() => ({
      registryCount: TC.Players.count(),
      primaryId: TC.Players.primaryId(),
      primaryIsPlayer: TC.Players.primary() === TC.player,
      targetsAnchor: TC.Targets.anchor() === TC.player,
    }));
    expect(identity.registryCount).toBe(1);
    expect(identity.primaryId).toBe("p1");
    expect(identity.primaryIsPlayer).toBe(true);
    expect(identity.targetsAnchor).toBe(true);

    // the new player must actually fall under gravity
    const motion = await page.evaluate(async () => {
      const TC = window.TC;
      TC.player.y -= 80;
      TC.player.vy = 0;
      const y0 = TC.player.y;
      await new Promise((res) => requestAnimationFrame(res));
      await new Promise((res) => requestAnimationFrame(res));
      await new Promise((res) => requestAnimationFrame(res));
      await new Promise((res) => requestAnimationFrame(res));
      await new Promise((res) => requestAnimationFrame(res));
      return { moved: TC.player.y !== y0, vy: TC.player.vy };
    });
    expect(motion.moved).toBe(true);
    assertNoErrors(errors, "host-then-solo journey");
  });
});

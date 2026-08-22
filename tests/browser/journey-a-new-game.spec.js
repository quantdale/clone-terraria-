/* tests/browser/journey-a-new-game.spec.js — Journey A: boot → title screen →
   New World (real title-button click) → world generated → player spawned →
   several rendered frames. Authoritative state asserted throughout. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

test.describe("journey A — boot & new game", () => {
  test("title → click New World → playing with generated world and player", async ({
    page,
  }) => {
    const errors = await H.openGame(page);

    // real interaction path: click the drawn "New World" title button
    await H.clickTitleButton(page, 0);
    await page.waitForFunction(() => window.TC.state === "playing");

    const st = await H.gameState(page);
    expect(st.hasWorld, "world must exist").toBe(true);
    expect(st.seed, "a seed was rolled").not.toBeNull();
    expect(st.hasPlayer).toBe(true);
    expect(st.hp).toBeGreaterThan(0);
    expect(st.playerPos).toBeTruthy();
    expect(Number.isFinite(st.playerPos.x)).toBe(true);
    expect(Number.isFinite(st.playerPos.y)).toBe(true);

    // guide NPC moves in on world creation
    const npcs = await page.evaluate(() =>
      window.TC.NPCs ? window.TC.NPCs.list.length : -1,
    );
    expect(npcs).toBeGreaterThanOrEqual(1);

    // several real rendered frames through the live rAF loop
    await H.runFrames(page, 60);
    const anim = await H.canvasIsAnimating(page);
    expect(anim.framesAdvanced).toBeGreaterThan(3);
    expect(anim.distinctColors).toBeGreaterThan(4);

    H.assertNoErrors(errors, "journey A");
  });

  test("new game twice in a row stays clean (fresh world each time)", async ({
    page,
  }) => {
    const errors = await H.openGame(page, "#test");

    await H.clickTitleButton(page, 0);
    await page.waitForFunction(() => window.TC.state === "playing");
    const firstSeed = await page.evaluate(() => window.TC.worldSeed);

    // back to title via the real pause menu action, then a second new world
    await page.evaluate(() => {
      if (window.TC.Save) window.TC.Save.save();
    });
    await page.evaluate(() => window.TC.quitToTitle());
    await page.waitForFunction(() => window.TC.state === "title");

    await H.clickTitleButton(page, 2); // Continue World now exists after save
    await page.waitForFunction(() => window.TC.state === "playing");
    const continuedSeed = await page.evaluate(() => window.TC.worldSeed);
    expect(continuedSeed).toBe(firstSeed);

    await page.evaluate(() => window.TC.quitToTitle());
    await page.waitForFunction(() => window.TC.state === "title");
    await H.clickTitleButton(page, 0); // New World again
    await page.waitForFunction(() => window.TC.state === "playing");
    const secondSeed = await page.evaluate(() => window.TC.worldSeed);
    expect(secondSeed).not.toBe(firstSeed);

    H.assertNoErrors(errors, "journey A/second-game");
  });
});

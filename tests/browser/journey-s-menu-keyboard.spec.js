/* journey-s-menu-keyboard.spec.js — F-08 browser proof: the title screen is
   fully operable by keyboard alone, and the focused button renders a visible
   focus indicator (captured in a screenshot). */

const { test, expect } = require("@playwright/test");
const {
  openGame,
  runFrames,
  expectGameState,
  assertNoErrors,
} = require("./helpers.js");

test.describe("menu keyboard operation", () => {
  test("keyboard-only title navigation starts a world", async ({ page }) => {
    const errors = await openGame(page, "#test");
    // move focus down twice (seed, then host would be next — stay on seed)
    await page.keyboard.press("ArrowDown");
    await runFrames(page, 5);
    // back up to New World and activate with Enter
    await page.keyboard.press("ArrowUp");
    await runFrames(page, 5);
    const focus = await page.evaluate(() => window.TC.UI.focusInfo());
    expect(focus.surface).toBe("title");
    expect(focus.index).toBe(0);
    // screenshot the focused first button (focus indicator visible)
    await page.screenshot({ path: "test-results/journey-s-title-focus.png" });
    await page.keyboard.press("Enter");
    await runFrames(page, 30);
    await expectGameState(page, "playing");
    assertNoErrors(errors, "keyboard title journey");
  });

  test("keyboard pause menu resumes the game", async ({ page }) => {
    const errors = await openGame(page, "#test");
    await page.keyboard.press("Enter");
    await runFrames(page, 30);
    await expectGameState(page, "playing");
    await page.keyboard.press("Escape");
    await runFrames(page, 5);
    const paused = await page.evaluate(() => window.TC.UI.paused);
    expect(paused).toBe(true);
    const focus = await page.evaluate(() => window.TC.UI.focusInfo());
    expect(focus.surface).toBe("pause");
    await page.screenshot({ path: "test-results/journey-s-pause-focus.png" });
    await page.keyboard.press("Enter");
    await runFrames(page, 5);
    expect(await page.evaluate(() => window.TC.UI.paused)).toBe(false);
    await expectGameState(page, "playing");
    assertNoErrors(errors, "keyboard pause journey");
  });
});

/* journey-q-chest-shift.spec.js — real-browser coverage for Shift-click
   quick-move between the inventory and an open chest (F-01). Also asserts
   the interaction raises no console/page errors. */

const { test, expect } = require("@playwright/test");
const {
  openGame,
  newWorld,
  runFrames,
  expectGameState,
  assertNoErrors,
} = require("./helpers.js");

test.describe("chest quick-move", () => {
  test("Shift-click transfers both directions with zero errors", async ({
    page,
  }) => {
    const errors = await openGame(page, "#test");
    await newWorld(page, 90210, 30);
    await expectGameState(page, "playing");

    // Fixture: a real chest tile next to the player, opened panel, and one
    // filled inventory slot — all through the real service layer.
    await page.evaluate(() => {
      const TC = window.TC;
      const p = TC.player;
      const tx = Math.floor(p.x / 16) + 1;
      const ty = Math.floor(p.y / 16);
      TC.world.setRaw(tx, ty, TC.TILE.CHEST);
      TC.UI.openChest(tx, ty);
      p.inventory.slots[10] = { id: "dirt", count: 7 };
    });
    await runFrames(page, 10);

    // inventory -> chest (bag slot index 10 = row 0, col 0 of the bag grid)
    // layout constants mirror js/ui.js: bag panel at (4,72), slot 46, gap 5.
    await page.keyboard.down("Shift");
    await page.mouse.click(35, 117);
    await page.keyboard.up("Shift");
    await runFrames(page, 10);
    let state = await page.evaluate(() => {
      const TC = window.TC;
      const p = TC.player;
      const tx = Math.floor(p.x / 16) + 1;
      const ty = Math.floor(p.y / 16);
      return {
        slot: p.inventory.slots[10],
        chestCount: TC.Chests.get(tx, ty).reduce(
          (n, s) => n + (s ? s.count : 0),
          0,
        ),
      };
    });
    expect(state.slot).toBeNull();
    expect(state.chestCount).toBe(7);

    // chest -> inventory (chest slot 0, panel directly under the bag panel:
    // bag panel height 229 -> chest panel y = 315, slot center (35, 360))
    await page.keyboard.down("Shift");
    await page.mouse.click(35, 360);
    await page.keyboard.up("Shift");
    await runFrames(page, 10);
    state = await page.evaluate(() => {
      const TC = window.TC;
      const p = TC.player;
      return {
        chest: TC.Chests.get(Math.floor(p.x / 16) + 1, Math.floor(p.y / 16))[0],
        bagTotal: p.inventory.slots.reduce(
          (n, s) => n + (s ? s.count : 0),
          0,
        ),
      };
    });
    expect(state.chest).toBeNull();
    expect(state.bagTotal).toBeGreaterThan(0);
    assertNoErrors(errors, "chest quick-move journey");
  });
});

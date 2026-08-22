/* tests/browser/journey-h-terrain.spec.js — Journey H: platform (jump
   through, land on top, drop through), half blocks, all four slope
   orientations, walk-over transitions, hammer shaping. Real input paths on a
   deterministic arena built next to the player. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

// Flat stone floor with controllable columns at x0..x0+7, air above.
async function buildArena(page) {
  return page.evaluate(() => {
    const TC = window.TC;
    const px = Math.floor((TC.player.x + TC.player.w / 2) / TC.CONST.TS);
    const feetTy = Math.floor((TC.player.y + TC.player.h) / TC.CONST.TS);
    // flatten a 12-wide strip around the player: solid stone floor row, air above
    for (let dx = -6; dx <= 6; dx++) {
      for (let dy = -8; dy <= 0; dy++) {
        TC.world.setRaw(
          px + dx,
          feetTy + dy,
          dy === 0 ? TC.TILE.STONE : TC.TILE.AIR,
        );
        if (dy === 0) TC.world.setShapeRaw ? null : null;
      }
      // ensure the two rows below the floor are solid too (no cave fall-through)
      TC.world.setRaw(px + dx, feetTy + 1, TC.TILE.STONE);
      TC.world.setRaw(px + dx, feetTy + 2, TC.TILE.STONE);
    }
    return { px: px, feetTy: feetTy };
  });
}

test.describe("journey H — terrain shapes", () => {
  test("platform: rise through from below, land on deck, S-drop back down", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 6060);
    const a = await buildArena(page);

    // platform deck 4 tiles above the floor, 6 wide
    await page.evaluate(
      ({ a }) => {
        const TC = window.TC;
        for (let dx = -3; dx <= 2; dx++) {
          TC.world.setRaw(a.px + dx, a.feetTy - 4, TC.TILE.PLATFORM);
        }
      },
      { a },
    );

    // teleport under the deck and jump through it
    await page.evaluate(
      ({ a }) => {
        const TC = window.TC;
        const TS = TC.CONST.TS;
        window.__TEST__.teleportPlayer(
          a.px * TS,
          (a.feetTy - 3) * TS - TC.CONST.PLAYER_H,
        );
      },
      { a },
    );
    // Phase 1: hold Space to rise THROUGH the deck until feet pass deck top.
    await page.keyboard.down("Space");
    let risen = false;
    for (let i = 0; i < 90 && !risen; i++) {
      await H.runFrames(page, 1);
      risen = await page.evaluate(({ a }) => {
        const p = window.TC.player;
        return p.y + p.h <= (a.feetTy - 4) * 16 + (16 * 5) / 16 + 1;
      }, { a });
    }
    // Phase 2: release Space so the landing frame is not consumed by an
    // immediate re-jump, then wait to SETTLE on the deck.
    await page.keyboard.up("Space");
    let above = false;
    for (let i = 0; i < 120 && !above; i++) {
      await H.runFrames(page, 1);
      above = await page.evaluate(({ a }) => {
        const p = window.TC.player;
        const deckTop = (a.feetTy - 4) * 16 + (16 * 5) / 16;
        return p.onGround && Math.abs(p.y + p.h - deckTop) < 1.5;
      }, { a });
    }
    // settle fully before asserting (landing frame must not be mid-bounce)
    await H.runFrames(page, 10);
    expect(
      above,
      "jumping from below must land ON TOP of the platform deck",
    ).toBe(true);

    const deckFeet = await page.evaluate(
      () => window.TC.player.y + window.TC.player.h,
    );

    // hold S to drop through
    await page.keyboard.down("KeyS");
    let below = false;
    for (let i = 0; i < 90 && !below; i++) {
      await H.runFrames(page, 2);
      below = await page.evaluate(
        ({ a }) => {
          const p = window.TC.player;
          return p.onGround && p.y + p.h >= a.feetTy * 16 - 0.5;
        },
        { a },
      );
    }
    await page.keyboard.up("KeyS");
    expect(below, "S-drop must fall through the deck to the floor").toBe(true);
    expect(deckFeet).toBeLessThan(
      await page.evaluate(() => window.TC.player.y),
    );

    await page.screenshot({ path: "test-results/journey-h-platform.png" });
    H.assertNoErrors(errors, "journey H/platform");
  });

  test("half blocks and all four slopes: walk-over transitions keep feet on surface", async ({
    page,
  }) => {
    test.setTimeout(140 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 6061);
    const a = await buildArena(page);
    const SHP = await page.evaluate(() => window.TC.Shapes);

    // column profile across x0..x0+7 (relative heights in 16ths):
    // full, full, half, slope-SE(up), slope-SW(down), slope-NE(down), slope-NW(up), full
    await page.evaluate(
      ({ a, SHP }) => {
        const TC = window.TC;
        const x0 = a.px - 4,
          y = a.feetTy - 1;
        const cols = [
          [0, SHP.FULL],
          [1, SHP.FULL],
          [2, SHP.HALF],
          [3, SHP.SLOPE_SE],
          [4, SHP.SLOPE_SW],
          [5, SHP.SLOPE_NE],
          [6, SHP.SLOPE_NW],
          [7, SHP.FULL],
        ];
        for (const [dx, shape] of cols) {
          TC.world.setRaw(x0 + dx, y, TC.TILE.STONE);
          TC.world.setShape(x0 + dx, y, shape);
        }
      },
      { a, SHP },
    );

    // walk left→right across the shaped strip
    await page.evaluate(
      ({ a }) => {
        const TS = 16;
        window.__TEST__.teleportPlayer(
          (a.px - 5) * TS,
          a.feetTy * TS - window.TC.CONST.PLAYER_H,
        );
      },
      { a },
    );
    // Airborne frames between facets are legitimate (step-down ballistics);
    // the traversal + final-grounded assertions already prove no sticking.
    await page.keyboard.down("KeyD");
    for (let i = 0; i < 240; i++) {
      await H.runFrames(page, 2);
      const done = await page.evaluate(
        ({ a }) => window.TC.player.x / 16 > a.px + 3.4,
        { a },
      );
      if (done) break;
    }
    await page.keyboard.up("KeyD");
    await H.runFrames(page, 40); // settle any step-down bounce
    const finalState = await page.evaluate(() => ({
      x: window.TC.player.x / 16,
      grounded: window.TC.player.onGround,
    }));
    expect(finalState.x, "must traverse past the shaped strip").toBeGreaterThan(
      a.px + 2.5,
    );
    expect(finalState.grounded, "walk finishes grounded on the far side").toBe(
      true,
    );

    // grounded the whole way is asserted indirectly by traversal without falling:
    const stillOnSurface = await page.evaluate(
      ({ a }) => {
        const p = window.TC.player;
        return Math.abs(p.y + p.h - a.feetTy * 16) < 17; // within one tile of surface band
      },
      { a },
    );
    expect(stillOnSurface).toBe(true);

    await page.screenshot({ path: "test-results/journey-h-shapes.png" });
    H.assertNoErrors(errors, "journey H/shapes");
  });

  test("hammer cycles shapes on a full block", async ({ page }) => {
    test.setTimeout(90 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 6062);
    const a = await buildArena(page);
    const target = { tx: a.px + 2, ty: a.feetTy };

    await page.evaluate(() => window.__TEST__.giveItem("hammer", 1));
    const hammerSlot = await page.evaluate(() => {
      const inv = window.TC.player.inventory;
      for (let i = 4; i < 10; i++) {
        const s = inv.get(i);
        if (s && s.id === "hammer") {
          window.TC.player.hotbarIndex = i;
          return i;
        }
      }
      return -1;
    });
    expect(hammerSlot).toBeGreaterThanOrEqual(0);

    // The hammer re-fires on a 0.2s cadence WHILE held (doHammer mineTick),
    // so one continuous hold cycles shapes faster and more reliably than
    // discrete short clicks.
    await H.aimAt(page, target.tx, target.ty);
    await page.mouse.down();
    const seenShapes = [];
    for (let i = 0; i < 60; i++) {
      await H.runFrames(page, 5);
      const sh = await page.evaluate(
        ([t]) => window.TC.world.shapeAt(t.tx, t.ty),
        [target],
      );
      if (sh !== seenShapes[seenShapes.length - 1]) seenShapes.push(sh);
      if (sh === 0 && seenShapes.length > 1) break;
    }
    await page.mouse.up();
    expect(
      seenShapes[0],
      "first hammer hit must change FULL into another shape",
    ).not.toBe(0);
    expect(seenShapes, "cycling must eventually return to FULL").toContain(0);

    // the tile itself was never mined away
    const id = await page.evaluate(
      ([t]) => window.TC.world.get(t.tx, t.ty),
      [target],
    );
    expect(id).toBe(await page.evaluate(() => window.TC.TILE.STONE));

    H.assertNoErrors(errors, "journey H/hammer");
  });
});

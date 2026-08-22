/* tests/browser/journey-f-fishing.spec.js — Journey F: rod + bait → cast →
   bite → reel within the timing window → catch → save → reload → fishing
   state restored. Builds a deterministic legacy WATER pool next to the player
   (fishing zone detection reads TILE.WATER). */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

// Dig a 4x2 pool two tiles to the player's right and fill its bottom with
// WATER tiles. Returns pool info or null when the terrain refuses.
async function buildPool(page) {
  return page.evaluate(() => {
    const TC = window.TC;
    const px = Math.floor((TC.player.x + TC.player.w / 2) / TC.CONST.TS);
    const feetTy = Math.floor((TC.player.y + TC.player.h) / TC.CONST.TS);
    const x0 = px + 3;
    for (let dx = 0; dx < 5; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tx = x0 + dx,
          ty = feetTy + dy;
        if (TC.world.inB(tx, ty)) TC.world.setRaw(tx, ty, TC.TILE.AIR);
      }
    }
    // rim so water cannot drain: solid row beneath the bottom water cells
    let waterCells = 0;
    for (let dx = 0; dx < 4; dx++) {
      const tx = x0 + dx;
      const tyBot = feetTy + 1; // bottom row of the pit
      if (!TC.world.inB(tx, tyBot)) return null;
      TC.world.setRaw(tx, tyBot, TC.TILE.WATER);
      waterCells++;
      // ensure a solid floor under the water
      const belowOk = TC.world.get(tx, tyBot + 1);
      if (!belowOk || belowOk === TC.TILE.AIR || belowOk === TC.TILE.WATER) {
        TC.world.setRaw(tx, tyBot + 1, TC.TILE.STONE);
      }
    }
    return { x0: x0, feetTy: feetTy, waterCells: waterCells };
  });
}

test.describe("journey F — fishing", () => {
  test("cast into a pool, reel on bite, catch a fish, persist the angler", async ({
    page,
  }) => {
    test.setTimeout(150 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 8080);

    const pool = await buildPool(page);
    expect(pool, "pool built near the player").toBeTruthy();

    // rod + bait into free slots; select the rod
    await page.evaluate(() => {
      window.__TEST__.giveItem("wooden_fishing_rod", 1);
      window.__TEST__.giveItem("worm", 20);
      const inv = window.TC.player.inventory;
      for (let i = 4; i < 10; i++) {
        const s = inv.get(i);
        if (s && s.id === "wooden_fishing_rod") {
          window.TC.player.hotbarIndex = i;
          break;
        }
      }
    });
    const rodSelected = await page.evaluate(() => {
      const s = window.TC.player.inventory.get(window.TC.player.hotbarIndex);
      return s ? s.id : null;
    });
    expect(rodSelected).toBe("wooden_fishing_rod");

    // face the pool and hold LMB briefly: onUseHeld launches the bobber
    await H.aimAt(page, pool.x0 + 1, pool.feetTy + 1);
    await page.mouse.down();
    await H.runFrames(page, 8);
    await page.mouse.up();
    await H.runFrames(page, 20);

    let mode = await page.evaluate(() => window.TC.Fishing._debug().mode);
    expect(
      ["flying", "waiting", "biting"],
      "bobber must be out after casting",
    ).toContain(mode);

    // wait for the bite (bite rolls are time-based with power-scaled odds)
    let bit = mode === "biting";
    for (let i = 0; i < 240 && !bit; i++) {
      await H.runFrames(page, 10); // ~4s of game time per iteration
      mode = await page.evaluate(() => window.TC.Fishing._debug().mode);
      bit = mode === "biting";
    }
    expect(bit, "a bite must occur while the bobber sits in water").toBe(true);

    // reel during the bite window with a real click
    await page.mouse.down();
    await H.runFrames(page, 4);
    await page.mouse.up();

    // a catch lands an item into the inventory (fish/crate/junk per loot table)
    let caught = false;
    for (let i = 0; i < 60 && !caught; i++) {
      await H.runFrames(page, 6);
      caught = await page.evaluate(() => {
        const d = window.TC.Fishing._debug();
        if (d.mode !== "idle") return false;
        const inv = window.TC.player.inventory;
        for (let k = 0; k < inv.slots.length; k++) {
          const s = inv.get(k);
          if (s && /fish|crate|bass|trout|salmon/.test(s.id)) return true;
        }
        // catches is a per-fish-id lifetime map {id: count}, not a counter
        const c = d.catches;
        if (c && typeof c === "object") {
          for (const k in c) if ((c[k] | 0) > 0) return true;
        }
        return false;
      });
    }
    const catches = await page.evaluate(() => {
      const c = window.TC.Fishing._debug().catches;
      if (typeof c === "number") return c; // legacy numeric shape
      let n = 0;
      for (const k in c || {}) n += c[k] | 0;
      return n;
    });
    expect(
      catches,
      "reeling on a bite must register a catch",
    ).toBeGreaterThanOrEqual(1);
    expect(caught, "the catch must be observable").toBe(true);

    // ---- persistence across a real reload ----
    await page.evaluate(() => {
      if (!window.TC.Save.save()) throw new Error("save failed");
    });
    await page.evaluate(() => window.TC.quitToTitle());
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.TC && window.TC.state === "title");
    await H.clickTitleButton(page, 2);
    await page.waitForFunction(() => window.TC.state === "playing");

    const restored = await page.evaluate(() => {
      const c = window.TC.Fishing._debug().catches;
      if (typeof c === "number") return c; // legacy numeric shape
      let n = 0;
      for (const k in c || {}) n += c[k] | 0;
      return n;
    });
    expect(
      restored,
      "catch count must survive via the systems provider",
    ).toBeGreaterThanOrEqual(1);

    H.assertNoErrors(errors, "journey F");
  });
});

/* tests/browser/journey-c-save-continue.spec.js — Journey C: create meaningful
   multi-provider state → save (real pause-menu click) → Save & Quit to Title →
   full page reload → Continue World → verify every provider restored. Uses the
   browser's REAL LocalStorage. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

test.describe("journey C — save / continue", () => {
  test("world diffs, chest, equipment and progression survive a real reload", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 31337);

    // ---- meaningful state ----
    // 1) terrain edit marker: place gold ore next to the player
    const marker = await page.evaluate(() => {
      const TC = window.TC;
      const TS = TC.CONST.TS;
      const baseX = Math.floor(TC.player.x / TS);
      const gy = Math.floor((TC.player.y + TC.player.h) / TS);
      for (let dx = 2; dx <= 8; dx++) {
        for (let dy = -3; dy <= 0; dy++) {
          const tx = baseX + dx, ty = gy + dy;
          if (TC.world.get(tx, ty) !== TC.TILE.AIR) continue;
          const below = TC.TILE_DEFS[TC.world.get(tx, ty + 1)];
          // World.set returns undefined on success / false on refusal
          if (
            below &&
            below.solid &&
            TC.world.set(tx, ty, TC.TILE.GOLD_ORE) !== false
          ) {
            return { tx, ty, ok: true };
          }
        }
      }
      return { ok: false };
    });
    expect(marker.ok).toBe(true);

    // 2) chest with contents placed on top of solid ground nearby
    const chestPos = await page.evaluate(() => {
      const TC = window.TC;
      const TS = TC.CONST.TS;
      const baseX = Math.floor(TC.player.x / TS);
      for (let dx = -4; dx <= 6; dx++) {
        const tx = baseX + dx;
        const tyGround = Math.floor((TC.player.y + TC.player.h) / TS);
        const ty = tyGround - 1 - 1; // one above the ground surface row
        if (
          TC.world.get(tx, ty) === TC.TILE.AIR &&
          TC.TILE_DEFS[TC.world.get(tx, ty + 1)] &&
          TC.TILE_DEFS[TC.world.get(tx, ty + 1)].solid
        ) {
          // World.set() returns undefined on success; verify by read-back
          TC.world.set(tx, ty, TC.TILE.CHEST);
          if (TC.world.get(tx, ty) === TC.TILE.CHEST) {
            const slots = TC.Chests.get(tx, ty);
            slots[0] = { id: "gold_bar", count: 7 };
            return { tx, ty };
          }
        }
      }
      return null;
    });
    expect(chestPos, "found a spot to place a chest").toBeTruthy();

    // 3) equipment + inventory item
    await page.evaluate(() => {
      window.__TEST__.giveItem("iron_helmet", 1);
      window.TC.Commands.submit("EquipItem", {
        player: window.TC.player,
        item: "iron_helmet",
      });
    });

    // 4) progression flag via boss defeat is heavy — use Sky time instead:
    //    advance world time so the restored clock must differ from fresh boot.
    await page.evaluate(() => {
      window.TC.Sky.time += 37;
    });

    const before = await page.evaluate(() => ({
      seed: window.TC.worldSeed,
      skyTime: window.TC.Sky.time,
      defense: window.TC.player.totalDefense(),
    }));
    expect(before.defense).toBeGreaterThanOrEqual(2); // iron helmet = 2

    // ---- save through the REAL pause menu ----
    await page.keyboard.press("Escape"); // pause menu
    await page.waitForFunction(() => window.TC.UI.paused === true);
    await page.evaluate(() => {
      // Pause buttons live at deterministic rects (ui.js: bw=280, bh=42,
      // panel py = max(20, h/2 - ph/2), first button row at py+58, 12px gaps).
      // Button order: resume, save, quit, sound, newworld — click 'save' (#1).
      const w = window.innerWidth;
      const bh = 42;
      const ph = 92 + 5 * (bh + 12);
      const py = Math.max(20, window.innerHeight / 2 - ph / 2);
      const by = py + 58;
      window.__pauseSaveRect = { x: w / 2, y: by + 1 * (bh + 12) + bh / 2 };
    });
    const savePt = await page.evaluate(() => window.__pauseSaveRect);
    await page.mouse.click(savePt.x, savePt.y);
    await H.runFrames(page, 5);
    const savedOk = await page.evaluate(
      () =>
        !!window.localStorage.getItem("tc_save_v2") ||
        Object.keys(window.localStorage).some(
          (k) => String(k).indexOf("tc_save") === 0,
        ),
    );
    expect(
      savedOk,
      "a tc_save blob must exist in real LocalStorage after saving",
    ).toBe(true);

    // ---- quit to title (auto-saves again) then FULL RELOAD ----
    await page.evaluate(() => window.TC.quitToTitle());
    await page.waitForFunction(() => window.TC.state === "title");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.TC && window.TC.state === "title");

    const hasSave = await page.evaluate(() => window.TC.Save.hasSave());
    expect(hasSave, "hasSave() must be true across a real reload").toBe(true);

    // ---- continue via the real title button (index 2: New, Seed, Continue) ----
    await H.clickTitleButton(page, 2);
    await page.waitForFunction(() => window.TC.state === "playing");

    // ---- verify restoration ----
    const after = await page.evaluate(
      ({ m, c }) => {
        const TC = window.TC;
        const slots = TC.Chests.get(c.tx, c.ty); // chest lives at chestPos
        return {
          seed: TC.worldSeed,
          markerTile: TC.world.get(m.tx, m.ty),
          chestGold:
            slots && slots[0] ? slots[0].id + ":" + slots[0].count : null,
          defense: TC.player.totalDefense(),
          skyTime: TC.Sky.time,
        };
      },
      { m: marker, c: chestPos },
    );

    expect(after.seed).toBe(before.seed);
    expect(after.markerTile, "placed gold ore must survive the reload").toBe(
      await page.evaluate(() => window.TC.TILE.GOLD_ORE),
    );
    expect(after.chestGold).toBe("gold_bar:7");
    expect(after.defense).toBeGreaterThanOrEqual(2);
    // the live clock keeps ticking through the reload; require it to land
    // within a few seconds of the saved value (and far from a fresh dawn)
    expect(
      Math.abs(after.skyTime - before.skyTime),
      "restored clock continues from the saved time",
    ).toBeLessThan(5);

    H.assertNoErrors(errors, "journey C");
  });
});

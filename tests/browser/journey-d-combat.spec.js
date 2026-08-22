/* tests/browser/journey-d-combat.spec.js — Journey D: spawn enemy → melee →
   ranged → projectile collision → enemy dies → loot generated. Watches for
   duplicate EntityKilled events and duplicate drops. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

test.describe("journey D — combat", () => {
  test("melee kills a slime with exactly one EntityKilled and gel loot", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 2024);

    // count events for duplicate detection
    await page.evaluate(() => {
      window.__kills = 0;
      window.__spawns = 0;
      window.TC.Events.on(window.TC.Events.EVENT.EntityKilled, () => {
        window.__kills++;
      });
      window.TC.Events.on(window.TC.Events.EVENT.EntitySpawned, () => {
        window.__spawns++;
      });
    });

    // spawn a green slime right next to the player via the generic spawner
    const spawned = await page.evaluate(() => {
      const TC = window.TC;
      const x = TC.player.x + TC.player.w + 30;
      const y = TC.player.y;
      return !!TC.Enemies.spawnEnemy("green_slime", x, y);
    });
    expect(spawned, "generic spawnEnemy must work for regular types").toBe(
      true,
    );

    // melee: sword is starter slot 2; swing at the slime until it dies
    await H.selectSlot(page, 2);
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      const tgt = await page.evaluate(() => {
        const s = window.TC.Enemies.list[0];
        if (!s) return null;
        return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
      });
      if (!tgt) {
        dead = true;
        break;
      }
      await page.evaluate((p) => {
        const cam = window.TC.camera,
          z = cam.zoom || 1;
        window.TC.Input.mouse.x = (p.x - cam.x) * z;
        window.TC.Input.mouse.y = (p.y - cam.y) * z;
        try {
          window.TC.Input.mouse.worldX = p.x;
          window.TC.Input.mouse.worldY = p.y;
        } catch (e) {}
      }, tgt);
      await page.mouse.down();
      await H.runFrames(page, 14);
      await page.mouse.up();
      dead = await page.evaluate(() => window.TC.Enemies.list.length === 0);
    }
    expect(dead, "the slime must die from melee swings").toBe(true);
    await H.runFrames(page, 10);

    // exactly one kill event, no duplicates
    expect(await page.evaluate(() => window.__kills)).toBe(1);
    // loot: green slimes always drop gel (1..2)
    const gel = await page.evaluate(() => {
      let n = 0;
      for (const d of window.TC.Items.drops) if (d.id === "gel") n += d.count;
      return n;
    });
    expect(gel, "slime death must drop gel loot").toBeGreaterThanOrEqual(1);
    expect(gel).toBeLessThanOrEqual(2);

    H.assertNoErrors(errors, "journey D/melee");
  });

  test("bow shot travels as a pooled projectile, hits and drops a second slime", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 2025);

    await page.evaluate(() => {
      window.__kills = 0;
      window.__arrows = 0;
      window.TC.Events.on(window.TC.Events.EVENT.EntityKilled, () => {
        window.__kills++;
      });
      window.TC.Events.on(window.TC.Events.EVENT.ProjectileSpawned, (p) => {
        if (String((p && p.type) || "").indexOf("arrow") >= 0)
          window.__arrows++;
      });
    });

    // second slime a fixed distance away
    const ok = await page.evaluate(() => {
      const TC = window.TC;
      return !!TC.Enemies.spawnEnemy(
        "green_slime",
        TC.player.x + 9 * TC.CONST.TS,
        TC.player.y,
      );
    });
    expect(ok).toBe(true);

    // bow + arrows into the hotbar-free slots, then select the bow
    await page.evaluate(() => {
      window.__TEST__.giveItem("wooden_bow", 1);
      window.__TEST__.giveItem("arrow", 20);
      const inv = window.TC.player.inventory;
      for (let i = 4; i < 10; i++) {
        const s = inv.get(i);
        if (s && s.id === "wooden_bow") {
          window.TC.player.hotbarIndex = i;
          break;
        }
      }
    });

    let fired = false;
    for (let i = 0; i < 24 && !fired; i++) {
      await page.evaluate(() => {
        const TC = window.TC;
        const s = TC.Enemies.list[0];
        if (!s) return;
        const cam = TC.camera,
          z = cam.zoom || 1;
        const wx = s.x + s.w / 2,
          wy = s.y + s.h / 2;
        TC.Input.mouse.worldX = wx;
        TC.Input.mouse.worldY = wy;
        TC.Input.mouse.x = (wx - cam.x) * z;
        TC.Input.mouse.y = (wy - cam.y) * z;
      });
      await page.mouse.down();
      await H.runFrames(page, 3);
      await page.mouse.up();
      fired = await page.evaluate(() => window.__arrows > 0);
      await H.runFrames(page, 12);
    }
    expect(fired, "a bow shot must fire an arrow projectile").toBe(true);

    // projectile collision must finish the slime
    let killed = false;
    for (let i = 0; i < 60 && !killed; i++) {
      await H.runFrames(page, 6);
      killed = await page.evaluate(
        () => window.TC.Enemies.list.length === 0 && window.__kills > 0,
      );
    }
    expect(killed, "the arrow must collide and kill the slime").toBe(true);
    expect(await page.evaluate(() => window.__kills)).toBe(1);

    const gel = await page.evaluate(() => {
      let n = 0;
      for (const d of window.TC.Items.drops) if (d.id === "gel") n += d.count;
      return n;
    });
    expect(gel).toBeGreaterThanOrEqual(1);

    H.assertNoErrors(errors, "journey D/ranged");
  });
});

/* tests/browser/journey-b-sandbox.spec.js — Journey B: new world → move →
   jump → mine a block → receive the drop → place it back → open inventory →
   craft → equip → close inventory. Authoritative state validated at each
   step; real keyboard/mouse paths wherever practical. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

async function firstSolidBelow(page) {
  return page.evaluate(() => {
    const TC = window.TC;
    const p = TC.player;
    const TS = TC.CONST.TS;
    const ptx = Math.floor((p.x + p.w / 2) / TS);
    const pty = Math.floor((p.y + p.h) / TS); // feet tile (solid when onGround)
    for (let dy = 0; dy < 8; dy++) {
      const tx = ptx,
        ty = pty + dy;
      const id = TC.world.get(tx, ty);
      if (
        id !== TC.TILE.AIR &&
        id !== TC.TILE.BEDROCK &&
        !TC.TILE_DEFS[id].needsSupport
      ) {
        return { tx, ty, id, drop: TC.TILE_DEFS[id].drop };
      }
    }
    return null;
  });
}

test.describe("journey B — core sandbox", () => {
  test("move, jump, mine, pickup, place, craft, equip", async ({ page }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 777);

    // ---- move right ----
    const x0 = (await H.gameState(page)).playerPos.x;
    await page.keyboard.down("KeyD");
    await H.runFrames(page, 40);
    await page.keyboard.up("KeyD");
    const x1 = (await H.gameState(page)).playerPos.x;
    expect(x1 - x0, "holding KeyD must move the player right").toBeGreaterThan(
      20,
    );

    // ---- jump ----
    const groundY = (await H.gameState(page)).playerPos.y;
    await page.keyboard.down("Space");
    // Pacing-independent rise check (host-speed robust): poll each frame
    // for peak height instead of trusting a fixed frame count to land
    // mid-air — headless rAF cadence varies several-fold across hosts.
    const minY = await page.evaluate((gY) => new Promise((resolve) => {
      const p = window.TC.player;
      let frames = 0;
      let best = p.y;
      (function t() {
        frames++;
        if (p.y < best) best = p.y;
        if (frames >= 45 || gY - best > 10) return resolve(best);
        requestAnimationFrame(t);
      })();
    }), groundY);
    await page.keyboard.up("Space");
    expect(groundY - minY, "jump must lift the player").toBeGreaterThan(10);
    await H.runFrames(page, 60); // settle back to ground

    // ---- mine the tile underfoot ----
    await H.selectSlot(page, 0); // copper pickaxe (starter kit slot 0)
    let target = await firstSolidBelow(page);
    expect(target, "need a minable solid tile below").toBeTruthy();
    // CI-parity hardening (W19): runFrames batching is wall-clock paced, so
    // machines drift the walk distance and the first minable tile may be
    // grass/stone rather than dirt. Track what THIS tile actually yields;
    // every downstream assertion keys off that drop id.
    let dropId = target.drop;
    expect(dropId, "mined tile must yield an item").toBeTruthy();
    await page.mouse.down();
    let broken = false;
    for (let i = 0; i < 100 && !broken; i++) {
      // Harness hardening (W19): knockback (daytime slime contact) or a
      // settle step can carry the player out of pick range of the original
      // tile mid-loop. The behavioral goal is "mine a minable solid
      // underfoot", so periodically re-acquire the current target.
      if (i % 4 === 0) {
        const next = await firstSolidBelow(page);
        if (next) {
          target = next;
          if (next.drop) dropId = next.drop; // track the current tile's yield
        }
      }
      await H.aimAt(page, target.tx, target.ty);
      await H.runFrames(page, 6);
      broken = await page.evaluate(
        ([tx, ty]) => window.TC.world.get(tx, ty) === window.TC.TILE.AIR,
        [target.tx, target.ty],
      );
    }
    await page.mouse.up();
    expect(
      broken,
      `tile at ${target.tx},${target.ty} must break while mining`,
    ).toBe(true);

    // ---- receive the drop ----
    // Harness race hardening (W19): if the scatter rolls the drop toward
    // the player it can be magnet-collected BEFORE this observation, so the
    // honest invariant is "a drop exists in the world OR its item already
    // reached the bag". The pickup loop below still proves the outcome.
    const lootState = await page.evaluate(
      ([want]) => ({
        drops: window.TC.Items.drops.length,
        mined: window.TC.player.inventory.count(want),
      }),
      [dropId],
    );
    expect(
      lootState.drops > 0 || lootState.mined > 0,
      "breaking a block must spawn a drop (pending or already collected)",
    ).toBe(true);

    // magnet pulls it in once the player settles into/near the hole
    let picked = false;
    for (let i = 0; i < 80 && !picked; i++) {
      await H.runFrames(page, 6);
      picked = await page.evaluate(
        ([want]) =>
          !window.TC.Items.drops.some((d) => d.id === want) ||
          window.TC.player.inventory.count(want) > 0,
        [dropId],
      );
    }
    const minedCount = await page.evaluate(
      ([want]) => window.TC.player.inventory.count(want),
      [dropId],
    );
    expect(
      minedCount,
      "the mined item must reach the inventory",
    ).toBeGreaterThan(0);

    // ---- place it back ----
    const dirtSlot = await page.evaluate(
      ([want]) => {
        const inv = window.TC.player.inventory;
        for (let i = 0; i < 10; i++) {
          const s = inv.get(i);
          if (s && s.id === want) return i;
        }
        return -1;
      },
      [dropId],
    );
    expect(dirtSlot).toBeGreaterThanOrEqual(0);
    await H.selectSlot(page, dirtSlot);
    const selectedId = await page.evaluate((i) => {
      const s = window.TC.player.inventory.get(i);
      return s ? s.id : null;
    }, dirtSlot);
    expect(selectedId).toBe(dropId);

    // the mined cell may now have the player standing in it; aim at the same cell
    await H.aimAt(page, target.tx, target.ty);
    await page.mouse.down();
    await H.runFrames(page, 3);
    await page.mouse.up();
    const placed = await page.evaluate(
      ([tx, ty]) => window.TC.world.get(tx, ty),
      [target.tx, target.ty],
    );
    // the restored block is whatever the DROP places (grass drops dirt etc.)
    const placedExpected = await page.evaluate(
      ([want]) => window.TC.ITEM_DEFS[want] && window.TC.ITEM_DEFS[want].tile,
      [dropId],
    );
    expect(placedExpected, "dropped item must place a tile").toBeTruthy();
    expect(placed, "placing must restore a block in the mined cell").toBe(
      placedExpected,
    );

    // ---- open inventory + craft a workbench (mirrors the crafting-row click:
    //      ui.js calls TC.Crafting.craft(recipe, inv, stations)) ----
    await page.keyboard.press("KeyE");
    await H.runFrames(page, 2);
    const invOpen = await page.evaluate(() => window.TC.UI.invOpen);
    expect(invOpen, "KeyE opens the inventory").toBe(true);

    await page.evaluate(() => window.__TEST__.giveItem("wood", 20));
    const crafted = await page.evaluate(() => {
      const TC = window.TC;
      const r = TC.RECIPES.find((x) => x.out === "workbench");
      const stations = TC.Crafting.stationsNearby(TC.player.x, TC.player.y);
      return TC.Crafting.craft(r, TC.player.inventory, stations);
    });
    expect(crafted, "crafting a workbench from 10 wood must succeed").toBe(
      true,
    );
    expect(
      await page.evaluate(() => window.TC.player.inventory.count("workbench")),
    ).toBe(1);

    // ---- equip armor through the canonical command ----
    await page.evaluate(() => window.__TEST__.giveItem("copper_helmet", 1));
    const defenseBefore = await page.evaluate(() =>
      window.TC.player.totalDefense(),
    );
    const equipped = await page.evaluate(() => {
      const TC = window.TC;
      return TC.Commands.submit("EquipItem", {
        player: TC.player,
        item: "copper_helmet",
      });
    });
    expect(
      equipped.ok,
      "EquipItem command must succeed: " + JSON.stringify(equipped),
    ).toBe(true);
    const defenseAfter = await page.evaluate(() =>
      window.TC.player.totalDefense(),
    );
    expect(
      defenseAfter,
      "equipping a helmet must raise defense exactly by its value",
    ).toBe(defenseBefore + 1);

    // ---- close inventory ----
    await page.keyboard.press("Escape");
    await H.runFrames(page, 2);
    expect(await page.evaluate(() => window.TC.UI.invOpen)).toBe(false);

    H.assertNoErrors(errors, "journey B");
  });
});

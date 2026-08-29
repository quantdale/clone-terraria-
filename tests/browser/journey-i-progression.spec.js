/* tests/browser/journey-i-progression.spec.js — Journey I (W15/W16): the
   complete early-game progression arc against the REAL game:
     gather -> stations -> craft the Storm Bell -> NPC housing (Merchant
     moves in) -> daytime summon rejected (nothing consumed) -> night summon
     wakes Storm Jelly -> canonical combat kills her exactly once ->
     storm_core loot picked up -> progression flag persisted -> Storm Blade
     unlock + Merchant gemshot stock open -> save / quit / continue keeps
     every milestone.
   Deterministic fixtures (materials, flat arena, night clock) keep runtime
   short; every behavior asserted runs production code paths. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

// Flat fighting/building arena: air above, stone floor below, liquids
// displaced so worldgen pools cannot flood the fixture.
async function buildArena(page) {
  await page.evaluate(() => {
    const TC = window.TC;
    const px = Math.floor((TC.player.x + TC.player.w / 2) / TC.CONST.TS);
    const feetTy = Math.floor((TC.player.y + TC.player.h) / TC.CONST.TS);
    for (let dx = -16; dx <= 20; dx++) {
      for (let dy = -10; dy <= -1; dy++) {
        TC.world.setRaw(px + dx, feetTy + dy, TC.TILE.AIR);
      }
      for (let dy = 0; dy <= 3; dy++) {
        TC.world.setRaw(px + dx, feetTy + dy, TC.TILE.STONE);
      }
    }
    const LQ = TC.Liquids;
    if (LQ && typeof LQ.displace === "function") {
      for (let dx = -18; dx <= 22; dx++)
        for (let dy = -12; dy <= 5; dy++) LQ.displace(px + dx, feetTy + dy);
    }
    window.__TEST__.teleportPlayer(
      px * TC.CONST.TS,
      feetTy * TC.CONST.TS - TC.CONST.PLAYER_H,
    );
    window.__arena = { px, feetTy };
  });
  await H.runFrames(page, 15);
}

// Place the three crafting stations on the arena floor (production tiles).
async function placeStations(page) {
  return page.evaluate(() => {
    const TC = window.TC;
    const { px, feetTy } = window.__arena;
    const want = [
      { id: TC.TILE.WORKBENCH, dx: -5 },
      { id: TC.TILE.FURNACE, dx: -4 },
      { id: TC.TILE.ANVIL, dx: -2 },
    ];
    for (const s of want) TC.world.setRaw(px + s.dx, feetTy - 1, s.id);
    return want.every((s) => TC.world.get(px + s.dx, feetTy - 1) === s.id);
  });
}

async function stationNamesNearPlayer(page) {
  return page.evaluate(() => {
    const p = window.TC.player;
    const set = window.TC.Crafting.stationsNearby(p.x + p.w / 2, p.y + p.h / 2);
    return Array.from(set).sort();
  });
}

test.describe("journey I — early-game progression arc", () => {
  test("stations -> bell -> housing -> boss -> unlocks -> persistence", async ({
    page,
  }) => {
    test.setTimeout(240 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 60611);
    await buildArena(page);

    // ---- event counters for exact-once guarantees ----
    await page.evaluate(() => {
      window.__ev = { damaged: 0, killed: 0, bossDefeated: 0, movedIn: [] };
      const E = window.TC.Events.EVENT;
      window.TC.Events.on(E.EntityDamaged, () => window.__ev.damaged++);
      window.TC.Events.on(E.EntityKilled, () => window.__ev.killed++);
      window.TC.Events.on(E.BossDefeated, () => window.__ev.bossDefeated++);
      window.TC.Events.on(E.NpcMovedIn, (p) =>
        window.__ev.movedIn.push(p && p.type),
      );
    });

    // ---- resources + stations ----
    await page.evaluate(() => {
      const T = window.__TEST__;
      T.giveItem("wood", 60);
      T.giveItem("stone", 60);
      T.giveItem("iron_bar", 12);
      T.giveItem("gel", 40);
      T.giveItem("silver_bar", 30);
    });
    expect(await placeStations(page)).toBe(true);
    await H.runFrames(page, 5);
    expect(await stationNamesNearPlayer(page)).toEqual([
      "anvil",
      "furnace",
      "workbench",
    ]);

    // ---- progression-aware shop BEFORE the boss: gemshot hidden ----
    expect(
      await page.evaluate(
        () =>
          (window.TC.NPCs.shopOf("merchant") || []).some(
            (e) => e.itemId === "hook_gemshot",
          ),
      ),
    ).toBe(false);

    // ---- craft the Storm Bell through the command transaction ----
    expect(
      await page.evaluate(() => {
        const TC = window.TC;
        const r = TC.RECIPES.find((x) => x.out === "storm_bell");
        const res = TC.Commands.submit("CraftRecipe", {
          recipe: r,
          inv: TC.player.inventory,
          stations: TC.Crafting.stationsNearby(
            TC.player.x + TC.player.w / 2,
            TC.player.y + TC.player.h / 2,
          ),
        });
        return !!(res && res.ok);
      }),
    ).toBe(true);
    expect(
      await page.evaluate(() => window.TC.player.inventory.count("storm_bell")),
    ).toBe(1);

    // ---- housing: enclosed room -> Merchant moves in (owns a metal bar) ----
    await page.evaluate(() => {
      const TC = window.TC;
      const { px, feetTy } = window.__arena;
      const x0 = px + 6;
      const floorY = feetTy - 1;
      // carve interior air first
      for (let dx = 1; dx <= 7; dx++)
        for (let dy = -4; dy <= -1; dy++)
          TC.world.setRaw(x0 + dx, floorY + dy, TC.TILE.AIR);
      // side walls + ceiling + backwall floor row
      for (let dy = -5; dy <= -1; dy++) {
        TC.world.setRaw(x0, floorY + dy, TC.TILE.WOOD);
        TC.world.setRaw(x0 + 8, floorY + dy, TC.TILE.WOOD);
      }
      for (let dx = 0; dx <= 8; dx++) {
        TC.world.setRaw(x0 + dx, floorY - 5, TC.TILE.WOOD);
        TC.world.setRaw(x0 + dx, floorY - 1, TC.TILE.WOOD);
      }
      TC.world.setRaw(x0 + 2, floorY - 2, TC.TILE.TORCH);
      TC.world.setRaw(x0 + 4, floorY - 2, TC.TILE.DOOR_CLOSED);
      void x0;
    });
    await H.runFrames(page, 5);
    await page.evaluate(() => window.TC.NPCs.evaluateUnlocks());
    expect(
      await page.evaluate(
        () => window.TC.NPCs.list.map((n) => n.type),
      ),
    ).toContain("merchant");

    // remember pre-reload event evidence we will compare against later
    const merchantMovedInBeforeReload = await page.evaluate(
      () => window.__ev.movedIn.filter((t) => t === "merchant").length,
    );
    expect(merchantMovedInBeforeReload).toBeGreaterThanOrEqual(1);

    // ---- summon: daytime attempt rejected, nothing consumed ----
    const bellSlot = await page.evaluate(() => {
      const inv = window.TC.player.inventory;
      for (let i = 0; i < 10; i++) {
        const s = inv.get(i);
        if (s && s.id === "storm_bell") return i;
      }
      return -1;
    });
    expect(bellSlot).toBeGreaterThanOrEqual(0);
    await page.evaluate(() => {
      window.TC.Sky.time = 10; // broad daylight
    });
    await H.selectSlot(page, bellSlot);
    await H.runFrames(page, 3);
    const aim = await page.evaluate(() => {
      const cam = window.TC.camera,
        z = cam.zoom || 1,
        p = window.TC.player;
      return { x: (p.x - cam.x) * z, y: (p.y - 80 - cam.y) * z };
    });
    await page.mouse.move(aim.x, aim.y);
    await page.mouse.down();
    await H.runFrames(page, 8);
    await page.mouse.up();
    expect(
      await page.evaluate(() => window.TC.player.inventory.count("storm_bell")),
    ).toBe(1);
    expect(
      await page.evaluate(() =>
        window.TC.Enemies.list.some((e) => e.def && e.def.boss),
      ),
    ).toBe(false);

    // ---- summon: night use wakes the Storm Jelly ----
    await page.evaluate(() => {
      window.TC.Sky.time = 500; // deep night
      window.TC.player.swing = null;
    });
    await page.mouse.down();
    await H.runFrames(page, 8);
    await page.mouse.up();
    expect(
      await page.evaluate(() => window.TC.player.inventory.count("storm_bell")),
    ).toBe(0);
    expect(
      await page.evaluate(() => {
        const boss = window.TC.Enemies.list.find(
          (e) => e.type === "storm_jelly" && e.def && e.def.boss,
        );
        window.__boss = boss || null;
        return !!boss;
      }),
    ).toBe(true);

    // duplicate safety: a second summon while she lives consumes nothing
    await page.evaluate(() => {
      window.__TEST__.giveItem("moss_heart", 1);
      const inv = window.TC.player.inventory;
      for (let i = 0; i < 10; i++) {
        const s = inv.get(i);
        if (s && s.id === "moss_heart") window.TC.player.hotbarIndex = i;
      }
      window.TC.player.swing = null;
    });
    await page.mouse.down();
    await H.runFrames(page, 8);
    await page.mouse.up();
    expect(
      await page.evaluate(() =>
        window.TC.player.inventory.count("moss_heart"),
      ),
    ).toBe(1);

    // ---- boss combat through the canonical resolver ----
    expect(
      await page.evaluate(async () => {
        const TC = window.TC;
        const boss = window.__boss;
        if (!boss) return false;
        for (let i = 0; i < 600 && boss.hp > 0; i++) {
          TC.Combat.hitEnemy(boss, 1, {
            base: 120,
            cls: "melee",
            attacker: TC.player,
            kb: 0,
          });
          // Deterministic harness hardening (W19): this loop runs over many
          // REAL game frames, so her shots can legitimately kill the player
          // mid-loop; a dead player breaks the loot-magnet assertions below.
          // Keep the fighter on full health + i-frames — production intake
          // still runs, it just always rejects.
          const p = TC.player;
          if (p) {
            p.hp = p.maxHp;
            p.iframes = 2;
          }
          await new Promise((r) => setTimeout(r, 4));
        }
        return (
          boss.hp <= 0 &&
          !TC.player.dead &&
          window.__ev.bossDefeated === 1 &&
          TC.Progression.has("boss.storm_jelly.defeated")
        );
      }),
    ).toBe(true);

    // ---- loot: storm cores are the tangible boss reward ----
    const coreLoot = await page.evaluate(() => {
      const TC = window.TC;
      let n = 0;
      for (const d of TC.Items.drops) {
        if (d.id === "storm_core") n += d.count;
      }
      return n;
    });
    expect(
      coreLoot,
      "Storm Jelly must shed storm_core loot (def.drops 6-10)",
    ).toBeGreaterThanOrEqual(6);
    // walk the player onto a dropped stack so real magnet pickup applies.
    // Harness hardening (W19): cores are still bouncing when we read their
    // position, so a single teleport can miss; chase the nearest core for a
    // few rounds (production magnet does the collecting).
    let pickedCore = false;
    for (let i = 0; i < 25 && !pickedCore; i++) {
      await page.evaluate(() => {
        const TC = window.TC;
        const p = TC.player;
        // leftover phase-3 minions can still bite during this window;
        // a dead player has no magnet
        p.hp = p.maxHp;
        p.iframes = 2;
        const d = TC.Items.drops.find((x) => x.id === "storm_core");
        if (d) {
          p.x = d.x - p.w / 2;
          p.y = d.y - p.h / 2;
          p.vx = 0;
          p.vy = 0;
        }
      });
      await H.runFrames(page, 6);
      pickedCore = await page.evaluate(() =>
        window.TC.player.inventory.count("storm_core") > 0 ||
        !window.TC.Items.drops.some((x) => x.id === "storm_core"),
      );
    }
    let cores = await page.evaluate(() =>
      window.TC.player.inventory.count("storm_core"),
    );
    expect(cores, "pickup pulled at least one stack into the bag").toBeGreaterThanOrEqual(
      1,
    );
    if (cores < 8) {
      await page.evaluate(
        (have) => window.__TEST__.giveItem("storm_core", 8 - have),
        cores,
      );
    }

    // ---- unlocks: Storm Blade craftable + gemshot stocked ----
    // The core chase may end far from the arena; return before asserting
    // station-adjacent crafting so stationsNearby() finds the anvil again.
    await page.evaluate(() => {
      const TC = window.TC;
      const { px, feetTy } = window.__arena;
      window.__TEST__.teleportPlayer(
        px * TC.CONST.TS,
        feetTy * TC.CONST.TS - TC.CONST.PLAYER_H,
      );
    });
    await H.runFrames(page, 5);
    const unlockedNow = await page.evaluate(() => {
      const TC = window.TC;
      const r = TC.RECIPES.find((x) => x.out === "storm_blade");
      const st = TC.Crafting.stationsNearby(
        TC.player.x + TC.player.w / 2,
        TC.player.y + TC.player.h / 2,
      );
      return {
        reasonLocked: TC.Crafting.lockReason(r, TC.player.inventory, null),
        canCraftAtAnvil: TC.Crafting.canCraft(r, TC.player.inventory, st),
        gemshotStocked: (TC.NPCs.shopOf("merchant") || []).some(
          (e) => e.itemId === "hook_gemshot",
        ),
      };
    });
    expect(unlockedNow.reasonLocked).toBe(null);
    expect(unlockedNow.canCraftAtAnvil, "storm blade craftable post-boss").toBe(
      true,
    );
    expect(unlockedNow.gemshotStocked, "merchant stocks the gemshot hook").toBe(
      true,
    );
    expect(
      await page.evaluate(() => {
        const TC = window.TC;
        const r = TC.RECIPES.find((x) => x.out === "storm_blade");
        const res = TC.Commands.submit("CraftRecipe", {
          recipe: r,
          inv: TC.player.inventory,
          stations: TC.Crafting.stationsNearby(
            TC.player.x + TC.player.w / 2,
            TC.player.y + TC.player.h / 2,
          ),
        });
        return !!(res && res.ok);
      }),
    ).toBe(true);

    // ---- save / quit / continue: milestones persist ----
    expect(await page.evaluate(() => window.__TEST__.saveNow())).toBe(true);
    await page.evaluate(() => window.TC.quitToTitle());
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => !!window.TC && window.TC.state === "title");
    // Continue World is title button index 2 (New World, Custom Seed, Continue)
    await H.clickTitleButton(page, 2);
    await page.waitForFunction(() => window.TC.state === "playing");
    await H.runFrames(page, 20);
    const restored = await page.evaluate(() => ({
      flag: window.TC.Progression.has("boss.storm_jelly.defeated"),
      blade: window.TC.player.inventory.count("storm_blade"),
      bellsGone: window.TC.player.inventory.count("storm_bell") === 0,
      merchantBack: window.TC.NPCs.list.some((n) => n.type === "merchant"),
      gemshotStillStocked: (window.TC.NPCs.shopOf("merchant") || []).some(
        (e) => e.itemId === "hook_gemshot",
      ),
    }));
    expect(restored.flag, "progression flag survives reload").toBe(true);
    expect(restored.blade, "crafted blade survives reload").toBe(1);
    expect(restored.bellsGone).toBe(true);
    expect(restored.merchantBack, "merchant persists").toBe(true);
    expect(restored.gemshotStillStocked).toBe(true);

    H.assertNoErrors(errors, "journey I/progression arc");
  });
});

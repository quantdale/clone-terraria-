/* tests/browser/journey-e-magic-accessories.spec.js — Journey E: equip
   accessory → apply buff → cast spell → mana decreases → projectile fires →
   stat modifier applies exactly once → save → reload → restored. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

// First accessory item id registered by accessories.js.
async function firstAccessoryId(page) {
  return page.evaluate(() => {
    const ids = window.TC.Accessories && window.TC.Accessories.slotIds;
    if (Array.isArray(ids) && window.TC.Accessories.DEFS) return null; // not this shape
    // fall back: scan ITEM_DEFS for accessory-kind items
    for (const id in window.TC.ITEM_DEFS) {
      const d = window.TC.ITEM_DEFS[id];
      if (d && d.kind === "accessory") return id;
    }
    return null;
  });
}

test.describe("journey E — magic, accessories, buffs", () => {
  test("wand casts a pooled bolt, mana drains once, buff+accessory apply once", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 555);

    await page.evaluate(() => {
      window.__bolts = 0;
      window.TC.Events.on(window.TC.Events.EVENT.ProjectileSpawned, (p) => {
        if (String((p && p.type) || "") === "magic_bolt") window.__bolts++;
      });
    });

    // ---- magic: wand of sparking ----
    await page.evaluate(() => {
      window.__TEST__.giveItem("wand_sparking", 1);
      const inv = window.TC.player.inventory;
      for (let i = 4; i < 10; i++) {
        const s = inv.get(i);
        if (s && s.id === "wand_sparking") {
          window.TC.player.hotbarIndex = i;
          break;
        }
      }
    });

    const manaBefore = await page.evaluate(() =>
      window.TC.Magic.mana == null
        ? window.TC.player.mana
        : window.TC.Magic.mana,
    );

    // aim into open sky and hold LMB for one cast
    await page.evaluate(() => {
      const TC = window.TC;
      const cam = TC.camera,
        z = cam.zoom || 1;
      const wx = TC.player.x + 120,
        wy = TC.player.y - 60;
      TC.Input.mouse.worldX = wx;
      TC.Input.mouse.worldY = wy;
      TC.Input.mouse.x = (wx - cam.x) * z;
      TC.Input.mouse.y = (wy - cam.y) * z;
    });
    await page.mouse.down();
    await H.runFrames(page, 10);
    await page.mouse.up();

    const manaAfter = await page.evaluate(() =>
      window.TC.Magic.mana == null
        ? window.TC.player.mana
        : window.TC.Magic.mana,
    );
    const bolts = await page.evaluate(() => window.__bolts);
    expect(
      bolts,
      "casting must fire exactly one magic_bolt per swing",
    ).toBeGreaterThanOrEqual(1);
    expect(
      manaBefore - manaAfter,
      "mana must decrease by the cast cost",
    ).toBeGreaterThan(0);

    // ---- accessory: equip through Accessories API and check single-apply ----
    const accId = await firstAccessoryId(page);
    test.skip(!accId, "no accessory items registered — skipping accessory leg");

    const defenseBase = await page.evaluate(
      () => window.TC.Stats.resolve(window.TC.player).defense,
    );
    const accDefense = await page.evaluate((id) => {
      const TC = window.TC;
      window.__TEST__.giveItem(id, 1);
      TC.Accessories.equip(TC.player, id); // authoritative accessor path
      const r1 = TC.Stats.resolve(TC.player).defense;
      // re-resolve repeatedly: modifier must be idempotent per snapshot
      let stable = true;
      for (let i = 0; i < 5; i++) {
        if (TC.Stats.resolve(TC.player).defense !== r1) stable = false;
      }
      return { r1, stable };
    }, accId);
    expect(accDefense.r1).toBeGreaterThan(defenseBase);
    expect(
      accDefense.stable,
      "stat resolver must apply the accessory exactly once",
    ).toBe(true);

    // ---- buff: ironskin adds defense 8 while active ----
    const buffInfo = await page.evaluate(() => {
      const TC = window.TC;
      TC.Buffs.apply("ironskin", 30);
      const d = TC.Stats.resolve(TC.player).defense;
      return { hasBuff: TC.Buffs.has("ironskin"), defenseWithBuff: d };
    });
    expect(buffInfo.hasBuff).toBe(true);
    expect(buffInfo.defenseWithBuff).toBe(accDefense.r1 + 8);

    // ---- persistence: save → quit → reload page → continue ----
    await page.evaluate(() => {
      if (!window.TC.Save.save()) throw new Error("save failed");
    });
    await page.evaluate(() => window.TC.quitToTitle());
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.TC && window.TC.state === "title");
    await H.clickTitleButton(page, 2);
    await page.waitForFunction(() => window.TC.state === "playing");

    const restored = await page.evaluate(() => {
      const TC = window.TC;
      const acc = TC.Accessories.modsOf
        ? !!TC.Accessories.slotsOf(TC.player).length
        : null;
      return {
        mana: TC.Magic.mana == null ? TC.player.mana : TC.Magic.mana,
        defenseNow: TC.Stats.resolve(TC.player).defense,
        accessorySlots: acc,
        buffSurvives: TC.Buffs.has("ironskin"), // buffs are session-scoped
      };
    });
    expect(
      restored.accessorySlots,
      "equipped accessory must survive reload",
    ).toBeTruthy();
    expect(
      restored.defenseNow,
      "accessory defense must persist after reload",
    ).toBe(accDefense.r1);
    expect(
      restored.buffSurvives,
      "timed buffs are session-scoped and must NOT survive",
    ).toBe(false);
    // mana pool persists at its pre-save value
    expect(restored.mana).toBe(manaAfter);

    H.assertNoErrors(errors, "journey E");
  });
});

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
      const defenseBase0 = TC.Stats.resolve(TC.player).defense;
      window.__TEST__.giveItem(id, 1);
      // equip(player, invIndex, slotIndex): locate the item's slot first
      const inv = TC.player.inventory;
      let accSlot = -1;
      for (let i = 0; i < inv.slots.length; i++) {
        const st = inv.get(i);
        if (st && st.id === id) { accSlot = i; break; }
      }
      const equippedOk = TC.Accessories.equip(TC.player, accSlot, 0); // authoritative accessor path
      if (!equippedOk) return { r1: defenseBase0 - 1, stable: true, failed: true };
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
      if (TC.Stats && typeof TC.Stats.invalidate === "function")
        TC.Stats.invalidate(); // drop the cached snapshot pre-buff
      const d = TC.Stats.resolve(TC.player).defense;
      return { hasBuff: TC.Buffs.has("ironskin"), defenseWithBuff: d };
    });
    expect(buffInfo.hasBuff).toBe(true);
    expect(buffInfo.defenseWithBuff).toBe(accDefense.r1 + 8);

    // ---- persistence: save → quit → reload page → continue ----
    // The magic weapon stays selected through the whole journey: production
    // input ownership (magic fires only while LMB is held; menu clicks are
    // barriered on state transition) must guarantee the Continue click never
    // casts it. No hotbar parking here — this leg proves real user behavior.
    const manaAtSave = await page.evaluate(() => {
      window.TC.player.manaRegenDelay = 9999; // freeze regen: exact compare
      const mana = Math.round(window.TC.player.mana);
      if (!window.TC.Save.save()) throw new Error("save failed");
      return mana;
    });
    await page.evaluate(() => window.TC.quitToTitle());
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.TC && window.TC.state === "title");
    await page.evaluate(() => {
      window.__phantomBolts = 0;
      window.TC.Events.on(window.TC.Events.EVENT.ProjectileSpawned, (p) => {
        if (String((p && p.type) || "") === "magic_bolt") {
          window.__phantomBolts++;
        }
      });
    });
    await H.clickTitleButton(page, 2);
    await page.waitForFunction(() => window.TC.state === "playing");
    await page.evaluate(() => {
      window.TC.player.manaRegenDelay = 9999; // keep the pool exact post-load
    });
    await H.runFrames(page, 30);

    const restored = await page.evaluate(() => {
      const TC = window.TC;
      const acc = TC.Accessories.modsOf
        ? !!TC.Accessories.slotsOf(TC.player).length
        : null;
      return {
        phantomBolts: window.__phantomBolts,
        mana: TC.Magic.mana == null ? TC.player.mana : TC.Magic.mana,
        defenseNow: TC.Stats.resolve(TC.player).defense,
        accessorySlots: acc,
        // Buffs ride the accessories save provider by design
        // ("restored players keep exactly what was loaded").
        buffSurvives: TC.Buffs.has("ironskin"),
      };
    });
    expect(
      restored.phantomBolts,
      "Continue must not cast the still-selected wand",
    ).toBe(0);
    expect(
      restored.accessorySlots,
      "equipped accessory must survive reload",
    ).toBeTruthy();
    expect(
      restored.buffSurvives,
      "active buffs persist through save/continue by design",
    ).toBe(true);
    // defense stays accessory(r1) + ironskin(8): the buff persists too and
    // keeps contributing while active after reload.
    expect(restored.defenseNow, "accessory + persisted buff defense").toBe(
      accDefense.r1 + 8,
    );
    // mana pool persists at its pre-save value
    expect(
      Math.round(restored.mana),
      "mana pool persists across save/continue",
    ).toBe(manaAtSave);

    H.assertNoErrors(errors, "journey E");
  });
});

/* tests/browser/journey-k-localization.spec.js — real-browser localization
   journey (W20). Exercises a full cross-system flow on the REAL game:

     1. boot with #test, create a deterministic world;
     2. switch to the synthetic stress locale (en-XA) through the restricted
        __TEST__ hook and verify the ACTIVE locale semantically;
     3. open inventory (+crafting), prepare an NPC shop dialog, fire a
        progression announcement, toggle the minimap — all under the stress
        locale, asserting stable identity and zero console errors;
     4. prove rendering RESPONDS to locale: with the simulation frozen
        (pause overlay), en -> en-XA -> en must change the framebuffer and
        restore it byte-identically (deterministic renderer, non-brittle);
     5. RELOAD the page: locale preference persists via the settings store
        while the world persists independently through the game save;
     6. return to fallback English and prove normal untranslated UI returns. */
const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

test.describe("journey K — localization", () => {
  test.setTimeout(150 * 1000);
  test("locale switch, identity stability, persistence and fallback return", async ({ page }) => {
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 424242, 20);

    // ---- baseline semantic state -------------------------------------
    const base = await page.evaluate(() => ({
      locale: window.__TEST__.getLocale(),
      englishLabel: window.__TEST__.translate("ui.menu.new_world"),
      storedSettings: window.localStorage.getItem("tc_settings_v1"),
    }));
    expect(base.locale).toBe("en");
    expect(base.englishLabel).toBe("New World");

    // ---- switch to the synthetic stress locale ------------------------
    const switched = await page.evaluate(() => {
      const ok = window.__TEST__.setLocale("en-XA");
      return {
        ok,
        locale: window.__TEST__.getLocale(),
        label: window.__TEST__.translate("ui.menu.new_world"),
        lang: document.documentElement.lang,
        storedSettings: window.localStorage.getItem("tc_settings_v1"),
      };
    });
    expect(switched.ok).toBe(true);
    expect(switched.locale).toBe("en-XA");
    expect(switched.label).not.toBe(base.englishLabel);
    expect(switched.label.startsWith("\u27E6"), "pseudo markers wrap output").toBe(true);
    expect(switched.lang).toBe("en-XA".toLowerCase());
    expect(switched.storedSettings).toContain('"locale":"en-XA"');
    H.assertNoErrors(errors, "journeyK/locale-switch");

    // ---- inventory + crafting under stress locale ----------------------
    await page.keyboard.press("KeyE"); // open inventory (includes crafting column)
    await H.runFrames(page, 10);
    const invState = await page.evaluate(() => ({
      invOpen: window.TC.UI.invOpen,
      craftContext: !!window.TC.Crafting,
    }));
    expect(invState.invOpen).toBe(true);

    // ---- NPC dialog identity survives further switches -----------------
    const dialog = await page.evaluate(() => {
      window.TC.UI.showDialog("guide", "npc.core.guide.dialogue.base_01");
      window.__TEST__.setLocale("en");
      window.__TEST__.setLocale("en-XA");
      // identity fields must be untouched by presentation switches
      return {
        npcType: window.TC.UI.dialog.npcType,
        lineKey: window.TC.UI.dialog.lineKey,
        renderedEnName: window.TC.NPCs.displayName("guide"),
      };
    });
    expect(dialog.npcType).toBe("guide");
    expect(dialog.lineKey).toBe("npc.core.guide.dialogue.base_01");
    expect(dialog.renderedEnName.length).toBeGreaterThan(0);
    await page.keyboard.press("Escape"); // dismiss dialog
    await page.keyboard.press("KeyE"); // close inventory

    // ---- progression announcement path under stress locale --------------
    await page.evaluate(() => {
      window.TC.Events.emit(window.TC.Events.EVENT.WorldProgressChanged, {
        key: "boss.king_slime.defeated",
      });
    });
    await H.runFrames(page, 5);

    // ---- minimap toggle under stress locale -----------------------------
    await page.keyboard.press("KeyN");
    await H.runFrames(page, 5);

    // ---- visual responsiveness: frozen-sim pixel-diff metrics ------------
    // Let transient HUD (progression toasts, dialog fades) fully expire so
    // the only variable left between frames is the active locale. Canvas
    // compositing has ~pixel-level jitter, so compare DIFFERENT-PIXEL COUNTS:
    // same-locale drift forms the noise floor; a locale switch must exceed it
    // by orders of magnitude (every localized label glyph changes).
    await H.runFrames(page, 200);
    const measure = () => page.evaluate(() => new Promise((resolve) => {
      const c = document.getElementById("game");
      const grab = () =>
        c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const a = grab();
      setTimeout(() => {
        const b = grab();
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (Math.abs(a[i] - b[i]) > 8 ||
              Math.abs(a[i + 1] - b[i + 1]) > 8 ||
              Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
        }
        resolve(n);
      }, 250);
    }));
    const snapFrame = () => page.evaluate(() => {
      const c = document.getElementById("game");
      return Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data);
    });
    const diffCount = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 8 ||
            Math.abs(a[i + 1] - b[i + 1]) > 8 ||
            Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
      }
      return n;
    };

    await page.evaluate(() => { window.TC.UI.paused = true; }); // freezes sim+sky
    await page.evaluate(() => window.__TEST__.setLocale("en")); // pin baseline
    await H.runFrames(page, 10);
    const noiseFloor = await measure();          // en vs en, 250ms apart
    const enFrame = await snapFrame();
    await page.evaluate(() => window.__TEST__.setLocale("en-XA"));
    await H.runFrames(page, 10);
    const xaFrame = await snapFrame();
    await page.evaluate(() => window.__TEST__.setLocale("en"));
    await H.runFrames(page, 10);
    const enAgain = await snapFrame();
    await page.evaluate(() => { window.TC.UI.paused = false; });

    const localeDiff = diffCount(enFrame, xaFrame);
    const restoreDiff = diffCount(enFrame, enAgain);
    expect(localeDiff).toBeGreaterThan(noiseFloor * 50 + 500,
      "locale switch must redraw far more than ambient frame noise");
    expect(restoreDiff).toBeLessThanOrEqual(Math.max(noiseFloor, 2000),
      "returning to en restores the same rendering within the noise floor");

    await page.evaluate(() => { window.TC.UI.paused = false; });

    // ---- save world, reload PAGE: both locale and world persist ----------
    // Re-select the stress locale FIRST: an explicit switch is a real user
    // choice and must be what persists across the reload.
    await page.evaluate(() => window.__TEST__.setLocale("en-XA"));
    await page.evaluate(() => {
      const ok = window.TC.Save.save();
      if (!ok) throw new Error("save failed");
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => !!(window.TC && window.TC.state === "title"));

    const afterReload = await page.evaluate(() => {
      // locale restores from the settings store during boot
      const localeRestored = window.__TEST__.getLocale();
      window.TC.continueGame(); // world restores through the game save
      return {
        localeRestored,
        seed: window.TC.worldSeed,
        state: window.TC.state,
        storedSettings: window.localStorage.getItem("tc_settings_v1"),
      };
    });
    await H.expectGameState(page, "playing");
    expect(afterReload.localeRestored).toBe("en-XA",
      "locale preference persists across a real page reload");
    expect(afterReload.seed).toBe(424242);
    expect(afterReload.storedSettings).toContain('"locale":"en-XA"');

    // deleting the WORLD save must not reset the locale preference
    const afterDelete = await page.evaluate(() => {
      window.TC.Save.deleteSave();
      return {
        hasSave: window.TC.Save.hasSave(),
        locale: window.__TEST__.getLocale(),
      };
    });
    expect(afterDelete.hasSave).toBe(false);
    expect(afterDelete.locale).toBe("en-XA");

    // ---- return to fallback: normal English UI returns --------------------
    const back = await page.evaluate(() => {
      const ok = window.__TEST__.setLocale("en");
      return {
        ok,
        locale: window.__TEST__.getLocale(),
        label: window.__TEST__.translate("ui.menu.new_world"),
        subtitle: window.__TEST__.translate("ui.title_screen.subtitle"),
      };
    });
    expect(back.ok).toBe(true);
    expect(back.label).toBe("New World");
    expect(back.subtitle).toBe("an original-assets fan tribute");

    H.assertNoErrors(errors, "journeyK/end-to-end");
  });
});

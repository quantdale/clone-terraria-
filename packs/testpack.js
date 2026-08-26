/* packs/testpack.js — W25 FIXTURE PACK (production pack path proof).
//
// Ships as a declarative manifest provided through the SAME TC.Packs.provide
// seam any third-party data pack uses — no privileged registration, no code
// hooks, no runtime callbacks. Providing ≠ activating: it joins the game only
// when the active pack set (TC.Settings 'activePacks', title-screen Packs
// panel) includes 'testpack'. Zero-pack boots never read this data.
//
// Content proves the whole pipeline end-to-end:
//   tile  testpack:tempest_brick     inert painter + item drop reference
//   items  testpack:tempest_shard    material crafted from vanilla stone
//          testpack:tempest_bar      furnace-smelted from shard + iron
//          testpack:tempest_blade    anvil melee weapon (vanilla-tier stats)
//          testpack:tempest_charm     summon -> testpack enemy (regular AI only)
//   enemy testpack:tempest_wisp      built-in 'teleporter' AI reference,
//                                 declarative drops back into the chain
//   recipes close the loop with vanilla materials and stations
//
// Display strings are NOT inline here — they ride the resource side of the
// same manifest (resources.locale) through TC.Localization.extend, keyed by
// registry-derived paths (item.testpack.tempest_shard.name etc.). */

(() => {
  window.TC = window.TC || {};
  const TC = window.TC;
  if (!TC.Packs) return; // loader absent (should not happen in production boot)

  TC.Packs.provide({
    manifest: 1,
    id: "testpack",
    name: "Storm Frontier",
    version: "1.0.0",
    type: "data",
    description: "Fixture data pack: a small tempest-themed crafting chain, one placeable block and one regular enemy.",
    requires: { game: ">=0.9" },
    content: {
      tiles: [
        {
          key: "tempest_brick",
          name: "Tempest Brick",
          solid: true,
          opaque: true,
          hardness: 0.85,
          tool: "pick",
          minPower: 35,
          drop: "tempest_brick", // bare key resolves to this pack's own item
          light: 0.08,
          pattern: "speckle",
          colors: ["#4a5568", "#7b6f9e"],
        },
      ],
      items: [
        { key: "tempest_shard", name: "Tempest Shard", kind: "material", value: 12 },
        { key: "tempest_bar", name: "Tempest Bar", kind: "material", value: 45 },
        {
          key: "tempest_blade",
          name: "Tempest Blade",
          kind: "weapon",
          damage: 16,
          knockback: 5.2,
          useTime: 0.29,
          value: 300,
        },
        { key: "tempest_brick", name: "Tempest Brick", kind: "block", tile: "testpack:tempest_brick" },
        {
          key: "tempest_charm",
          name: "Tempest Charm",
          kind: "summon",
          boss: "testpack:tempest_wisp",
          summon: { time: "any", biome: null, requires: null, placement: null },
        },
      ],
      enemies: [
        {
          key: "tempest_wisp",
          boss: true, // mini-boss: routes through the built-in encounter machinery
          name: "Tempest Wisp",
          hp: 70,
          dmg: 20,
          kbResist: 0.3,
          ai: "teleporter",
          w: 24,
          h: 24,
          color: "#8fb7e8",
          defense: 2,
          drops: [
            { id: "testpack:tempest_shard", min: 1, max: 2, chance: 1 },
            { id: "silver_ore", min: 1, max: 3, chance: 0.5 },
          ],
          coins: [30, 60],
        },
      ],
      recipes: [
        { rid: "tempest_shard", out: "testpack:tempest_shard", n: 1, station: null, cost: { stone: 6 } },
        { rid: "tempest_brick", out: "testpack:tempest_brick", n: 4, station: null, cost: { stone: 2, tempest_shard: 1 } },
        { rid: "tempest_bar", out: "testpack:tempest_bar", n: 1, station: "furnace", cost: { tempest_shard: 2, iron_bar: 1 } },
        { rid: "tempest_blade", out: "testpack:tempest_blade", n: 1, station: "anvil", cost: { tempest_bar: 6 } },
        { rid: "tempest_charm", out: "testpack:tempest_charm", n: 1, station: "workbench", cost: { tempest_bar: 2, crystal: 1 } },
      ],
    },
    resources: {
      locale: {
        en: {
          tile: { testpack: { tempest_brick: { name: "Tempest Brick" } } },
          item: {
            testpack: {
              tempest_shard: { name: "Tempest Shard", description: "A crackling fragment of captured storm." },
              tempest_bar: { name: "Tempest Bar", description: "Storm-forged alloy, humming faintly." },
              tempest_blade: { name: "Tempest Blade", description: "A swift blade wreathed in static." },
              tempest_brick: { name: "Tempest Brick", description: "Placeable brick charged with residual energy." },
              tempest_charm: { name: "Tempest Charm", description: "Calls a Tempest Wisp to the holder." },
            },
          },
          enemy: { testpack: { tempest_wisp: { name: "Tempest Wisp" } } },
        },
      },
    },
  });
})();

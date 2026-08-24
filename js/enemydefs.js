/* enemydefs.js — enemy content extensions, extracted verbatim from
   enemies.js in the W13 decomposition. Pure data + load-time table merges:
   no AI, no spawning, no rendering lives here.

   Owns (would live in lead-owned constants.js otherwise):
     - ENEMY_DEFS additions: biome regulars, Blood Moon crawlers, boss
       minions and the six bosses (king_slime, skeletron(+hand), wof,
       storm_jelly, moss_mother)
     - ITEM_DEFS materials + summon items (slime_crown, skull_sigil,
       flesh_sigil, blood_sigil)
     - RECIPES entries crafting those summons
     - the zombie def coins retrofit (field-level merge, not a replace)

   Load order: after constants.js (needs TC.ENEMY_DEFS/ITEM_DEFS/RECIPES),
   before any consumer reads these defs at runtime. Stable ids never change:
   saves reference enemies/items through TC.Registry legacy aliases captured
   from these very table keys.
*/

(() => {
  window.TC = window.TC || {};
  const TC = window.TC;
  // ======================================================================
  // Content extensions (would live in lead-owned constants.js / index.html;
  // documented here because those files are read-only for this module).
  // ======================================================================

  // -- enemy definitions added on top of TC.ENEMY_DEFS --
  // Shared AI roster: 'slime'/'zombie'/'eye'/'bat'/'harpy', 'walker'
  // (daylight-immune ground chaser tuned by def.speed / def.jumpVel, with
  // def.lunge and def.charge variants), 'stationary' (rooted hazard that
  // bites in reach) and 'teleporter' (floater that blinks toward the player).
  // Boss AIs: 'king_slime', 'skeletron' (+ 'skele_hand' parts), 'wof',
  // 'storm_jelly', 'moss_mother'. def.part marks boss *parts* (Skeletron
  // hands): they persist like bosses but do not count toward MAX_BOSSES and
  // never take the UI boss bar. def.coins [minC,maxC] scatters canonical
  // currency through TC.Economy.dropCoins on death.
  if (TC.ENEMY_DEFS) {
    Object.assign(TC.ENEMY_DEFS, {
      // ---- regular enemies ----
      harpy: {
        name: "Harpy",
        hp: 60,
        dmg: 16,
        kbResist: 0.4,
        ai: "harpy",
        w: 30,
        h: 24,
        color: "#b8a06a",
        drops: [{ id: "feather", min: 1, max: 2, chance: 0.9 }],
        coins: [30, 60],
      },
      vulture: {
        name: "Vulture",
        hp: 40,
        dmg: 13,
        kbResist: 0.3,
        ai: "bat",
        w: 24,
        h: 18,
        color: "#9a7a52",
        drops: [{ id: "feather", min: 1, max: 1, chance: 0.6 }],
        coins: [15, 35],
      },
      eater_of_souls: {
        name: "Eater of Souls",
        hp: 70,
        dmg: 20,
        kbResist: 0.45,
        ai: "eye",
        w: 30,
        h: 26,
        color: "#7a4a9a",
        drops: [{ id: "shadow_shard", min: 1, max: 1, chance: 0.5 }],
        coins: [45, 80],
      },
      ice_slime: {
        name: "Ice Slime",
        hp: 30,
        dmg: 14,
        kbResist: 0.3,
        ai: "slime",
        w: 32,
        h: 20,
        color: "#9adcf0",
        drops: [{ id: "gel", min: 1, max: 2, chance: 1 }],
        coins: [6, 14],
      },
      sand_slime: {
        name: "Sand Slime",
        hp: 42,
        dmg: 15,
        kbResist: 0.3,
        ai: "slime",
        w: 34,
        h: 22,
        color: "#d8c86e",
        drops: [{ id: "gel", min: 1, max: 3, chance: 1 }],
        coins: [10, 22],
      },
      jungle_bat: {
        name: "Jungle Bat",
        hp: 26,
        dmg: 14,
        kbResist: 0.2,
        ai: "bat",
        w: 20,
        h: 16,
        color: "#4a8a3a",
        drops: [],
        coins: [10, 20],
      },
      skeleton: {
        name: "Skeleton",
        hp: 60,
        dmg: 18,
        kbResist: 0.55,
        ai: "walker",
        w: 20,
        h: 40,
        color: "#cfc8b8",
        speed: 55,
        jumpVel: 330,
        look: "skeleton",
        drops: [{ id: "bone", min: 1, max: 2, chance: 1 }],
        coins: [20, 45],
      },
      granite_golem: {
        name: "Granite Golem",
        hp: 120,
        dmg: 26,
        kbResist: 0.85,
        ai: "walker",
        w: 28,
        h: 38,
        color: "#7a8a96",
        speed: 34,
        jumpVel: 300,
        look: "golem",
        defense: 4,
        drops: [{ id: "granite_shard", min: 1, max: 2, chance: 0.8 }],
        coins: [60, 110],
      },
      blood_crawler: {
        name: "Blood Crawler",
        hp: 50,
        dmg: 20,
        kbResist: 0.4,
        ai: "walker",
        w: 28,
        h: 18,
        color: "#a02a2a",
        speed: 95,
        jumpVel: 380,
        look: "crawler",
        bloodMoonOnly: true,
        drops: [{ id: "blood_shard", min: 1, max: 2, chance: 0.7 }],
        coins: [25, 55],
      },
      crimson_slime: {
        name: "Crimson Slime",
        hp: 58,
        dmg: 19,
        kbResist: 0.4,
        ai: "slime",
        w: 36,
        h: 24,
        color: "#c42a3a",
        bloodMoonOnly: true,
        drops: [
          { id: "gel", min: 2, max: 4, chance: 1 },
          { id: "blood_shard", min: 1, max: 1, chance: 0.5 },
        ],
        coins: [18, 40],
      },
      hungry: {
        name: "Hungry",
        hp: 36,
        dmg: 22,
        kbResist: 0.2,
        ai: "eye",
        w: 22,
        h: 22,
        color: "#b04a4a",
        drops: [],
      }, // Wall of Flesh servant

      // ---- wave 6-7 regulars ----
      dune_stalker: {
        name: "Dune Stalker",
        hp: 58,
        dmg: 17,
        kbResist: 0.45,
        ai: "walker",
        w: 26,
        h: 34,
        color: "#c9a86a",
        speed: 72,
        jumpVel: 330,
        look: "stalker",
        drops: [],
        coins: [15, 35],
      },
      frost_wolf: {
        name: "Frost Wolf",
        hp: 64,
        dmg: 19,
        kbResist: 0.4,
        ai: "walker",
        w: 34,
        h: 24,
        color: "#a8c8e0",
        speed: 104,
        jumpVel: 430,
        look: "wolf",
        lunge: true, // bursts of extra vx when the player is near
        lungeBoost: 95,
        drops: [],
        coins: [20, 40],
      },
      snapvine: {
        name: "Snapvine",
        hp: 74,
        dmg: 22,
        kbResist: 0.85,
        ai: "stationary", // rooted hazard; bites players in short reach
        w: 26,
        h: 36,
        color: "#4a9a3e",
        drops: [],
        coins: [12, 26],
      },
      rock_charger: {
        name: "Rock Charger",
        hp: 130,
        dmg: 24,
        kbResist: 0.8,
        ai: "walker",
        w: 30,
        h: 30,
        color: "#8a7f72",
        speed: 42,
        jumpVel: 300,
        look: "charger",
        charge: true, // straight-line rush when roughly level with the player
        chargeSpeed: 235,
        defense: 3,
        drops: [],
        coins: [35, 65],
      },
      void_wisp: {
        name: "Void Wisp",
        hp: 66,
        dmg: 21,
        kbResist: 0.35,
        ai: "teleporter", // drifts like an eye but blinks toward the player
        w: 24,
        h: 24,
        color: "#6a4ac0",
        drops: [{ id: "shadow_shard", min: 1, max: 1, chance: 0.5 }],
        coins: [28, 55],
      },
      gloom_bat: {
        name: "Gloom Bat",
        hp: 44,
        dmg: 20,
        kbResist: 0.2,
        ai: "bat",
        w: 22,
        h: 17,
        color: "#37304a",
        drops: [],
        coins: [12, 24],
      },

      // ---- boss minion sheds (normal enemies, linked via .master) ----
      jelly_minion: {
        name: "Storm Jellyfish",
        hp: 42,
        dmg: 15,
        kbResist: 0.3,
        ai: "slime",
        w: 22,
        h: 15,
        color: "#9b8cf0",
        drops: [{ id: "gel", min: 1, max: 2, chance: 0.8 }],
        coins: [8, 18],
      },
      sporeling: {
        name: "Sporeling",
        hp: 48,
        dmg: 18,
        kbResist: 0.35,
        ai: "walker",
        w: 20,
        h: 22,
        color: "#79b04a",
        speed: 82,
        jumpVel: 360,
        look: "sporeling",
        drops: [{ id: "mushstem", min: 1, max: 1, chance: 0.35 }],
        coins: [10, 20],
      },

      // ---- bosses (all kbResist 1; respect MAX_BOSSES via spawnBoss) ----
      king_slime: {
        name: "King Slime",
        hp: 900,
        dmg: 26,
        kbResist: 1,
        ai: "king_slime",
        w: 80,
        h: 56,
        color: "#4a6fd6",
        boss: true,
        defense: 6,
        drops: [
          { id: "gel", min: 30, max: 50, chance: 1 },
          { id: "gold_bar", min: 4, max: 7, chance: 1 },
          { id: "slime_crown", min: 1, max: 1, chance: 0.5 },
        ],
        coins: [300, 600],
      },
      skeletron: {
        name: "Skeletron",
        hp: 1600,
        dmg: 30,
        kbResist: 1,
        ai: "skeletron",
        w: 64,
        h: 64,
        color: "#ddd6c2",
        boss: true,
        defense: 10,
        drops: [
          { id: "bone", min: 20, max: 35, chance: 1 },
          { id: "gold_bar", min: 6, max: 10, chance: 1 },
        ],
        coins: [500, 900],
      },
      skele_hand: {
        name: "Skeletron Hand",
        hp: 280,
        dmg: 24,
        kbResist: 1,
        ai: "skele_hand",
        w: 26,
        h: 38,
        color: "#cfc8b8",
        part: true,
        drops: [{ id: "bone", min: 3, max: 6, chance: 1 }],
      },
      wof: {
        name: "Wall of Flesh",
        hp: 2400,
        dmg: 34,
        kbResist: 1,
        ai: "wof",
        w: 46,
        h: 170,
        color: "#c43a3a",
        boss: true,
        defense: 12,
        drops: [
          { id: "blood_shard", min: 15, max: 25, chance: 1 },
          { id: "gold_bar", min: 8, max: 12, chance: 1 },
        ],
        coins: [1200, 2400],
      },

      // ---- wave 6-7 bosses ----
      storm_jelly: {
        name: "Storm Jelly",
        hp: 1800,
        dmg: 26,
        kbResist: 1,
        ai: "storm_jelly",
        w: 80,
        h: 64,
        color: "#8f7ff0",
        boss: true,
        defense: 10,
        drops: [
          { id: "storm_core", min: 6, max: 10, chance: 1 },
          { id: "gel", min: 25, max: 40, chance: 1 },
          { id: "gold_bar", min: 4, max: 7, chance: 1 },
        ],
        coins: [800, 1600],
      },
      moss_mother: {
        name: "Moss Mother",
        hp: 2600,
        dmg: 30,
        kbResist: 1,
        ai: "moss_mother",
        w: 96,
        h: 72,
        color: "#5d7a3a",
        boss: true,
        defense: 14,
        drops: [
          { id: "moss_core", min: 8, max: 12, chance: 1 },
          { id: "mushstem", min: 12, max: 20, chance: 1 },
          { id: "gold_bar", min: 5, max: 9, chance: 1 },
        ],
        coins: [1000, 2000],
      },
    });
  }

  // Coins economy retrofit on a lead-owned def (zombie): field-level MERGE.
  // A 'zombie: {...}' entry inside the assign above would replace the whole
  // lead def instead of topping it up.
  if (TC.ENEMY_DEFS && TC.ENEMY_DEFS.zombie) {
    Object.assign(TC.ENEMY_DEFS.zombie, { coins: [15, 35] });
  }

  // -- item definitions added on top of TC.ITEM_DEFS (materials + summons) --
  if (TC.ITEM_DEFS) {
    Object.assign(TC.ITEM_DEFS, {
      bone: I_MAT("Bone", {}),
      feather: I_MAT("Feather", {}),
      blood_shard: I_MAT("Blood Shard", {}),
      shadow_shard: I_MAT("Shadow Shard", {}),
      granite_shard: I_MAT("Granite Shard", {}),
      slime_crown: {
        name: "Slime Crown",
        kind: "summon",
        maxStack: 20,
        boss: "king_slime",
      },
      skull_sigil: {
        name: "Skull Sigil",
        kind: "summon",
        maxStack: 20,
        boss: "skeletron",
      },
      flesh_sigil: {
        name: "Flesh Sigil",
        kind: "summon",
        maxStack: 20,
        boss: "wof",
      },
      blood_sigil: {
        name: "Blood Sigil",
        kind: "summon",
        maxStack: 20,
        boss: "__blood_moon__",
      },
      // NOTE: storm_bell / moss_heart summons are lead-owned in constants.js
      // (already wired to boss ids 'storm_jelly' / 'moss_mother' with their
      // own recipes) — do NOT redefine them here; a redefinition remaps the
      // legacy registry key and fails TC.Registry.validate().
    });
  }

  function I_MAT(name, o) {
    return Object.assign({ name, kind: "material", maxStack: 999 }, o);
  }

  // -- crafting recipes for the summon items (appended to lead-owned table) --
  if (TC.RECIPES && typeof TC.RECIPES.push === "function") {
    TC.RECIPES.push(
      {
        out: "slime_crown",
        n: 1,
        station: "anvil",
        cost: { gel: 20, gold_bar: 3 },
      },
      {
        out: "skull_sigil",
        n: 1,
        station: "anvil",
        cost: { bone: 15, gold_bar: 3 },
      },
      {
        out: "flesh_sigil",
        n: 1,
        station: "anvil",
        cost: { blood_shard: 12, shadow_shard: 6, iron_bar: 5 },
      },
      {
        out: "blood_sigil",
        n: 1,
        station: "workbench",
        cost: { blood_shard: 5 },
      },
    );
  }
})();

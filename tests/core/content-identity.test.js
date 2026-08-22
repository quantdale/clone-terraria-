/* tests/core/content-identity.test.js — Phase 8 regression contract for
   promoted worldgen extension content + registry identity guarantees.

   History: worldgen.js used to append CACTUS..SANDSTONE_BRICK tiles,
   SAND/EBON/DUNGEON/HELL walls and their items into shared tables at script-
   load time. They were promoted VERBATIM into constants.js (same keys, same
   numeric ids, same order). These tests freeze that identity: numeric ids,
   stable registry ids, legacy aliases and cross-references must not drift,
   because old saves store raw numeric tile/wall indexes. */

const test = require("node:test");
const assert = require("node:assert");
const { loadGame } = require("../helpers/load-game.js");

// The promoted extension block, exactly as frozen in constants.js.
const EXT_TILES = [
  ["CACTUS", 27],
  ["EBONSTONE", 28],
  ["CRIMSTONE", 29],
  ["EBONGRASS", 30],
  ["SHADEWOOD", 31],
  ["DUNGEON_BRICK", 32],
  ["HELL_BRICK", 33],
  ["SANDSTONE_BRICK", 34],
];
const EXT_WALLS = [
  ["SAND", 3],
  ["EBON", 4],
  ["DUNGEON", 5],
  ["HELL", 6],
];
const EXT_ITEMS = [
  ["cactus", "CACTUS"],
  ["ebonstone", "EBONSTONE"],
  ["crimstone", "CRIMSTONE"],
  ["shadewood", "SHADEWOOD"],
  ["dungeon_brick", "DUNGEON_BRICK"],
  ["hell_brick", "HELL_BRICK"],
  ["sandstone_brick", "SANDSTONE_BRICK"],
];

test("content: promoted tile/wall ids keep their frozen legacy numbers", () => {
  // Subset boot = constants+registry only: proves the BASE table state before
  // any later module (tiles/loot/wiring) appends more entries.
  const { TC } = loadGame({ scripts: ["constants", "registry"] });
  for (const [key, id] of EXT_TILES) {
    assert.strictEqual(
      TC.TILE[key],
      id,
      `TC.TILE.${key} must stay ${id} — renumbering breaks saved diffs`,
    );
    assert.ok(TC.TILE_DEFS[id], `TILE_DEFS[${id}] missing`);
    assert.strictEqual(TC.TILE_DEFS[id].name.length > 0, true);
  }
  // Base tables end exactly after the promoted block (wiring/tiles/loot
  // appends land later at 35+; see full-boot test below).
  assert.strictEqual(TC.TILE_DEFS.length, 35, "base TILE_DEFS length changed");
  for (const [key, id] of EXT_WALLS) {
    assert.strictEqual(TC.WALL[key], id, `TC.WALL.${key} must stay ${id}`);
  }
  assert.strictEqual(TC.WALL_DEFS.length, 7, "WALL_DEFS length changed");
});

test("content: promoted item defs exist and back-reference their tiles", () => {
  const { TC } = loadGame({ scripts: ["constants", "registry"] });
  for (const [itemId, tileKey] of EXT_ITEMS) {
    const def = TC.ITEM_DEFS[itemId];
    assert.ok(def, `ITEM_DEFS.${itemId} missing`);
    assert.strictEqual(def.kind, "block");
    assert.strictEqual(
      def.tile,
      TC.TILE[tileKey],
      `ITEM_DEFS.${itemId}.tile must point at TC.TILE.${tileKey}`,
    );
  }
});

test("content: every promoted tile drop resolves to a real item id", () => {
  const { TC } = loadGame({ scripts: ["constants", "registry"] });
  for (const [key] of EXT_TILES) {
    const def = TC.TILE_DEFS[TC.TILE[key]];
    if (!def.drop) continue;
    assert.ok(
      TC.ITEM_DEFS[def.drop],
      `tile ${key} drops "${def.drop}" which has no ITEM_DEFS entry`,
    );
  }
});

test("registry: stable ids, numeric aliases and string keys resolve for promoted content", () => {
  const { TC } = loadGame({ scripts: ["constants", "registry"] });
  const R = TC.Registry;
  for (const [key, id] of EXT_TILES) {
    const stable = R.legacyToStable("tile", id);
    assert.match(stable, /^core:/, `tile ${id} should mirror under core:*`);
    assert.strictEqual(
      R.has("tile", id),
      true,
      `numeric alias for tile ${id} missing`,
    );
    // Tiles are mirrored from an ARRAY: their contract is a numeric alias
    // plus a name-derived stable id ('core:' + snake_case(def.name)) — there
    // is deliberately no TC.TILE-key string alias.
    assert.strictEqual(
      R.stableToIndex("tile", stable),
      id,
      "stable id must round-trip back to its legacy index",
    );
    assert.ok(R.get("tile", stable), "stable lookup failed");
  }
  for (const [itemId] of EXT_ITEMS) {
    assert.strictEqual(
      R.has("item", itemId),
      true,
      `item key "${itemId}" must resolve through a registered alias`,
    );
  }
});

test("registry: syncFromTables is idempotent (second call adds nothing, no errors)", () => {
  const { TC } = loadGame();
  const first = TC.Registry.syncFromTables();
  assert.strictEqual(first.errors.length, 0, JSON.stringify(first.errors));
  const second = TC.Registry.syncFromTables();
  // compare field-wise: `second` crosses the vm realm, so its arrays have a
  // foreign Array prototype that deepStrictEqual would reject even when empty
  assert.strictEqual(
    second.added,
    0,
    "re-sync must add nothing: " + JSON.stringify(second),
  );
  assert.strictEqual(
    second.errors.length,
    0,
    "re-sync must record no errors: " + JSON.stringify(second.errors),
  );
});

test("registry: fingerprint is identical across independent boots", () => {
  const a = loadGame().TC.Registry.fingerprint();
  const b = loadGame().TC.Registry.fingerprint();
  assert.strictEqual(
    a,
    b,
    "two identical boots produced different fingerprints",
  );
});

test("registry: fingerprint unaffected by syncFromTables timing", () => {
  const early = loadGame({ scripts: ["constants", "registry"] });
  const fpEarlyBefore = early.TC.Registry.fingerprint();
  early.TC.Registry.syncFromTables();
  assert.strictEqual(
    early.TC.Registry.fingerprint(),
    fpEarlyBefore,
    "re-syncing unchanged tables must not move the fingerprint",
  );

  const late = loadGame(); // full boot: everything registered by load
  const fpLate = late.TC.Registry.fingerprint();
  late.TC.Registry.syncFromTables();
  assert.strictEqual(
    late.TC.Registry.fingerprint(),
    fpLate,
    "post-boot re-sync must not move the fingerprint",
  );
});

test("registry: validate() passes AFTER full script load incl. wiring aliases", () => {
  const { TC } = loadGame({ frames: 2 });
  // wiring.js loads last, AFTER main's boot-time syncFromTables — its numeric
  // tile aliases (40..47) must have been registered by wiring itself.
  assert.doesNotThrow(
    () => TC.Registry.validate(),
    "post-boot Registry.validate() must be clean",
  );
  for (let id = 40; id <= 47; id++) {
    assert.strictEqual(
      TC.Registry.has("tile", id),
      true,
      `wiring tile alias #${id} unresolved`,
    );
  }
  assert.strictEqual(
    TC.Registry.has("item", "wire"),
    true,
    "wiring item string-key alias missing",
  );
  // Full-boot table length is base(35) + tiles.js platform set(3)
  // + loot.js pot/crystal(2) + wiring(8) = 48. If this changes, content was
  // added or reordered somewhere — update deliberately.
  assert.strictEqual(
    TC.TILE_DEFS.length,
    48,
    "full-boot TILE_DEFS length drifted",
  );
});

test("savecore: GENERATION_VERSION stays 2 and rides the save envelope", () => {
  const g = loadGame();
  const TC = g.TC;
  assert.strictEqual(TC.WorldGen.GENERATION_VERSION, 2);
  assert.strictEqual(
    TC.SaveCore.GENERATION_VERSION,
    2,
    "SaveCore must source the value from WorldGen, not a literal",
  );
  TC.newGame(424242);
  assert.strictEqual(TC.Save.save(), true, "save() failed");
  const raw = g.storage.getItem("tc_save_v2");
  assert.ok(raw, "tc_save_v2 envelope missing from storage");
  const env = JSON.parse(raw);
  assert.strictEqual(
    env.generationVersion,
    2,
    "envelope must embed the live WorldGen.GENERATION_VERSION",
  );
});

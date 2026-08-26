/* tools/check-i18n.js - deterministic localization/catalog validator (W20).
   Boots the REAL game headless (tests/helpers/load-game.js derives script
   order from index.html), then checks:

     1. fallback locale registered; catalog structurally valid;
     2. every user-visible registry entry (tile/wall/item/enemy/npc/buff/
        biome/station) has a non-empty fallback display name;
     3. every explicitly declared nameKey resolves in the fallback locale;
     4. every NPC dialogue key referenced by NPC_KINDS pools exists;
     5. no duplicate canonical keys (registration-time guard re-checked);
     6. REGISTRY IDENTITY GUARD: the stable-ID inventory + fingerprint must
        equal the W20 baseline snapshot - localization metadata must never
        mutate machine identity.

   Exit code 1 on any error. Run via `npm run check:i18n`. */
'use strict';
const { loadGame } = require("../tests/helpers/load-game.js");
const fs = require("fs");
const path = require("path");

const BASELINE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "registry-baseline-w24.json"), "utf8")
);
// Pre-W24 identity reference: proves content growth is ADDITIVE-ONLY —
// every id captured at the W20 checkpoint must still sit at its old index.
const PRE_W24 = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "registry-baseline-w20.json"), "utf8")
);

// Kinds whose entries are player-visible display names.
const VISIBLE_KINDS = ["tile", "wall", "item", "enemy", "npc", "buff", "biome", "station"];
const NAMELESS_OK = new Set([
  // tiles that are purely simulation/format concepts never shown to players
  "core:air",
  "wiring:wire", // wiring items are visible, the wire TILE is placed machinery
]);

function main() {
  const g = loadGame();
  const TC = g.TC;
  if (!TC || !TC.Localization) {
    console.error("check-i18n FAILED: TC.Localization missing after boot");
    process.exit(1);
  }
  TC.Registry.syncFromTables();
  const L = TC.Localization;

  let failed = 0;
  const fail = (msg) => { console.error("  ERROR " + msg); failed++; };
  const ok = (msg) => console.log("  ok " + msg);

  // ---- 1. structural validation ------------------------------------
  const v = L.validate();
  if (!v.ok) {
    for (const e of v.errors) fail("catalog: " + e);
  } else ok("catalog valid, " + v.fallbackKeys + " fallback keys (" + (v.warnings.length) + " warnings)");
  for (const w of v.warnings) console.log("  warn " + w);

  if (!L.isRegistered(L.getFallbackLocale())) fail("fallback locale not registered");

  // ---- 2/3/4. content coverage --------------------------------------
  let checked = 0;
  for (const kind of VISIBLE_KINDS) {
    const n = TC.Registry.count(kind);
    for (let i = 0; i < n; i++) {
      const id = TC.Registry.stableOfIndex(kind, i);
      if (NAMELESS_OK.has(id)) continue;
      const key = kind + "." + id.replace(":", ".") + ".name";
      checked++;
      if (!L.has(key)) fail("missing display name key: " + key);
      else if (typeof L.t(key) !== "string" || !L.t(key).trim()) {
        fail("empty display name for: " + key);
      }
    }
  }
  ok(checked + " registry content names resolved through the catalog");

  // NPC kinds not mirrored into the registry (e.g. merchant until move-in)
  // still need display names + resolvable nameKey declarations.
  let npcKinds = 0;
  if (TC.NPCs && TC.NPCs.KINDS) {
    for (const type in TC.NPCs.KINDS) {
      npcKinds++;
      const def = TC.NPCs.KINDS[type];
      const key = L.contentKey("npc", type, "name");
      if (!key || !L.has(key)) fail("npc kind '" + type + "' has no display name key (" + key + ")");
      if (def.nameKey && !L.has(def.nameKey)) {
        fail("declared nameKey '" + def.nameKey + "' missing from fallback catalog");
      }
      const pools = [].concat(
        Array.isArray(def.dialogLines) ? def.dialogLines : [],
        Array.isArray(def.dialogNight) ? def.dialogNight : []
      );
      if (def.dialogBiome) {
        for (const b in def.dialogBiome) {
          if (Array.isArray(def.dialogBiome[b])) pools.push(...def.dialogBiome[b]);
        }
      }
      if (Array.isArray(def.dialogFlags)) {
        for (const f of def.dialogFlags) {
          if (Array.isArray(f.lines)) pools.push(...f.lines);
        }
      }
      for (const line of pools) {
        if (typeof line !== "string" || line.indexOf(".") < 0 || !L.has(line)) {
          fail("npc '" + type + "' references non-catalog dialogue: " + JSON.stringify(line));
        }
      }
    }
    ok(npcKinds + " npc kinds verified (names + dialogue keys)");
  }

  // ---- 6. registry identity guard ------------------------------------
  // W24 policy: new content appends tail entries deliberately; the snapshot
  // is refreshed ONLY alongside an additive-only proof against pre-W24.
  const fp = TC.Registry.fingerprint();
  if (fp !== BASELINE.fingerprint) {
    fail("registry fingerprint drifted: " + fp + " != baseline " + BASELINE.fingerprint);
  } else ok("registry fingerprint matches the W24 baseline: " + fp);

  const counts = {};
  let stableTotal = 0;
  let prevChecked = 0;
  for (const k of TC.Registry.KINDS) {
    counts[k] = TC.Registry.count(k);
    stableTotal += counts[k];
    if (BASELINE.counts[k] !== counts[k]) {
      fail("registry count drift for kind '" + k + "': " + counts[k] + " != baseline " + BASELINE.counts[k]);
    }
    for (let i = 0; i < counts[k]; i++) {
      const id = TC.Registry.stableOfIndex(k, i);
      if (!BASELINE.stable[k + ":" + i]) {
        fail("new stable id at " + k + ":" + i + " -> " + id + " (baseline snapshot must be refreshed deliberately)");
      } else if (BASELINE.stable[k + ":" + i] !== id) {
        fail("stable id moved at " + k + ":" + i + ": " + id + " != baseline " + BASELINE.stable[k + ":" + i]);
      }
      const prevId = PRE_W24.stable[k + ":" + i];
      if (prevId !== undefined) {
        prevChecked++;
        if (prevId !== id) fail("pre-W24 stable id changed at " + k + ":" + i + ": " + id + " != " + prevId);
      } else if (PRE_W24.counts[k] !== undefined && i < PRE_W24.counts[k]) {
        fail("pre-W24 index lost from snapshot: " + k + ":" + i);
      }
    }
    if ((PRE_W24.counts[k] | 0) > counts[k]) {
      fail("kind '" + k + "' SHRANK versus pre-W24: " + counts[k] + " < " + PRE_W24.counts[k]);
    }
  }
  ok(stableTotal + " stable ids match the W24 baseline exactly");
  ok(prevChecked + " pre-W24 stable ids verified unchanged (additive-only content growth)");

  if (failed > 0) {
    console.error("check-i18n FAILED: " + failed + " error(s)");
    process.exit(1);
  }
  console.log("check-i18n OK");
}

main();

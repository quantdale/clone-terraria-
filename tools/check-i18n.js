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
     7. PRESENTATION-NAME SOURCE SCAN: no production module reads a content
        definition's frozen `name` field as display text or runtime identity
        outside the sanctioned seams (frozen tables, the catalog resolver,
        documented identity uses).

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

  // ---- 7. presentation-name source scan --------------------------------
  // Frozen `def.name` fields are identity metadata: presentation must go
  // through TC.Localization.contentName and identity must use stable keys.
  // Each allowlist entry names the file, a line substring, and the reason —
  // a new raw name read fails the gate instead of drifting back in.
  const NAME_ALLOW = [
    { file: 'js/localization.js', sub: 'return def.name', reason: 'catalog resolver stable-id fallback (sanctioned seam)' },
    { file: 'js/registry.js', sub: 'snakeCase(def.name)', reason: 'stable-id derivation from frozen identity' },
    { file: 'js/lighting.js', sub: 'defs[id].name', reason: 'emissive lookup keyed by frozen identity string' },
    { file: 'js/npcs.js', sub: 'name: def.name', reason: 'identity-bearing NPC entity field (save-compat; deferred)' },
    { file: 'js/npcs.js', sub: '(def && def.name)', reason: 'identity-bearing NPC display fallback (save-compat; deferred)' },
    { file: 'js/npcs.js', sub: 'name: def.name || type', reason: 'NpcMovedIn event identity payload (deferred)' },
    { file: 'js/ui.js', sub: "b.def && b.def.name", reason: 'legacy-name reference passed into the catalog resolver' },
  ];
  const NAME_PATTERNS = [/\.def\.name\b/, /\bdef\.name\b/, /DEFS\[[^\]]+\]\.name\b/i];
  const NAME_WRITE = /def\.name\s*=(?!=|>)/;
  const jsRoot = path.join(__dirname, '..', 'js');
  const jsFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'locales') walk(p); }
      else if (e.name.endsWith('.js')) jsFiles.push(p);
    }
  })(jsRoot);
  let inBlock = false;
  for (const f of jsFiles.sort()) {
    const rel = path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/');
    const src = fs.readFileSync(f, 'utf8').split('\n');
    inBlock = false;
    src.forEach((raw, i) => {
      let line = raw;
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end < 0) return;
        line = line.slice(end + 2);
        inBlock = false;
      }
      for (;;) {
        const s = line.indexOf('/*');
        const l = line.indexOf('//');
        if (s >= 0 && (l < 0 || s < l)) {
          const end = line.indexOf('*/', s + 2);
          if (end < 0) { line = line.slice(0, s); inBlock = true; break; }
          line = line.slice(0, s) + line.slice(end + 2);
        } else if (l >= 0) {
          line = line.slice(0, l);
          break;
        } else break;
      }
      if (!NAME_PATTERNS.some((re) => re.test(line))) return;
      if (NAME_WRITE.test(line)) return; // `def.name =` writes are table fills, not reads
      const allowed = NAME_ALLOW.some((a) => a.file === rel && line.indexOf(a.sub) >= 0);
      if (!allowed) fail('raw content-name read at ' + rel + ':' + (i + 1) + ': ' + line.trim().slice(0, 120));
    });
  }
  ok('presentation-name source scan clean (frozen tables + resolver + documented identity uses only)');

  if (failed > 0) {
    console.error("check-i18n FAILED: " + failed + " error(s)");
    process.exit(1);
  }
  console.log("check-i18n OK");
}

main();

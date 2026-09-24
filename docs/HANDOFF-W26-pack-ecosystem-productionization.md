# W26 Handoff — Pack Ecosystem Productionization

**Status:** IMPLEMENTED + HARDENED — **NOT SPEC-COMPLETE** (mandatory follow-ups remain)
**Started from:** `6aed702` (post-W25 docs, includes W26 OpenSpec package)
**WS1 commit:** `f5b05d5` — declarative wall + standalone loot-table families
**Final implementation:** `5d39c11` (verified identity/save/browser compatibility closure)
**Execution prompt:** W27 prompt is completed; W26 remains VERIFY/NOT SPEC-COMPLETE
**OpenSpec change:** `openspec/changes/w26-pack-ecosystem-productionization/`

## Mission

Turn the W25 safe-extensibility foundation into a production-usable pack ecosystem without weakening security, determinism, identity, save, multiplayer, or boot-order contracts. One coherent end-to-end path where a user can import and persist safe JSON packs, activate them on a fresh session, use expanded declarative content families, have pack enemies participate in natural spawning, and run/join a dedicated multiplayer server with the same pack identity.

## Changed systems

- **js/packs.js** — added bounded families `walls` (64), `lootTables` (64), `spawnRules` (64) to `FAMILY_LIMITS` and `knownFam`; extended `reserveNames` to track wall/lootTable stable ids; added wall/lootTable/spawnRule staging, commit (wall appends to `WALL_DEFS` with numeric alias, lootTable registers `lootTable` kind, spawnRules compile into global deterministic index), reference normalization (wall/lootTable/enemy), journal rollback (wallLen + spawnLen/counter), `resolveStable` maps, and exposed `getSpawnRules()`. Preserves zero-pack fingerprint when no packs active.
- **js/registry.js** — added `lootTable` to `KINDS` (empty bucket contributes no fingerprint lines; zero-pack fingerprint stays `1b1d7c15`; baseline refreshed with `lootTable:0`).
- **js/lootables.js** — added `rollById(sid)` and extended `rollEntity` to also roll a referenced `def.lootTable` via the same `loot` GameRng stream; no second evaluator.
- **js/packstore.js** *(new, W26)* — `TC.PackStore` durable installed-manifest store: versioned envelope `tc_packs_installed_v1` (`{v:1, manifests:[{id,digest,json}]}`), caps `MAX_INSTALLED=64`, `MAX_MANIFEST_BYTES=256 KiB`, `MAX_TOTAL_BYTES=4 MiB`, corruption-safe degrade (truncated/wrong-version → empty), install validates ONLY through `TC.Packs.provideJSON` (no bypass), identical digest idempotent, conflicting same-id requires `replace:true` (blocked while active), export whole envelope or single pack, remove blocked while active (session-permanence), `load()` provides before activation, `repair()` hygiene, `stats()`.
- **js/enemyspawn.js** — added `packSpawnEntries` seam that merges compiled `TC.Packs.getSpawnRules()` into `zoneTable` (filtered by zone/biome/depth/time/requires, deterministic order, no per-tick registry scan; Blood Moon night still returns `BLOOD_MOON_TABLE` only).
- **js/main.js** — W26 boot order: `PackStore.load()` before `Packs.bootActivate()` so installed packs are provided before activation; registry sync and boot tasks still after.
- **js/ui.js** — title Packs panel evolves: Install JSON (hidden file input with prompt fallback), per-row Export/Remove for installed packs (Remove blocked while active, with localized toasts), Apply & Restart, Close; layout widened to 500px, new rects `packsInstallRect` + per-row `exportRect`/`removeRect`, `onClick` handling, `drawPacksPanel` draws small buttons and truncates labels. All new strings via `t()` with pseudo-locale proof.
- **js/packstore.js** added to `index.html` after `packs.js` (production load order).
- **js/constants.js** — `TC.VERSION` `0.1.0` → `0.9.0` (aligns with `package.json`; `TC.Packs.GAME_VERSION` now derives from `TC.VERSION`, and dotted ranges canonicalize missing segments).
- **js/locales/en.js** — added W26 `ui.packs` keys: `install`, `export`, `export_all`, `remove`, `installed`, `install_ok`, `install_unchanged`, `install_failed`, `remove_ok`, `remove_failed`, `remove_active`, `export_failed`, `quota_error`, `conflict_error` (14 new keys; total 568).
- **tools/mp-server.js** — added fail-closed `--packs` / repeatable `--pack-file` input (every occurrence requires a value; local files are descriptor-bound and capped before parsing), pack activation before `NetServer.start()`, and bounded `/debug?tx=&ty=` authoritative tile reads.
- **tests/fixtures/registry-baseline-w24.json** — added `lootTable:0` (additive-only, fingerprint unchanged).
- **tests/packs/w26-content-families.test.js** *(13 tests)* — walls/lootTables: append-only, invalid rejection (including zero hardness), canonical PlaceWall/MineWall, deterministic roll, enemy lootTable kill drop, cross-pack dependency, rollback, save classification.
- **tests/packs/w26-packstore.test.js** *(new, 10 tests)* — PackStore: fresh/corrupt/wrong-version degrade, quota, identical/conflicting/replace, active-remove guard, export roundtrip, surviving reload, malicious bypass.
- **tests/packs/w26-spawn.test.js** *(new, 7 tests)* — spawn rules: valid/invalid vocab, boss rejection, cross-pack dependency, deterministic ordering, biome/depth/time/requires filtering, rollback.
- **docs/TASK_BOARD.md** — snapshot header W20 → W26, added W26 row (walls/lootTables/spawnRules + PackStore + dedicated host), updated follow-ups to include W26 LANDED.
- **docs/ARCHITECTURE.md** — §29 updated to W26: supported families, PackStore, spawn grammar seam, boot order, PackStore caps, version semantics (package.json 0.9.0 ↔ TC.VERSION 0.9.0 ↔ Packs 0.9 compat ↔ SaveCore 0.9.0-campaign ↔ NetProto 4).
- **AGENTS.md** — `packs.js` row updated to W26 families, added `packstore.js` row, `enemyspawn.js` row updated with W26 seam, `constants.js` version note.
- **README.md** — Content packs section W25 → W26 (families, PackStore install/export/remove, dedicated host --packs/--pack-file), multiplayer dedicated host line updated.

## Schemas

**Wall** (`content.walls[]`): `{key, name, color:"#rrggbb", hardness:(0,10], drop?:itemRef}` — color required, hardness defaults 0.5, zero hardness is rejected because canonical mining cannot break it, drop references an item (same-pack or dependency). Appends to `WALL_DEFS`, alias `wall:sid -> index`.

**Loot table** (`content.lootTables[]`): `{key, name, entries:[{id:itemRef, min:1..999,max:1..999,chance:0.0001..1,requires?:progressionCond}]}` max 64 entries, 64 tables per pack. Registers `lootTable` kind, rolled via `LootTables.rollById` / `rollEntity` loot stream.

**Spawn rule** (`content.spawnRules[]`): `{enemy:itemRef, zone:day|night|cave|underworld, weight:0.01..10, biome?:forest|desert|snow|jungle|ocean|corruption, depthMin?:0..500, depthMax?:0..500, time?:day|night, requires?:progressionCond}` max 64. Compiled at activation into global `spawnRules[]` ordered by pack topo + manifest order, filtered in `zoneTable` by zone/biome/depth/time/requires, weight merged into weightedPick via GameRng.spawn.

**PackStore envelope** (`tc_packs_installed_v1`): `{v:1, manifests:[{id,digest,json}]}` — only validated JSON via `provideJSON`, caps 64/256 KiB/4 MiB, corrupt → empty, identical re-import idempotent, same-id different digest requires `replace:true` (blocked while active).

## Security decisions

- No second loader, no executable code: packs remain pure data, no eval/new Function/script injection, no callbacks/hooks, only built-in vocab for ai/look/pattern/zone/biome.
- All installed JSON passes through `TC.Packs.provideJSON` (safeScan: prototype pollution, non-finites, oversize, depth, unknown fields, reserved ns, traversal) before persistence; `load()` re-provides and skips any entry that fails (degrade).
- Spawn rules cannot reference boss machinery (boss:true or BOSS_AI); cross-pack enemy references require declared dependency (checks `rec.deps`/`optionalDeps` at staging, fail-closed).
- Dedicated host file loading is host-local config, byte-bounded before parse, same validator, activated before world creation; mismatch rejects before snapshot.
- Zero-pack fingerprint remains `1b1d7c15`. New gameplay identity is order-sensitive; W25 `97f8ff42` saves/v4 peers migrate only after legacy content, versions, and reconstructed data-pack order match. Current gv2 resource-only changes stay compatible; ambiguous gv1 resource changes fail closed. Saves are classified before mutation.

## Test counts

- `npm run check` — 58 files, 0 failures
- `npm run check:i18n` — 568 fallback keys, 269 registry names resolved, fingerprint `1b1d7c15` match, 374 stable ids, 368 pre-W24 unchanged
- `npm test` (node:test) — **665 pass, 0 fail** at `5d39c11`
  - packs: 89/89; full browser: 32/32; build/verify/i18n green
- `node tools/fuzz-packs.js` — 400 rounds seed 20260924, accepted 43, rejected 756, **escapes 0**
- `node tools/bench-packs.js` — activation 1.074ms, classifySave 36.0ms/50k, save delta +103 bytes, v4 hello 141 bytes
- `npm run build` — 58 js files, 60 referenced assets
- `npm run verify:build` — boots, renders, new-game and continue work, zero browser errors
- `npm run test:browser` — **32 passed** on Chromium; includes the W27 frame-time gate, pack UI, and multiplayer journeys.

## Benchmarks

See `tools/bench-packs.js` above; `tools/bench-runtime.js` unchanged (W21/W25 optimizations intact). Spawn-rule per-attempt cost is O(applicable rules) not O(all content); packstore load is boot-only O(installed bytes) under 4 MiB cap.

## CI runs

- Final local gate at `5d39c11`: `npm run validate` green — 665/665 Node,
  32/32 Chromium, build + verify-dist, i18n, fingerprint `1b1d7c15`. Journey M
  also passed 20 consecutive stress iterations after deterministic harness repair.

## Known limitations

- Pack families still exclude NPCs/shops, projectiles, buffs, biomes (intentionally deferred; same atomic model would apply).
- PackStore total bytes counted as string length (UTF-16) not exact UTF-8 bytes; cap is conservative for ASCII JSON.
- Spawn rules do not yet support Blood Moon-specific tables (night Blood Moon still returns `BLOOD_MOON_TABLE` only).
- Browser import uses hidden file input + FileReader; very large files are size-checked before read where possible, but quota is also enforced after read.
- Pseudo-locale and narrow-viewport for new pack panel not yet exercised in automated browser run (requires display).

## Next candidates

- Hardening queue per EXECUTION_PROMPT: larger fuzz corpus, store quota stress, dedicated WebSocket reconnect/resync with packs, save export/import + install/uninstall recovery matrix, pseudo-locale/narrow viewport sweeps, comment/version audit.
- Stretch: smallest safe NPC/shop-row declarative family (investigate, implement only if pure-data/atomic model holds).

## Commits in this campaign

- `f5b05d5` — feat(w26): declarative wall + standalone loot-table pack families (WS1)
- `f5b05d5` / W26 final implementation (PackStore + spawn grammar + dedicated host + version/docs)
- `15bd4cc` — optional dependency semantics, immutable manifest snapshots, save fingerprint enforcement, atomic rollback hardening
- `a905126` — canonical headless/browser boot order, wall placement/drop/byte bounds, loot bounds, forest/ocean spawn rules
- `a19893e` — order-sensitive gameplay identity, resource-only save compatibility, positive wall hardness, fail-closed dedicated-host pack inputs
- `5d39c11` — canonical W25 legacy content/order migration, fresh/rejoin welcome echo, duplicate host-option rejection, authoritative Journey M placement/interest repair

## Reproduction

```bash
npm run check && npm run check:i18n && npm test && node tools/fuzz-packs.js && node tools/bench-packs.js && npm run build && npm run verify:build
# browser (requires display):
npm run test:browser
```

---

## 2026-09-24 continuation reconciliation

Commits `15bd4cc` and `a905126` closed concrete gaps found by comparing this
OpenSpec package with current code/tests:

- `optional.packs` is now explicit and deterministic: installed-but-inactive
  sources never auto-activate; active optional edges version-check and order
  before dependers; inactive references fail closed; cycles reject; compound
  ranges canonicalize to stable identity.
- Programmatic manifests are snapshotted/frozen in one bounded pass; caller
  mutation, accessors, hidden/symbol fields, prototype tricks, Proxy descriptor
  substitution, and oversized sparse/wide inputs fail closed.
- Live activation may append only after the canonical prefix; gameplay identity
  includes canonical data-pack order because resource dependency edges can alter
  dense IDs. Current gv2 resource-only differences remain compatible; legacy
  gv1 migration additionally requires the historical full content fingerprint
  and required-only reconstructed order to match.
- Localization rollback is reverse-ordered; registry/core-before-wiring boot
  order is identical in browser/headless/dedicated paths; pack recipe ownership
  survives registry mirroring.
- Walls cannot overflow 8-bit world ids or stage unminable zero hardness;
  wall-only blocks use `UseItem` → `PlaceWall`; declared wall drops emit
  exactly once; standalone loot minimums match `TC.LootTables`; forest/ocean
  spawn rules are reachable.
- `classifySave` fingerprint caches keep the isolated final benchmark at
  36.0 ms / 50k, below the historical 56 ms baseline. Dedicated-host options
  reject missing/duplicate values before startup; local files are descriptor-bound
  and capped before parsing. Process-level regressions cover every rejection.

Final proof at `5d39c11`: full `npm run validate` is green (665/665 Node,
32/32 Chromium, build + verify-dist, i18n, fingerprint `1b1d7c15`); the isolated
pack suite is 89/89 and Journey M passed 20/20 consecutive stress iterations.
W25 `97f8ff42` / `715306e0` peers and saves migrate only with matching legacy
content, required-only order, and declared versions; current gv2 preserves
compatible resource-only changes. Fuzzing 400 rounds at seed 20260924 accepted
43, rejected 756, and found 0 escapes. Final activation was 1.074 ms and
classification 36.0 ms/50k. Known remaining limitations are intentionally not
overstated: exact UTF-8 store accounting, unmaterialized `resources.files`,
large pack-panel UX, dedicated-host-plus-packs end-to-end automation, W26-family
fuzz coverage, and a durable exhaustive file-coverage ledger remain follow-ups.

---
*Generated for W26 pack-ecosystem productionization; additive changes preserve zero-pack equivalence.*

# W26 — Pack Ecosystem Productionization

**Status:** ACTIVE  
**Planned-From:** `cbe81492386c027cd7b2b508868f0e93b2fecc7c`  
**Planned-At:** 2026-08-26  
**Target-Branch:** `main`  
**Campaign-Type:** major implementation + integration + security hardening + multiplayer + browser UX  
**Execution entrypoint:** repository-native `goal` continuation (`/goal continue`, `continue`, or equivalent supported by the active harness)  
**OpenSpec change:** `openspec/changes/w26-pack-ecosystem-productionization/`  
**Execution budget:** 12 productive hours

## Mission

Turn the W25 safe-extensibility foundation into a production-usable pack ecosystem without weakening its security, determinism, identity, save, multiplayer, or boot-order contracts.

W26 must deliver one coherent end-to-end path in which a user can import and persist safe JSON packs, activate them on a fresh session, use expanded declarative content families, have pack enemies participate in natural spawning through a deterministic grammar, and run/join a dedicated multiplayer server with the exact same pack identity. The work must remain entirely declarative: **do not implement executable mods, eval, dynamic scripts, arbitrary callbacks, or a second mod runtime.**

The campaign is not complete when a schema parses. It is complete only when real browser UX, headless gameplay, save compatibility, dedicated WebSocket multiplayer, adversarial validation/fuzzing, release build, and the full repository gate prove the same production path.

Read the OpenSpec package before implementation. If this prompt and the OpenSpec package conflict, use the stricter invariant and document the reconciliation in the W26 handoff.

## Planner audit / current truth

The planner recursively inventoried the tracked repository tree and deep-reviewed the canonical runtime, registry, event/RNG/targeting, settings/localization, packs, scheduler/runtime/commands, persistence, multiplayer protocol/server/client, world-region/liquid/wiring, UI, enemy spawning, dedicated-server, validation/CI, pack tests, W25 plan/handoff and current task-board state. See `docs/W26-AUDIT.md` for the durable audit ledger.

Current truth at planning time:

- `main` is exactly `cbe81492386c027cd7b2b508868f0e93b2fecc7c`, the terminal W25 documentation/CI-closure commit.
- W25 is completed. Do **not** recreate MOD-001/002/003, protocol-v4 pack identity, atomic activation, save classification, the title Packs toggle panel, or the existing fixture-pack coverage.
- The last recorded W25 full gate is green: 597 Node tests, 30 browser journeys, pack fuzzing, build/verify, and CI closure are documented in the W25 handoff.
- `TC.Packs` is already the canonical fail-closed pack authority. Its pipeline is parse → structural validation → semantic/reference validation → dependency/version resolution → deterministic identity → staged registration → atomic commit/rollback.
- W25 supports declarative **tiles, items, enemies, recipes** plus localization resources. Explicitly excluded families remain walls, NPCs/shops, standalone loot tables, projectiles, buffs and biomes.
- `TC.Registry` already has stable kinds for walls/NPCs/buffs/projectile types/biomes; zero-pack identity must remain unchanged.
- `TC.EnemySpawn.zoneTable()` still merges hard-coded built-in `TC.CONST.SPAWN` + `EXTRA_SPAWN`; pack enemies cannot naturally spawn today.
- `tools/mp-server.js` boots the real game headless but has no `--packs` / pack-file selection path. Dedicated hosts therefore cannot deliberately reproduce a user-selected pack set from the CLI.
- The title Packs panel only toggles already-provided packs. There is no production JSON import/install/export/remove workflow and no durable installed-manifest store.
- `TC.Localization.extend()` already supports reversible pack catalog fragments; imported pack UI must reuse this rather than create a second localization system.
- `TC.SaveCore` and protocol v4 already carry active gameplay pack identity. Any W26 content must preserve pre-mutation save/load classification and pre-admission multiplayer mismatch rejection.
- Script order in `index.html` is executable dependency order and is also consumed by the release/test loaders. `main.js` deliberately defers its boot tail until every script has loaded. New modules must not reintroduce the W25 pre-boot registry race.
- `js/constants.js` exposes `TC.VERSION = "0.1.0"`, while `package.json` is `0.9.0`, `TC.Packs.GAME_VERSION` targets `0.9`, and `SaveCore` writes `0.9.0-campaign`. This is version-semantics/documentation drift that W26 must explicitly reconcile without accidentally changing compatibility meaning.
- `docs/TASK_BOARD.md` still labels its snapshot as W20 despite containing W25 truth; `.agent/EXECUTION_PROMPT.md` was stale at W24 before this planning commit; several comments still describe earlier network generations. W26 completion must truth-sync active documentation.
- `events.js` has harmless formatting drift around `PacksChanged`; clean it only when touching the file for real work, not as an unrelated rewrite.
- Core runtime architecture is not the problem: `TC.Runtime → TC.Systems → TC.Commands`, `TC.WorldRegions`, `TC.GameRng`, `TC.Targets`, `TC.SaveCore`, and server-authoritative multiplayer are coherent. W26 must extend these seams, not replace them.

## 12-hour execution contract

Treat 12 hours as a **productive campaign budget**, not as a reason to sleep/wait. Do not artificially delay, idle, poll pointlessly, or insert sleeps to consume time.

If the mandatory implementation becomes green early, continue through the hardening queue below until the 12-hour budget is exhausted or every mandatory + hardening item is terminally proven. If the harness has a shorter hard session limit, checkpoint the exact ledger, commit/push safe progress, and let the next `goal` continuation resume from the first incomplete item. Never discard progress just to keep one process alive.

Suggested pacing, adjustable from evidence:

1. **Hour 0–1:** reconcile Git, read every tracked text/source/test/tool/config file locally, baseline `npm run validate`, build the W26 evidence ledger.
2. **Hour 1–3:** pack schema/identity expansion: walls + standalone loot-table authority and tests.
3. **Hour 3–5:** durable installed-pack store + browser JSON import/export/remove UX + corruption/quota/security tests.
4. **Hour 5–7:** deterministic natural-spawn rule grammar + replay/zone/progression tests.
5. **Hour 7–9:** dedicated host pack CLI + real WebSocket pack-match/mismatch flows.
6. **Hour 9–11:** fuzzing, abuse cases, save/import/export, multiplayer soak, browser journeys, benchmark/regression repair.
7. **Hour 11–12:** full validation, CI-equivalent rerun if needed, docs/task-board/architecture truth-sync, final handoff, detailed commit(s), push.

### Hardening queue if mandatory scope becomes green early

In order, continue with productive work instead of stopping:

1. Increase pack fuzz coverage with deterministic seeds and malformed cross-pack references.
2. Add installed-store corruption, quota, duplicate, downgrade/upgrade and activation-reload tests.
3. Add large-but-valid pack stress/benchmark evidence and verify activation remains bounded and boot-only.
4. Add real dedicated WebSocket reconnect/resync coverage with active data packs.
5. Add save export/import + missing-pack recovery UX cases.
6. Audit every user-visible W26 string under pseudo-locale and narrow/small viewport browser runs.
7. Reconcile stale code comments/version labels/task-board wording discovered during the audit.
8. **Stretch only after all above are green:** investigate (do not blindly implement) the smallest safe NPC/shop-row declarative family. Implement it only if it fits the same pure-data/atomic model without destabilizing the terminal gate. Stretch work is not required for W26 completion.

## Non-negotiable preserved behavior

1. **One pack authority.** `TC.Packs` remains canonical. No second loader, registry, activation service, or hidden test-only pack path.
2. **Declarative-only security boundary.** No `eval`, `new Function`, dynamic `<script>`, module import from pack data, function-valued manifest fields, callbacks, hooks, arbitrary code, prototype pollution, path traversal or executable resource formats.
3. **MOD-004 remains deferred.** Do not turn W26 into a sandboxed executable-mod campaign.
4. **Zero-pack equivalence.** With no active packs, built-in behavior and the W25 base registry fingerprint (`1b1d7c15`) remain exact unless a deliberate correction proves why the historical invariant itself was wrong. Adding an empty registry kind must not perturb the fingerprint.
5. **Stable identity.** Existing numeric tile/wall ids and legacy aliases never reorder or renumber. New dense indices append deterministically after built-ins/earlier committed content.
6. **Fresh-session activation.** Gameplay pack-set changes remain restart/fresh-session operations. Do not support mid-world removal that shifts dense indices.
7. **Save safety before mutation.** Missing/incompatible pack state is classified before world/character mutation. Stored saves remain untouched on refusal.
8. **Server authority.** Joined clients never simulate authoritative AI/spawning/combat/liquid/wiring or declare world truth. Pack identity mismatch rejects before snapshot admission.
9. **Single-player remains zero-network.** Pack features cannot require a local server.
10. **Deterministic gameplay.** Natural spawn rule order/selection uses `TC.GameRng` and stable ordering; no `Math.random`, wall-clock order, Set/Object insertion accident or locale text influences gameplay identity.
11. **Canonical transactions.** Gameplay mutations continue through `TC.Commands`; no pack-specific mutation bypass.
12. **Canonical scheduling.** No second update loop. New simulation work must register into the existing fixed-step schedule and be bounded.
13. **Canonical invalidation.** Wall changes continue through `TC.WorldRegions` and existing world mutation seams; no competing dirty-region store.
14. **Localization stays presentation-only.** Stable ids, save keys, protocol fields, conditions and spawn rules are never translated or derived from translated text.
15. **Boot order is a contract.** New modules/scripts must work in browser, headless test loader, release build and file://-style script execution. Do not rely on a bundle-only import graph.
16. **No hidden test shortcuts.** Browser/server journeys use real production seams. Fixtures may seed state but cannot bypass authority/replication/activation.
17. **No failure masking.** Do not weaken assertions, add arbitrary sleeps, inflate timeouts without measurement, swallow errors, blanket-retry failures, skip suites, or mark flaky behavior as acceptable.
18. **No Critical/High regressions.** Repair any introduced Critical/High defect before completion.
19. **No destructive Git behavior.** No force-push/history rewrite. Follow `main`-only repository policy unless current repo instructions have explicitly changed.

## Mandatory scope

### WS0 — Reconcile actual state + exhaustive local audit

Before implementation:

1. `git fetch --all --prune`; inspect status, `main`, origin/main, recent commits after Planned-From, open PRs/issues, current workflow status and any uncommitted work.
2. Read applicable `AGENTS.md`, `.agent/PLANNER_HANDOFF.md`, this prompt, `.agents/skills/goal/SKILL.md`, W25 handoff/plan, `docs/W26-AUDIT.md`, task board, architecture, performance notes and the entire OpenSpec change.
3. **Read every tracked text/source/test/tool/config file in the repository**, not only files named in this prompt. Build a durable coverage ledger in the W26 handoff or a dedicated audit appendix. For binary screenshots/assets, inventory paths, sizes/references and confirm no code/config contract depends on missing/untracked assets; do not pretend binary pixels contain logic.
4. Search for TODO/FIXME/HACK, stale campaign/version labels, direct mutations, bare gameplay `Math.random`, unsafe dynamic execution, unbounded loops/queues, duplicate authorities, test-only production branches and load-order assumptions. Classify each finding Critical/High/Medium/Low/info and disposition it.
5. Reconcile every requirement as satisfied / partial / stale / open. Do not redo already-landed work.
6. Run the clean baseline `npm run validate` before edits. Record exact counts/timings. If an environment stage is genuinely unavailable, record exact command/error and run all narrower available gates.
7. Create/maintain a W26 evidence ledger with changed files, decisions, tests, fuzz seeds, benchmark numbers, browser journeys, CI runs and unresolved limitations.

### WS1 — Expand declarative content safely: walls + standalone loot tables

Implement the OpenSpec `pack-content` requirements.

#### Walls

- Add a bounded `content.walls` family to the existing manifest schema.
- Wall definitions are pure data and may only use a safe built-in painter vocabulary already supported by `TC.Tiles.drawWall`/wall rendering. No pack callbacks.
- Append wall defs after built-ins in deterministic pack activation order; never renumber built-ins.
- Register stable `packid:key` wall identity and legacy dense alias coherently.
- Validate colors, names, hardness/drop/reference fields and any item relationship before commit.
- Pack-defined wall items/recipes must route through existing `PlaceWall`/mining/crafting transactions.
- Wall mutation must mark canonical WorldRegions and replicate/save through existing world-region/save paths without a special pack channel.
- Add localization keys for names/descriptions.

#### Standalone loot tables

- Add one canonical stable identity for pack-owned standalone loot tables (recommended registry kind `lootTable` if the live audit confirms it preserves zero-pack fingerprint; otherwise document an equally deterministic canonical authority).
- Add bounded pure-data `content.lootTables` schema. Entries use the existing `TC.LootTables` probability/count/progression grammar; functions are forbidden in pack manifests even though built-in runtime helpers may accept them.
- Allow supported pack enemy/content definitions to reference a validated loot-table id without duplicating evaluator logic.
- Cross-pack references are allowed only through declared dependencies and must resolve at staging time.
- Roll-time uses canonical `TC.GameRng` loot stream. Unknown/missing references fail staging, never silently become empty loot.
- Preserve built-in inline `drops` compatibility. Do not mass-migrate built-in content solely for style.
- Update fuzzing and rollback tests so a bad wall or loot table in pack N leaves all earlier live state unchanged.

### WS2 — Durable installed pack store + production browser import/export UX

Implement the OpenSpec `pack-installation` requirements.

Create a small canonical installed-manifest authority (for example `TC.PackStore`) rather than stuffing large arbitrary manifests into `TC.Settings` or world saves.

Requirements:

- Separate user preferences (`TC.Settings`), installed pack source data, active pack set, and world save data.
- Persist **validated JSON manifests only** under a versioned localStorage envelope with explicit per-manifest and total-store caps. Never persist executable code.
- Corrupt/truncated/wrong-version storage degrades safely and cannot break boot.
- Import accepts `.json`/JSON text through a production title-screen flow, passes bytes through `TC.Packs.provideJSON`/the same validator, and only stores after successful validation.
- Import duplicate policy is explicit: byte/content-identical re-import is idempotent; same id with different digest requires a clear replace/update path and must not silently overwrite an active/session-committed definition.
- Export returns the canonical installed manifest JSON for backup/sharing.
- Remove/uninstall is allowed only when it cannot invalidate the current committed gameplay set; otherwise the UI explains that a restart/deactivation is required.
- Installed manifests are provided to `TC.Packs` **before activation** during boot. Resolve the exact browser/headless boot sequence instead of adding a race.
- The existing Packs panel evolves into an Installed/Available management surface while remaining compact and canvas-native.
- Every new user-visible label/error/status is localized and pseudo-locale tested.
- Imported manifests containing file-backed resources that the browser cannot actually materialize must fail clearly or remain unsupported; never pretend a resource path exists.
- Add deterministic quota/corruption/duplicate/update/remove tests and a real browser journey that imports, activates via reload, plays with the imported content, exports it, and verifies persistence across reload.

### WS3 — Deterministic pack enemy natural-spawn grammar

Implement the OpenSpec `pack-spawning` requirements.

Replace the W25 limitation without handing packs executable AI/spawn callbacks.

- Add a bounded declarative spawn-rule family or manifest section. Prefer an explicit schema such as `{ enemy, zone, weight, biome?, depthMin?, depthMax?, time?, requires? }`, but reconcile against live spawn architecture before freezing the shape.
- Supported zones/biomes/time values are enumerated built-in vocabulary; unknown values fail staging.
- `enemy` must resolve to a non-boss supported enemy provided by this pack, a dependency, or core as allowed by policy.
- `weight` and depth bounds are finite/bounded. Progression conditions reuse `TC.Progression`'s declarative grammar; no functions.
- Merge rules into `TC.EnemySpawn.zoneTable()` through one canonical extension seam. Do not make `packs.js` own the spawn director.
- Ordering is deterministic: dependency/topological pack order + manifest order (or another explicitly documented stable order). Weighted choice consumes the existing `TC.GameRng` `spawn` stream.
- No per-tick whole-registry scan. Activation compiles/indexes rules by relevant zone/biome; runtime lookup is bounded by applicable rules.
- Blood Moon, underworld depth precedence, biome overrides, multi-player anchor selection and progression multipliers keep existing semantics unless a pack rule explicitly participates under the declared grammar.
- Add deterministic replay tests, rule-order invariance tests where appropriate, malformed-rule fail-closed tests, cross-pack dependency tests and a browser/gameplay proof that a pack enemy naturally spawns.

### WS4 — Dedicated multiplayer pack selection + real transport parity

Implement the OpenSpec `multiplayer-pack-hosting` requirements.

- Extend `tools/mp-server.js` with explicit pack selection. Minimum production interface: `--packs id1,id2` for build-provided/installed-in-host manifests and a repeatable bounded local JSON manifest option such as `--pack-file path.json` for Node dedicated hosts.
- File loading is local host configuration, not network-distributed code. Enforce manifest byte caps before parse and use the same `TC.Packs` validation/provide path.
- Resolve boot order cleanly so pack manifests are provided and the active set is committed **before** authoritative world creation, registry fingerprint capture, save identity or handshake admission. Do not mutate pack tables after `server.start()`.
- If `loadGame()` needs a narrowly-scoped pre-boot/provider injection seam, design it as a general deterministic loader hook used by tests/tools, not as a pack-only bypass or a production-game mutation shortcut.
- Host diagnostics must report active pack ids/digest without leaking full untrusted manifest data.
- A client with exact gameplay pack digest joins; mismatch rejects before snapshot/world mutation. Resource-only differences continue to follow W25 gameplay-vs-content identity semantics.
- Add real WebSocket journey/Node integration coverage for: exact match join + gameplay, mismatch reject, file-manifest host boot, reconnect/resync with packs, malformed host pack failure before listen/world start.
- Preserve protocol v4 unless the wire shape actually changes. Do not bump protocol just because tooling gained CLI flags.

### WS5 — Version semantics + documentation integrity

- Decide and document the authoritative meaning of `package.json` version, `TC.VERSION`, `TC.Packs.GAME_VERSION`, `SaveCore.gameVersion`, and protocol version. Prefer one source-of-truth mapping or explicit differentiated semantics.
- Do **not** casually break existing `requires.game` pack compatibility. If changing `TC.Packs.GAME_VERSION`, add compatibility tests/migration rationale.
- Update `docs/TASK_BOARD.md` snapshot label/status to current truth without marking future work DONE prematurely.
- Update `docs/ARCHITECTURE.md` for installed-pack boot ordering, new families, spawn grammar and dedicated-host flow.
- Update `AGENTS.md` module/API contracts for any new module/service.
- Update README user instructions only for features that are truly production-ready.
- Clean stale W22/W23/W24/W25 comments when directly relevant, including network region-layer descriptions and active pack behavior, but avoid unrelated formatting churn.

## Test and validation matrix

Mandatory additions/coverage include:

### Pack boundary / unit
- valid/invalid walls; stable append-only indices; localization; save/roundtrip;
- valid/invalid standalone loot tables; cross-pack refs; progression gates; deterministic rolls;
- atomic rollback spanning old + new families;
- global manifest size/depth/string/count bounds still enforced;
- prototype-pollution, functions, non-finites, unknown fields, traversal and reserved namespace attacks remain rejected;
- deterministic digest/fingerprint across realms/key insertion/provide order.

### Pack store
- fresh/corrupt/truncated/wrong-version storage;
- quota and maximum-entry boundaries;
- identical duplicate, conflicting same-id update, uninstall active/inactive;
- persisted install survives reload and is provided before activation;
- export/import canonical roundtrip.

### Spawn rules
- every supported zone/biome/time/depth/progression combination at boundaries;
- invalid references and dependency violations fail before commit;
- same seed + same input trace produces identical spawn sequence/digest;
- no pack rule can spawn forbidden boss machinery;
- multi-player targeting/anchor behavior remains valid.

### Persistence and identity
- zero-pack baseline fingerprint remains `1b1d7c15`;
- active W25 fixture identity remains stable unless a deliberate expected fixture extension is made and documented;
- old saves load unchanged with zero packs;
- W25 pack saves still classify correctly;
- W26 wall/loot/spawn content survives save/export/import/reload;
- missing/incompatible pack refusal mutates neither save bytes nor live world state.

### Multiplayer
- exact gameplay digest admits; mismatched digest rejects before snapshot;
- build-provided and CLI JSON pack manifests produce the same identity when logically equal;
- reconnect/resync retains pack gate;
- pack wall changes and pack enemy state replicate through existing region/entity paths;
- no client-side natural spawn simulation;
- four-player/latency/soak/parity suites remain green.

### Browser
Add at least one new production journey after Journey P, using semantic helpers rather than arbitrary sleeps:

1. import a JSON pack from the title UI;
2. verify Installed state and reload activation;
3. create/play a world with a W26 wall/loot/spawn feature;
4. prove a natural pack enemy spawn and resulting loot path;
5. export the installed manifest;
6. verify persistence after reload;
7. exercise a useful failure path (invalid JSON or incompatible save) with actionable localized UI.

Add/extend a dedicated-host browser journey if the existing harness can spawn `tools/mp-server.js` reliably; otherwise use a production WebSocket Node integration plus existing browser join path and document why.

### Performance / boundedness
- extend `tools/bench-packs.js` or add a narrowly-scoped scenario for large valid wall/loot/spawn packs and store boot;
- no activation-time accidental O(world-size) work;
- no spawn-time all-pack/all-registry scan every tick;
- no material regression to current runtime/worldgen scenarios outside normal noise;
- record before/after measurements, machine/runtime, rounds and thresholds in handoff.

## Required commands / gates

Use the repository's current scripts after reconciling them. Minimum terminal gate:

```bash
npm run check
npm run check:i18n
npm run test:packs
npm run test:core
npm run test:save
npm run test:world
npm run test:net
npm test
node tools/fuzz-packs.js
node tools/bench-packs.js
npm run build
npm run verify:build
npm run test:browser
npm run validate
```

If new dedicated-host tests/scripts are added, include them in `npm run validate` or another CI-invoked script so they cannot silently rot.

Do not run expensive benchmarks concurrently with browser journeys when wall-clock sensitivity would contaminate evidence.

## Completion criteria

W26 may be marked `COMPLETED` only when all are true:

1. The exhaustive local audit ledger covers every tracked text/source/test/tool/config file and dispositions every Critical/High finding.
2. Walls + standalone loot tables are supported through the same fail-closed atomic pack pipeline.
3. A durable installed JSON pack store and real browser import/export/remove UX work across reloads without weakening security.
4. Pack enemies can naturally spawn through a deterministic bounded declarative grammar.
5. Dedicated hosts can select/load packs before world creation and real clients enforce exact gameplay identity.
6. Zero-pack behavior/fingerprint and all pre-W26 save/network contracts remain compatible.
7. Required new tests, fuzzing, browser journey(s), dedicated-host transport proof and benchmark evidence pass.
8. Full `npm run validate` is green at final HEAD; any flaky/retried run has a diagnosed root cause and a clean proof run.
9. Docs/architecture/task board/AGENTS/version semantics are truth-synced.
10. A durable `docs/HANDOFF-W26-pack-ecosystem-productionization.md` records start/final SHAs, commits, changed systems, schemas, security decisions, test counts, fuzz seeds, benchmark results, CI run(s), known limitations and next candidates.
11. `.agent/EXECUTION_PROMPT.md` is marked `COMPLETED` only after the gate passes.
12. All implementation/docs are committed and pushed to `main` per repository policy; working tree is clean.

## Git / agent operating rules

- Work from current `main` and reconcile anything landed after Planned-From.
- Prefer several coherent commits over one giant opaque commit; every commit must leave repository state understandable.
- Commit messages should be descriptive enough to reconstruct the session. The final campaign commit/handoff should contain a detailed session report, not merely `fix stuff`.
- If parallel agents are available, assign disjoint ownership (pack schema, store/UI, spawn, multiplayer/tests) and one integration owner. Never let agents concurrently edit shared core files without explicit coordination.
- After each material milestone, update the durable W26 ledger so a killed session can continue without rediscovery.
- Push validated progress periodically and at terminal completion. Never force-push.

## Explicit out-of-scope unless required by a W26 invariant

- executable mods / MOD-004 implementation;
- arbitrary JS/WASM/Lua/plugin callbacks from packs;
- CDN/marketplace/download service, accounts, signatures or remote package registry;
- automatic network distribution of missing packs to clients;
- NPC/shop, projectile, buff, biome pack families except optional end-of-budget investigation/stretch after all mandatory work is green;
- renderer migration (Canvas2D → WebGL/Pixi), broad visual overhaul, new bosses/biomes/content unrelated to W26;
- >4-player scaling, matchmaking/NAT traversal/relay/cloud hosting;
- protocol compression rewrite or unrelated performance epics;
- real secondary-language catalog project/RTL/font overhaul beyond localizing W26 UI keys.

## Executor start command

After pulling this planning commit, the user should only need to invoke the repository goal command, for example:

```text
/goal continue
```

The executor must read this file + the OpenSpec package, reconcile current state, and begin WS0 autonomously. Do not ask the user to restate requirements already captured here.

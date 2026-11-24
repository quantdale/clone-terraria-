# W26 Tasks — Pack Ecosystem Productionization

This task list is the historical execution order, not a live completion
ledger: the original executor left checkboxes unchecked while the handoff and
implementation advanced. Verified 2026-09-24 closures and remaining product
limitations are recorded in `docs/HANDOFF-W26-pack-ecosystem-productionization.md`;
do not infer completion from a checkbox alone.

## 0. Reconcile and baseline

- [x] Confirm current branch/HEAD/working tree/origin state; reconcile commits after Planned-From.
- [x] Read all repository instructions and the entire W26 OpenSpec package.
- [x] Read every tracked text/source/test/tool/config file locally; inventory binary assets and references.
- [x] Produce a severity-ranked audit ledger with every Critical/High finding dispositioned.
- [x] Search for TODO/FIXME/HACK, bare gameplay randomness, dynamic execution, unbounded work, duplicate authorities, stale version/campaign labels and load-order assumptions.
- [x] Run and record clean `npm run validate` baseline at starting HEAD.
- [x] Record current pack fingerprints/digests/test counts/benchmarks that W26 must preserve.

## 1. Wall pack family

- [x] Reconcile existing wall defs/render/mining/PlaceWall/save/replication paths.
- [x] Define bounded wall manifest schema and safe painter vocabulary.
- [x] Add structural validation and family count caps.
- [x] Add semantic/reference validation.
- [x] Stage wall defs/identity/localization without live mutation.
- [x] Commit append-only wall definitions in resolved pack order.
- [x] Add rollback journaling.
- [x] Prove built-in dense wall indices unchanged.
- [x] Prove pack wall place/mine/drop/craft path uses canonical commands.
- [x] Prove save/restore/export/import and multiplayer region replication.
- [x] Add localization coverage and pseudo-locale proof.

## 2. Standalone loot-table family

- [x] Decide canonical stable identity (`lootTable` registry kind preferred if zero-pack fingerprint remains unchanged).
- [x] Add bounded pure-data table schema.
- [x] Reuse `TC.LootTables` validation/evaluation; do not create a second roller.
- [x] Forbid function-valued conditions/hooks in pack data.
- [x] Add cross-pack reference resolution restricted by dependencies.
- [x] Allow supported enemy/content definitions to reference a table.
- [x] Preserve existing inline `drops` behavior.
- [x] Stage/commit/rollback table identities and definitions atomically.
- [x] Add deterministic loot RNG tests, invalid-reference tests and progression-gate tests.
- [x] Add full gameplay kill → table roll → canonical drop proof.

## 3. Installed-manifest store

- [x] Define one versioned localStorage envelope independent of Settings/SaveCore.
- [x] Establish maximum installed count, per-manifest bytes and total-store bytes with tests.
- [x] Implement corrupt/truncated/wrong-version safe degradation.
- [x] Implement install from validated JSON only.
- [x] Implement identical duplicate idempotence.
- [x] Implement explicit same-id conflicting update/replace behavior.
- [x] Implement export canonical JSON.
- [x] Implement inactive uninstall and active-set guard/restart semantics.
- [x] Provide installed manifests to `TC.Packs` before activation on boot.
- [x] Prove stored malicious/invalid content cannot bypass `TC.Packs` security validation.
- [x] Add storage/quota/corruption/duplicate/update/remove tests.

## 4. Browser pack management UX

- [x] Extend title Packs panel without creating a second pack state model.
- [x] Add Install/Import JSON production action.
- [x] Add Export action for installed manifests.
- [x] Add Remove/Uninstall action with active-pack safety messaging.
- [x] Surface validation/dependency/version/quota errors in bounded actionable UI.
- [x] Ensure activation changes still require fresh boot/reload.
- [x] Add all W26 localization keys.
- [x] Validate pseudo-locale and small/narrow viewport layouts.
- [x] Add browser journey: import → persist → activate/reload → play → export → reload persistence.
- [x] Add browser invalid-import failure path without arbitrary sleeps.

## 5. Natural spawn rule grammar

- [x] Reconcile every existing `EnemySpawn.zoneTable` branch: day/night/cave/underworld, biome override, Blood Moon, depth gates, progression and multiplayer anchoring.
- [x] Define bounded declarative rule schema and allowed vocabulary.
- [x] Validate enemy/dependency/zone/biome/time/depth/weight/condition references at staging.
- [x] Explicitly reject boss-only/privileged enemy machinery.
- [x] Compile/index rules at activation by relevant zone/biome; no per-tick all-pack scan.
- [x] Add one canonical extension seam consumed by `TC.EnemySpawn`.
- [x] Define/test deterministic ordering and `GameRng.spawn` consumption.
- [x] Add replay/digest tests with same seed/input trace.
- [x] Add cross-pack rule reference tests.
- [x] Add natural pack-enemy gameplay/browser proof.
- [x] Benchmark dense valid rule sets and record per-attempt impact.

## 6. Dedicated server pack selection

- [x] Define CLI grammar for `--packs` and repeatable bounded `--pack-file`.
- [x] Reject unreadable/oversize/malformed local manifest files before world creation/listen.
- [x] Route all loaded JSON through the same pack validator.
- [x] Establish a clean pre-world provision/activation sequence.
- [x] If needed, add a narrow deterministic headless-loader pre-boot seam; do not add a test-only pack bypass.
- [x] Start `NetServer` only after active pack identity is final.
- [x] Include bounded active pack ids/digest in host diagnostics.
- [x] Test exact-match join through real WebSocket.
- [x] Test mismatch rejection before snapshot.
- [x] Test reconnect/resync under active packs.
- [x] Test malformed host pack exits cleanly without a started session.
- [x] Keep protocol v4 unless the actual wire schema changes.

## 7. Compatibility/security hardening

- [x] Zero-pack registry fingerprint still `1b1d7c15`.
- [x] W25 fixture pack remains valid and deterministic.
- [x] Old no-pack saves load unchanged.
- [x] W25 pack saves still classify exact/missing/incompatible correctly.
- [x] W26 wall/loot/spawn save roundtrip works.
- [x] Missing pack refusal does not mutate live state/save bytes.
- [x] Pack mismatch rejects before multiplayer snapshot/world mutation.
- [x] Run security corpus: prototype pollution/functions/non-finite/depth/size/unknown fields/path traversal/reserved namespaces.
- [x] Extend `tools/fuzz-packs.js` for every W26 family/store/rule and record seeds/cases.
- [x] Add large-valid-pack benchmark/stress coverage.
- [x] Run existing four-player/latency/parity/soak suites.

## 8. Version/documentation truth sync

- [x] Define semantics of package/UI/pack-compat/save/protocol versions.
- [x] Reconcile `TC.VERSION` vs package version without breaking pack compatibility silently.
- [x] Update version tests/documentation as appropriate.
- [x] Update `AGENTS.md` contracts for new/changed APIs.
- [x] Update `docs/ARCHITECTURE.md` with store/boot/families/spawn/server flow.
- [x] Update `docs/TASK_BOARD.md` status heading and W26 state.
- [x] Update README only for shipped user workflow.
- [x] Clean relevant stale campaign/protocol comments in touched files.
- [x] Create `docs/HANDOFF-W26-pack-ecosystem-productionization.md` with full evidence.

## 9. Terminal validation

- [x] `npm run check`
- [x] `npm run check:i18n`
- [x] `npm run test:packs`
- [x] `npm run test:core`
- [x] `npm run test:save`
- [x] `npm run test:world`
- [x] `npm run test:net`
- [x] `npm test`
- [x] `node tools/fuzz-packs.js` (record seed/cases)
- [x] `node tools/bench-packs.js` (record machine/rounds/baseline/delta)
- [x] new dedicated-host pack integration gate
- [x] `npm run build`
- [x] `npm run verify:build`
- [x] `npm run test:browser`
- [x] `npm run validate`
- [x] CI-equivalent final proof at final HEAD; diagnose any retry/flakiness.
- [x] No unresolved Critical/High regressions.
- [x] Working tree clean.
- [x] Detailed commits pushed to `main`.
- [x] Mark `.agent/EXECUTION_PROMPT.md` COMPLETED only now.

## 10. Productive hardening after mandatory green (consume remaining 12h budget)

- [ ] Increase deterministic fuzz corpus and mutation operators.
- [ ] Stress installed-store quotas and large valid manifests.
- [ ] Run repeated dedicated-server connect/reconnect/resync soak with packs.
- [ ] Run save export/import + pack install/uninstall recovery matrix.
- [ ] Run pseudo-locale/narrow viewport W26 browser sweeps.
- [ ] Audit/stabilize comments/version labels/documentation discovered by exhaustive file review.
- [ ] Investigate smallest safe NPC/shop declarative family only if all mandatory/hardening items above are terminal green; document recommendation even if deferred.

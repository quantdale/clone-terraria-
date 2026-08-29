# W26 Tasks — Pack Ecosystem Productionization

This task list is execution order, not merely a feature checklist. Keep it updated during the campaign. Mark an item complete only with evidence.

## 0. Reconcile and baseline

- [ ] Confirm current branch/HEAD/working tree/origin state; reconcile commits after Planned-From.
- [ ] Read all repository instructions and the entire W26 OpenSpec package.
- [ ] Read every tracked text/source/test/tool/config file locally; inventory binary assets and references.
- [ ] Produce a severity-ranked audit ledger with every Critical/High finding dispositioned.
- [ ] Search for TODO/FIXME/HACK, bare gameplay randomness, dynamic execution, unbounded work, duplicate authorities, stale version/campaign labels and load-order assumptions.
- [ ] Run and record clean `npm run validate` baseline at starting HEAD.
- [ ] Record current pack fingerprints/digests/test counts/benchmarks that W26 must preserve.

## 1. Wall pack family

- [ ] Reconcile existing wall defs/render/mining/PlaceWall/save/replication paths.
- [ ] Define bounded wall manifest schema and safe painter vocabulary.
- [ ] Add structural validation and family count caps.
- [ ] Add semantic/reference validation.
- [ ] Stage wall defs/identity/localization without live mutation.
- [ ] Commit append-only wall definitions in resolved pack order.
- [ ] Add rollback journaling.
- [ ] Prove built-in dense wall indices unchanged.
- [ ] Prove pack wall place/mine/drop/craft path uses canonical commands.
- [ ] Prove save/restore/export/import and multiplayer region replication.
- [ ] Add localization coverage and pseudo-locale proof.

## 2. Standalone loot-table family

- [ ] Decide canonical stable identity (`lootTable` registry kind preferred if zero-pack fingerprint remains unchanged).
- [ ] Add bounded pure-data table schema.
- [ ] Reuse `TC.LootTables` validation/evaluation; do not create a second roller.
- [ ] Forbid function-valued conditions/hooks in pack data.
- [ ] Add cross-pack reference resolution restricted by dependencies.
- [ ] Allow supported enemy/content definitions to reference a table.
- [ ] Preserve existing inline `drops` behavior.
- [ ] Stage/commit/rollback table identities and definitions atomically.
- [ ] Add deterministic loot RNG tests, invalid-reference tests and progression-gate tests.
- [ ] Add full gameplay kill → table roll → canonical drop proof.

## 3. Installed-manifest store

- [ ] Define one versioned localStorage envelope independent of Settings/SaveCore.
- [ ] Establish maximum installed count, per-manifest bytes and total-store bytes with tests.
- [ ] Implement corrupt/truncated/wrong-version safe degradation.
- [ ] Implement install from validated JSON only.
- [ ] Implement identical duplicate idempotence.
- [ ] Implement explicit same-id conflicting update/replace behavior.
- [ ] Implement export canonical JSON.
- [ ] Implement inactive uninstall and active-set guard/restart semantics.
- [ ] Provide installed manifests to `TC.Packs` before activation on boot.
- [ ] Prove stored malicious/invalid content cannot bypass `TC.Packs` security validation.
- [ ] Add storage/quota/corruption/duplicate/update/remove tests.

## 4. Browser pack management UX

- [ ] Extend title Packs panel without creating a second pack state model.
- [ ] Add Install/Import JSON production action.
- [ ] Add Export action for installed manifests.
- [ ] Add Remove/Uninstall action with active-pack safety messaging.
- [ ] Surface validation/dependency/version/quota errors in bounded actionable UI.
- [ ] Ensure activation changes still require fresh boot/reload.
- [ ] Add all W26 localization keys.
- [ ] Validate pseudo-locale and small/narrow viewport layouts.
- [ ] Add browser journey: import → persist → activate/reload → play → export → reload persistence.
- [ ] Add browser invalid-import failure path without arbitrary sleeps.

## 5. Natural spawn rule grammar

- [ ] Reconcile every existing `EnemySpawn.zoneTable` branch: day/night/cave/underworld, biome override, Blood Moon, depth gates, progression and multiplayer anchoring.
- [ ] Define bounded declarative rule schema and allowed vocabulary.
- [ ] Validate enemy/dependency/zone/biome/time/depth/weight/condition references at staging.
- [ ] Explicitly reject boss-only/privileged enemy machinery.
- [ ] Compile/index rules at activation by relevant zone/biome; no per-tick all-pack scan.
- [ ] Add one canonical extension seam consumed by `TC.EnemySpawn`.
- [ ] Define/test deterministic ordering and `GameRng.spawn` consumption.
- [ ] Add replay/digest tests with same seed/input trace.
- [ ] Add cross-pack rule reference tests.
- [ ] Add natural pack-enemy gameplay/browser proof.
- [ ] Benchmark dense valid rule sets and record per-attempt impact.

## 6. Dedicated server pack selection

- [ ] Define CLI grammar for `--packs` and repeatable bounded `--pack-file`.
- [ ] Reject unreadable/oversize/malformed local manifest files before world creation/listen.
- [ ] Route all loaded JSON through the same pack validator.
- [ ] Establish a clean pre-world provision/activation sequence.
- [ ] If needed, add a narrow deterministic headless-loader pre-boot seam; do not add a test-only pack bypass.
- [ ] Start `NetServer` only after active pack identity is final.
- [ ] Include bounded active pack ids/digest in host diagnostics.
- [ ] Test exact-match join through real WebSocket.
- [ ] Test mismatch rejection before snapshot.
- [ ] Test reconnect/resync under active packs.
- [ ] Test malformed host pack exits cleanly without a started session.
- [ ] Keep protocol v4 unless the actual wire schema changes.

## 7. Compatibility/security hardening

- [ ] Zero-pack registry fingerprint still `1b1d7c15`.
- [ ] W25 fixture pack remains valid and deterministic.
- [ ] Old no-pack saves load unchanged.
- [ ] W25 pack saves still classify exact/missing/incompatible correctly.
- [ ] W26 wall/loot/spawn save roundtrip works.
- [ ] Missing pack refusal does not mutate live state/save bytes.
- [ ] Pack mismatch rejects before multiplayer snapshot/world mutation.
- [ ] Run security corpus: prototype pollution/functions/non-finite/depth/size/unknown fields/path traversal/reserved namespaces.
- [ ] Extend `tools/fuzz-packs.js` for every W26 family/store/rule and record seeds/cases.
- [ ] Add large-valid-pack benchmark/stress coverage.
- [ ] Run existing four-player/latency/parity/soak suites.

## 8. Version/documentation truth sync

- [ ] Define semantics of package/UI/pack-compat/save/protocol versions.
- [ ] Reconcile `TC.VERSION` vs package version without breaking pack compatibility silently.
- [ ] Update version tests/documentation as appropriate.
- [ ] Update `AGENTS.md` contracts for new/changed APIs.
- [ ] Update `docs/ARCHITECTURE.md` with store/boot/families/spawn/server flow.
- [ ] Update `docs/TASK_BOARD.md` status heading and W26 state.
- [ ] Update README only for shipped user workflow.
- [ ] Clean relevant stale campaign/protocol comments in touched files.
- [ ] Create `docs/HANDOFF-W26-pack-ecosystem-productionization.md` with full evidence.

## 9. Terminal validation

- [ ] `npm run check`
- [ ] `npm run check:i18n`
- [ ] `npm run test:packs`
- [ ] `npm run test:core`
- [ ] `npm run test:save`
- [ ] `npm run test:world`
- [ ] `npm run test:net`
- [ ] `npm test`
- [ ] `node tools/fuzz-packs.js` (record seed/cases)
- [ ] `node tools/bench-packs.js` (record machine/rounds/baseline/delta)
- [ ] new dedicated-host pack integration gate
- [ ] `npm run build`
- [ ] `npm run verify:build`
- [ ] `npm run test:browser`
- [ ] `npm run validate`
- [ ] CI-equivalent final proof at final HEAD; diagnose any retry/flakiness.
- [ ] No unresolved Critical/High regressions.
- [ ] Working tree clean.
- [ ] Detailed commits pushed to `main`.
- [ ] Mark `.agent/EXECUTION_PROMPT.md` COMPLETED only now.

## 10. Productive hardening after mandatory green (consume remaining 12h budget)

- [ ] Increase deterministic fuzz corpus and mutation operators.
- [ ] Stress installed-store quotas and large valid manifests.
- [ ] Run repeated dedicated-server connect/reconnect/resync soak with packs.
- [ ] Run save export/import + pack install/uninstall recovery matrix.
- [ ] Run pseudo-locale/narrow viewport W26 browser sweeps.
- [ ] Audit/stabilize comments/version labels/documentation discovered by exhaustive file review.
- [ ] Investigate smallest safe NPC/shop declarative family only if all mandatory/hardening items above are terminal green; document recommendation even if deferred.

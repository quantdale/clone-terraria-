# W26 Planner Audit — clone-terraria

Planned against `main` at `cbe81492386c027cd7b2b508868f0e93b2fecc7c` on 2026-08-26.

This document is the durable planner-side audit that selected the next campaign. It is evidence/rationale, not a claim that the W26 implementation has landed.

## Audit method and coverage

The planner recursively inventoried the repository tree, reviewed repository/agent policy and the current campaign/handoff chain, then deep-read the canonical implementation paths that own runtime sequencing, identity, persistence, networking, content, world mutation and the W25 extensibility surface. The full tracked tree was used as the coverage index, including production JS, tests, tooling, CI/configuration, documentation and screenshot artifacts.

Deep-read implementation owners included:

- `index.html` script/dependency order;
- `js/constants.js`, `enemydefs.js`, `utils.js`, `registry.js`;
- `events.js`, `gamerng.js`, `targeting.js`, `settings.js`, `localization.js`, `packs.js`;
- `systems.js`, `runtime.js`, `commands.js`, `savecore.js`;
- `netproto.js`, `netserver.js`, `netclient.js`, `tools/mp-server.js`;
- `worldregions.js`, `liquids.js`, `wiring.js`;
- `enemyspawn.js`, `lootables.js`, `ui.js`, `main.js`;
- representative pack/security/gameplay tests and the real headless loader;
- package scripts and `.github/workflows/ci.yml`;
- W25 plan/handoff, performance notes, task board, repository agent protocol.

Every tracked path was inventoried. Binary PNG screenshots were classified as non-executable evidence/assets; they were not treated as sources of program logic. The executor is required by WS0 to re-read **every tracked text/source/test/tool/config file locally** and produce a line-item coverage ledger before implementation because the local checkout can run repository-native searches/tests that the planner connector cannot.

## System map / audit verdict

### Runtime authority — healthy

`TC.Runtime.tick()` delegates to the phase scheduler, and authoritative mutations route through `TC.Commands`. The browser host is not the gameplay sequencer. This is the right architecture; W26 must register/extend through it rather than add another loop.

### Determinism — healthy, preserve exactly

`TC.GameRng` partitions gameplay randomness into deterministic streams and is replay-observable. `TC.Targets` deterministically selects multi-player targets. Worldgen has its own deterministic RNG/noise path. Natural pack spawning must consume the existing `spawn` stream and stable rule ordering.

### Registry/content identity — healthy foundation

`TC.Registry` provides namespaced stable identity, append-only dense indices, legacy aliases and deterministic fingerprints. W25 pack commits extend tables in deterministic dependency order. Zero-pack baseline fingerprint is pinned as `1b1d7c15`. New W26 families must not perturb zero-pack identity.

### Pack security/activation — strong, extend instead of replace

`TC.Packs` already enforces untrusted-input bounds, prototype-pollution rejection, no functions/code, schema whitelists, dependency/version resolution, stable digests, staging and atomic commit/rollback. Tests exercise malformed JSON, oversize input, traversal, non-finites, functions, bad refs and rollback. W26 should reuse this boundary for new families and installed manifests.

### Save compatibility — healthy

`TC.SaveCore` stores versioned providers, atomic main/tmp/bak, migrations and W25 pack metadata. Continue is gated by pack classification before mutation. Installed-pack source data must remain separate from world saves.

### Multiplayer authority — healthy, dedicated-host pack selection missing

Protocol v4 carries gameplay pack identity; client and server reject mismatches before admission/snapshot. The dedicated `tools/mp-server.js` currently has no pack selection/file-manifest CLI, so a headless host cannot deliberately establish the same active pack set before world creation. This is a concrete production gap.

### World invalidation/liquids/wiring — healthy but boot-order sensitive

`TC.WorldRegions` provides independent consumer cursors. Liquids are a canonical typed-array layer with deterministic settling and persistence. Wiring still legitimately appends content tables at script load and is loaded after `main.js` in `index.html`; the W25 deferred boot tail is therefore a critical invariant. New W26 modules/families cannot reintroduce early registry sync or activation.

### Spawn ecology — concrete pack gap

`TC.EnemySpawn.zoneTable()` composes built-in `TC.CONST.SPAWN`, hard-coded `EXTRA_SPAWN`, biome overrides and Blood Moon logic. Pack enemies can be summoned/used by direct content paths but cannot naturally participate in ecology. A bounded declarative spawn grammar is the clean next extension.

### Pack UX/distribution — concrete production gap

The title Packs panel lists/toggles packs already provided by scripts. `TC.Packs.provideJSON` exists, but there is no production import/install/export/remove UI and no durable installed-manifest store. This means W25 proves extensibility but does not yet provide a normal user workflow.

### Content-family frontier — walls and loot tables are lowest-risk next families

Walls already have stable registry identity and existing world mutation/save/replication paths. `TC.LootTables` is already the canonical evaluator/validator using the gameplay loot RNG stream. Expanding these as declarative families yields high leverage without crossing into executable mod behavior. NPC/shop/projectile/buff/biome families are deliberately deferred to later campaigns unless W26 finishes early and only investigation remains.

## Concrete audit findings

### A-001 — W25 executor entrypoint stale after campaign close

**Severity:** Medium planner/operator risk  
Before this planning commit, `.agent/EXECUTION_PROMPT.md` still described the completed W24 campaign although W25 had already landed and closed. An executor relying on the canonical handoff could pick up obsolete work. W26 replaces the entrypoint with an ACTIVE prompt and OpenSpec reference.

### A-002 — no OpenSpec change package exists

**Severity:** Medium process/continuity risk  
The repository has strong campaign docs but no existing `openspec/` hierarchy. W26 introduces a self-contained OpenSpec-style change package so requirements, design and tasks can be independently checked and continued.

### A-003 — package/game/version labels drift

**Severity:** Medium compatibility/documentation risk  
Observed labels:

- `package.json`: `0.9.0`
- `TC.VERSION` in `js/constants.js`: `0.1.0`
- `TC.Packs.GAME_VERSION`: `0.9`
- `SaveCore` envelope game version: `0.9.0-campaign`
- network protocol: `4`

These may intentionally represent different concepts, but the mapping is undocumented and the title UI renders `TC.VERSION`. W26 must define semantics and reconcile user-visible/version-compat behavior without gratuitously breaking `requires.game`.

### A-004 — task-board snapshot label stale

**Severity:** Low/Medium documentation truth risk  
`docs/TASK_BOARD.md` still calls its status snapshot W20 while the body includes W25 truth. Terminal W26 must truth-sync the heading/state.

### A-005 — pack natural spawning absent

**Severity:** High feature completeness gap, not a regression  
Pack enemies are valid content but `enemyspawn.js` has no pack-rule extension seam. W26 should add a pure-data compiled rule index and deterministic merge into the canonical spawn authority.

### A-006 — production install/import workflow absent

**Severity:** High usability/productization gap, not a regression  
`provideJSON` is an API seam only. The browser cannot persist/install an arbitrary validated JSON pack through normal UX. W26 should add a versioned installed-manifest store and title-screen workflow with caps/corruption handling.

### A-007 — dedicated server cannot select/load packs

**Severity:** High multiplayer productization gap  
`tools/mp-server.js` supports seed/network tuning and fixtures, but not pack ids or manifest files. W26 must activate host packs before world creation and handshake identity.

### A-008 — pack family whitelist stops at W25 families

**Severity:** Medium intentional limitation  
`packs.js` explicitly whitelists `tiles`, `items`, `enemies`, `recipes`; tests verify unknown families fail. W26 must deliberately expand the whitelist and preserve fail-closed unknown-family behavior.

### A-009 — minor formatting/comment drift

**Severity:** Low  
Examples include indentation around `PacksChanged` in `events.js` and comments in network/world-region areas that still refer to earlier campaign/protocol state. Clean relevant drift during touched-file work; do not start a broad cosmetic rewrite.

### A-010 — runtime architecture does not justify another rewrite

**Severity:** Info / decision  
The current runtime, command, world-region, deterministic RNG, save and server-authority seams are coherent and heavily tested. Replatforming them would create risk without solving the observed production gaps. W26 is therefore an extension/integration campaign.

## Why W26 = Pack Ecosystem Productionization

The task board and W25 handoff list several future directions: more pack families, spawn integration, import/export UX, dedicated-server packs, localization, performance and >4-player scaling. The highest-value connected set is the pack ecosystem because all four missing pieces share the same W25 identity/security boundary and can be proven together end-to-end.

Selecting a broad visual/performance campaign now would leave the newly-built extensibility subsystem usable only through build-provided fixtures. Selecting executable mods would cross a much larger security boundary explicitly deferred by ADR. Selecting secondary localization would improve presentation but would not close the pack distribution/runtime gap.

W26 therefore targets:

1. walls + standalone loot tables;
2. durable validated JSON install/import/export/remove;
3. deterministic declarative natural-spawn rules;
4. dedicated server pack selection and real WebSocket parity;
5. version/docs truth-sync and exhaustive hardening.

## Key preserved measurements/invariants from W25/W21

Do not erase these baselines while implementing W26:

- W25 zero-pack registry fingerprint: `1b1d7c15`.
- W25 fixture gameplay digest: documented in W25 handoff as `97f8ff42`; full content digest `715306e0`.
- W25 full Node suite: 597 passing; browser: 30 passing; pack fuzz: 400 cases / seed `20260826` / zero escapes (documented terminal state).
- W21/W25 performance notes: runtime tick, exploration/idle tick, chunk rebuild and worldgen already have measured optimizations. W26 must record deltas rather than rewrite these paths speculatively.

## Planner limitations / executor obligation

The connected GitHub audit can inspect repository source/history and write the planning commit, but it is not a checked-out runtime and therefore cannot truthfully claim to have executed `npm run validate` at the planning head. The W25 handoff provides the last known green run. WS0 explicitly requires the executor to run a fresh baseline at its actual starting SHA before implementation and to stop/reconcile if that baseline contradicts the planner assumptions.

This limitation is why the execution prompt requires a local every-file coverage ledger and baseline gate before coding.

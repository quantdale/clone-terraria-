# W24 — Liquid & Wiring Completion: Pumps, Multiplayer Liquid Replication, Mechanism Authority & Stress Hardening

**Status:** COMPLETED  
**Planned-From:** `b6a14120a5ce3cb0e79775c2780a8913756de3ce`  
**Planned-At:** 2026-08-26  
**Completed-At:** 2026-08-26 (see docs/HANDOFF-W24-liquid-wiring-completion.md)  
**Target-Branch:** `main`
**Campaign-Type:** major implementation + integration + multiplayer parity + hardening  
**Execution entrypoint:** repository-native `goal` continuation (`/goal continue`, `continue`, or equivalent supported by the active harness)

## Mission

Finish the liquids epic by delivering **LIQ-006 pumps and wiring integration as a production gameplay system**, and close the authority/replication gaps that would otherwise make pumps or ordinary liquid mutations incorrect in multiplayer.

The end state is one canonical liquid authority (`TC.Liquids`) shared by single-player and the authoritative multiplayer host, with deterministic wire-driven inlet/outlet pumps, volume/type conservation, save compatibility, bounded processing, interest-managed liquid replication, and wiring mechanisms that correctly account for every registered player instead of only the primary `TC.player` singleton where gameplay semantics require all players.

Do not ship a host-only pump feature. A remote client must see the same liquid state after bucket use, natural settling, reactions, and pump transfer, and mechanism behavior must remain server-authoritative. Do not start the MOD epic, secondary-language catalog work, renderer migration, or unrelated content expansion in this campaign.

The campaign is complete only when the full acceptance gate passes, documentation/state is truth-synced, and the final planning prompt is marked COMPLETED with durable evidence.

## Planner reconciliation / evidence

The planner inspected current `main`, the completed W23 execution prompt and handoff, repository planner/goal protocol, task board, GitHub PR/CI state, package validation scripts, the authoritative liquid/wiring modules, multiplayer protocol/server/client region paths, and existing liquid/wiring/browser/network tests.

Current truth at planning time:

- `main` / `origin/main` is `b6a14120a5ce3cb0e79775c2780a8913756de3ce` (`docs(w23): truth-sync architecture/task-board/AGENTS/README + W23 handoff`).
- GitHub Actions run `32900241438` for that W23 head completed **successfully**. W23 reports `npm run validate` green with 552 headless tests and 28/28 browser journeys A–N.
- No open pull requests were observed.
- W23 is terminal/COMPLETED. Do not reopen or recreate its multiplayer transaction, targeting, RNG, prediction/interpolation, or baselined entity-replication work.
- `docs/TASK_BOARD.md` explicitly leaves **LIQ-006 — Pumps and wiring integration** TODO. LIQ-001..005 are already DONE. Other remaining families (real secondary-language catalogs, MOD-001..004, PERF-003/005, >4-player scale, optional region compression) are future campaigns unless required to satisfy a W24 invariant.
- `TC.Liquids` is already the sole runtime liquid authority. It stores type+amount layers, uses an active-set/budgeted settle simulation, handles water/lava contact, buckets, immersion, rendering, sparse SaveCore persistence, and marks `TC.WorldRegions` with reason `liquid` on mutations. Its public `set()` is explicitly documented as a seam for future spigots/migration tooling.
- `TC.Wiring` already has a bounded BFS pulse network (`PULSE_CAP`), switches/levers/plates/timers/dart traps/actuators, event-driven tile maintenance, persistence, and no core monkey patches. Its receiver set does **not** include pumps.
- Important multiplayer wiring gap discovered during planning: authoritative wiring code still has gameplay paths that enumerate/check only `TC.player` (notably pressure-plate entity collection and door close safety; audit trap-player contact and every other mechanism path too). W23 deliberately fixed multiplayer targeting elsewhere, but mechanism semantics still need a complete registered-player audit.
- Important multiplayer liquid gap discovered during planning: `TC.WorldRegions` sees liquid invalidations, but `TC.NetServer._regionLayers()` currently snapshots only **tiles + walls**; protocol full/delta region lines encode only those layers, and `TC.NetClient._applyRegionLine()` applies only tiles + walls. Therefore host liquid mutations can be authoritative yet remain visually/state-wise stale on joined clients. W24 must close this before LIQ-006 can be considered production-ready.
- Protocol version is currently **v2**. Because adding authoritative liquid type/amount layers changes the region wire representation materially, W24 should make this an explicit protocol revision (v3) with clean old-version rejection rather than silently changing v2 semantics.
- The canonical validation command remains `npm run validate` (`check` + `check:i18n` + all headless suites + release build/verify + Playwright).

Treat historical parity docs as clues if they disagree with live code. Current implementation, current tests, W23 handoff, and this prompt win.

## Non-negotiable preserved behavior

1. **One liquid authority only.** `TC.Liquids` remains the sole runtime authority for liquid type/volume. Do not reintroduce legacy WATER/LAVA tile simulation or create a second pump-specific liquid store.
2. **Server authority remains absolute in multiplayer.** Joined clients submit intents only. The host owns wiring pulses, pump transfer, liquid settling/reactions, bucket outcomes, world mutation, damage, and save state.
3. **Single-player stays the zero-network path.** Do not require a server/session for local play or add network work when no multiplayer session is active.
4. Preserve canonical `TC.Runtime -> TC.Systems -> TC.Commands` ordering. Do not add a second update loop or bypass canonical interaction/command paths for network convenience.
5. Preserve `TC.WorldRegions` multi-consumer independence. Renderer, lighting, minimap, networking, and any new liquid replication consumer cannot steal invalidations from each other.
6. Preserve W21–W23 bounded-work principles: no whole-world scan per tick, per pump pulse, or per replication tick; no unbounded queues; no all-region resend on every liquid change.
7. Preserve save compatibility. Existing worlds/saves must load. New content IDs must be additive and stable; never reorder/renumber existing registered IDs.
8. Preserve W20 localization rules. Every new user-visible pump name/description/feedback string needs catalog keys and must pass `check:i18n`.
9. Preserve deterministic gameplay. Pump endpoint ordering and liquid transfer outcomes must not depend on `Set` accident, object enumeration accident, wall-clock time, or `Math.random`. Gameplay randomness, if any is genuinely required, uses `TC.GameRng`; ideally pumps require none.
10. Joined client liquid state is a **mirror/presentation state**, not a second simulation authority. Do not let client-side settle/pump/reaction logic race server replication.
11. Preserve W23 protocol safety: strict bounded schemas, hostile-input rejection, monotonic sequencing, explicit resync, bounded payloads/backpressure, and clean version rejection.
12. Do not hide failures with blanket retries, arbitrary sleeps, timeout inflation, weakened assertions, swallowed errors, or test-only gameplay shortcuts.
13. No force-push, shared-history rewrite, or unrelated destructive cleanup.
14. If parallel agents are available, assign disjoint file/workstream ownership and one integration owner. Otherwise execute sequentially. Never allow agents to overwrite each other's repository state.

## Scope

### In scope

- LIQ-006 inlet/outlet pump gameplay and wiring integration;
- pump item/tile definitions, recipes, registry/localization/icons/rendering consistent with current procedural-content architecture;
- deterministic bounded liquid transfer across one powered wiring component;
- volume/type conservation, mixed-liquid safety, blocked/full-output behavior, and liquid reaction compatibility;
- multiplayer replication of authoritative liquid type+amount for initial sync, incremental updates, interest changes, reconnect/resync, settling, bucket operations, reactions, and pumps;
- protocol v3 region-layer schema/codecs and v2 rejection tests;
- multiplayer-authoritative wiring audit/fixes for pressure plates, doors, trap/player contact, and other mechanism paths that incorrectly assume only `TC.player`;
- save/load/backward-compatibility proof for new pump content and liquid/wiring state;
- deterministic replay/conservation tests, network adversarial tests, browser E2E, stress/benchmark evidence;
- truth-sync of `TASK_BOARD.md`, `ARCHITECTURE.md`, `AGENTS.md`, README where user-facing behavior changed, and a durable W24 handoff.

### Out of scope unless required by a W24 invariant

- MOD-001..004/resource packs/data packs/sandboxed mod API;
- additional real-language catalogs or RTL/font work;
- Canvas2D→WebGL/Pixi migration or unrelated visual overhaul;
- new bosses/biomes/weapons/NPC content unrelated to pump prerequisites;
- public matchmaking, NAT traversal, auth, relays/cloud hosting;
- >4-player scale work;
- binary transport rewrite or general region compression project beyond what is needed to keep W24 liquid replication bounded;
- NPC visual replication, chest drag parity, mana replication, or other W23 known limitations unrelated to liquids/mechanisms.

## Workstream 0 — Reconcile actual state before editing

Before implementation:

1. Fetch/prune/reconcile `main` with `origin/main`; inspect working-tree status, current HEAD, open PRs/issues relevant to W24, and any commits after `Planned-From`.
2. Read applicable `AGENTS.md`, `.agent/PLANNER_HANDOFF.md`, this prompt, `.agents/skills/goal/SKILL.md`, W23 handoff, `docs/TASK_BOARD.md`, relevant architecture sections, package scripts, and any native state/OpenSpec files present.
3. If post-plan work overlaps W24, classify every requirement as satisfied / partial / stale / open. Do not redo landed work.
4. Run the clean baseline gate before edits: `npm run validate`. If an environment stage is genuinely unavailable, record the exact blocker and run every narrower available gate.
5. Build a W24 ledger in the durable handoff/state mechanism with discovered defects, decisions, tests, benchmark numbers, and evidence as work proceeds.
6. Perform a whole-path audit of `TC.Liquids`, `TC.Wiring`, world mutation, region invalidation, protocol/server/client replication, SaveCore providers, item/tile registration, commands/interactions, and joined-client scheduler gates. Do not assume the planner's named gaps are exhaustive.

## Workstream 1 — Define and implement the pump gameplay contract

Deliver two explicit mechanism endpoints: **inlet pump** and **outlet pump**.

### 1.1 Content and placement

Add additive tile/item/recipe content following existing registry and wiring conventions.

Requirements:

- Stable item IDs and tile identities for inlet/outlet pumps; append only—never renumber old IDs.
- Use existing materials/stations for recipes; do not introduce unrelated resource trees.
- Pump cells may coexist with the independent liquid layer if the current tile semantics allow it; do not encode liquid inside pump tile IDs.
- Placement/mining/support/drop behavior follows existing mechanism conventions and canonical transactions.
- Procedural icon/render treatment must fit the current original-assets policy; do not import Terraria/Re-Logic assets.
- All displayable names/tooltips/feedback use localization keys.

### 1.2 Powered-component semantics

When a wiring pulse traverses one connected component, collect pump endpoints reached by that **same bounded pulse** and process them once as a deterministic batch after receiver discovery. Doors/traps/actuators keep existing once-per-pulse semantics.

Use an explicit deterministic ordering (for example ascending world cell index) for endpoints. Do not make transfer results depend on map/set insertion order.

A coherent v1 pump contract for this project:

- an inlet reads liquid from the liquid layer at its own tile coordinate;
- an outlet writes liquid to the liquid layer at its own tile coordinate;
- only endpoints reached by the same wire pulse may exchange volume;
- an inlet cannot create volume; an outlet cannot destroy volume except where the existing liquid reaction rules intentionally consume liquids to form a tile;
- transfer is bounded per pulse and by source volume/output capacity;
- empty outputs accept a type; partially filled outputs accept only the same type;
- incompatible liquid types never silently convert or overwrite each other;
- mixed-type inlet networks are processed deterministically and cannot duplicate, erase, or transmute volume through ordering tricks;
- blocked/solid/invalid endpoints fail closed and leave untransferred volume at the source;
- repeated receivers/endpoints reached through loops fire/process once per pulse;
- pump changes go through `TC.Liquids` mutation APIs so wakeups, `LiquidChanged`, `WorldRegions`, reactions/settling, rendering, and persistence remain coherent.

If implementation constraints justify a different source/sink cell convention, document the rationale before code lands and preserve all conservation/authority/replication acceptance criteria.

### 1.3 Boundedness

Pump processing must be bounded by the existing wire traversal cap plus an explicit endpoint/transfer budget. A pathological wire grid or pump farm cannot cause an unbounded world scan or quadratic all-pairs transfer.

Add counters/diagnostics sufficient to observe at least endpoints discovered, units moved, rejected/blocked endpoints, and cap hits in tests/benchmarks.

## Workstream 2 — Make liquid replication a first-class region layer

W24 must close the current tiles/walls-only network region gap.

### 2.1 Protocol v3

Treat liquid replication as a material protocol change:

- bump `TC.NetProto.VERSION` from 2 to 3;
- retain explicit, clean rejection of v1/v2/unknown versions;
- extend full-region representation to carry authoritative liquid **type + amount** layers;
- extend delta representation so a changed cell can update tile, wall, liquid type, and liquid amount without ambiguous omission semantics;
- validate all new arrays/hex fields/cell rows strictly with bounded lengths/ranges and reject malformed/oversize/unknown structures before mutation;
- keep deterministic encoding: identical region state yields identical bytes.

Do not trust client-supplied liquid state. No C→S message may directly declare authoritative type/amount.

### 2.2 Server baselines and interest management

Extend `TC.NetServer` region snapshots/baselines to include liquid state.

Requirements:

- initial join, interest entry, explicit resync, and reconnect receive complete liquid truth for streamed regions;
- incremental liquid mutations use baselined/delta region replication rather than unconditional full-layer resend;
- `TC.WorldRegions` reason `liquid` participates through the existing per-connection consumer without stealing other consumers' invalidations;
- baseline/ack bookkeeping includes liquid layers so a client cannot ACK tile/wall revision while retaining stale liquid for the same region;
- natural settling, bucket collect/place, water/lava reaction, pump transfer, and any authoritative `TC.Liquids.set/placeAt/collectAt` path converge remotely;
- interest exit/re-entry and keyframe/resync paths restore truth even after dropped/stale updates;
- outbound byte budgets/backpressure remain enforced.

Prefer a bounded read-only region snapshot seam on `TC.Liquids` (or equivalent) over exposing mutable raw arrays across modules.

### 2.3 Client mirror application

Extend `TC.NetClient._applyRegionLine()` (or its refactored equivalent) to apply liquid type/amount atomically with the corresponding region revision.

Requirements:

- full and delta region forms both apply liquid truth;
- mirror writes do not send gameplay events back to the server or create an echo loop;
- joined clients do not independently run authoritative liquid settling/pump/reaction mutation over the mirror;
- local rendering/minimap/lighting invalidation still notices applied liquid changes where appropriate;
- stale-generation / stale-sequence safeguards remain intact.

If the clean implementation needs a dedicated `TC.Liquids.applyMirrorRegion/applyMirrorCell` API, keep it presentation-only and explicitly separate from authoritative gameplay mutation APIs.

## Workstream 3 — Finish multiplayer authority for wiring mechanisms

Audit every gameplay-affecting `TC.player` use in `js/wiring.js` and related mechanism paths. Classify legitimate local/presentation ownership separately from authoritative world semantics.

At minimum fix and prove:

1. **Pressure plates:** every eligible registered live player can press/release a plate; a remote authoritative player is not invisible to the mechanism. Existing NPC/enemy behavior remains intact.
2. **Door close safety:** a wire pulse must not close a door into **any** live registered player's hitbox, not only the primary player.
3. **Trap damage:** pooled/fallback trap projectiles that can damage players must test the correct authoritative player set and apply damage exactly once to the actual victim; one player cannot redirect damage to the host/primary pawn.
4. **Actuators/collision:** multi-player collision semantics remain consistent when a host tile toggles ghost state.
5. **Timers/switches/levers:** networked interaction remains server-authoritative and exactly-once under duplicate/replayed command handling.

Use `TC.Players.entries()` or a small mechanism-appropriate player enumeration helper. Do **not** abuse `TC.Targets` for non-targeting semantics merely to avoid `TC.player`; `TC.Targets` remains the AI/target policy authority.

Single-player behavior must remain equivalent when only the primary player is registered.

## Workstream 4 — Persistence, identity, migration and localization

### 4.1 Content identity

New pump content makes an additive registry change. Therefore do **not** blindly assert the old W20 fingerprint remains the entire registry fingerprint.

Requirements:

- preserve every pre-W24 stable ID/mapping exactly;
- append new pump IDs deterministically;
- update the registry identity fixture/check intentionally so it proves old entries are unchanged and only the expected new entries were added;
- record old fingerprint `bdad6cfa` / 368 stable ids and the new fingerprint/count in the W24 handoff;
- fail the gate on accidental renumbering/deletion/rename of existing identities.

### 4.2 Save compatibility

- Pre-W24 v2/legacy-compatible saves must still load.
- Liquid provider data stays backward-readable. Do not bump a SaveCore provider version unless the serialized shape actually changes.
- Pump tiles/items survive save → reload with stable identity.
- Wiring runtime state continues to restore timers/actuators/ghosts. If pumps add no durable transient state, do not invent one; if schema changes, provide a migration and corruption tests.
- No joined client may become save owner; host save ownership from W22/W23 remains unchanged.

### 4.3 Localization

Add English catalog keys for every new displayable pump surface. Preserve pseudo-locale stress behavior and English fallback. `npm run check:i18n` must remain green with the intentionally updated identity baseline.

## Workstream 5 — Determinism, conservation and adversarial correctness

Add focused tests that prove invariants rather than only example outcomes.

### 5.1 Pump conservation matrix

Cover at least:

- one inlet → one outlet, exact volume conservation;
- one inlet → multiple outlets;
- multiple inlets → one/multiple outlets;
- partial source and partial destination;
- empty source / full output / solid or invalid endpoint;
- water, lava, honey independently;
- mixed liquid types on one powered component;
- loops/duplicate wire paths do not double-process an endpoint;
- water/lava contact still follows the existing canonical reaction rule rather than silently overwriting;
- large endpoint counts hit budgets deterministically without losing/creating volume.

For every non-reaction test, total per-type volume before and after must match exactly. Reaction tests must account explicitly for volume consumed into the existing resulting tile semantics.

### 5.2 Replay determinism

Given the same world/liquid state and identical sequence of wiring pulses/ticks, independent headless runs must produce identical pump/liquid state digests and event/counter traces. Different initial states must not collapse to a static fake digest.

### 5.3 Hostile protocol tests

Add protocol/network tests for malformed liquid layers/cell deltas: bad lengths, bad type/amount ranges, non-finite values, unknown fields where schema forbids them, oversize payloads, stale version, stale revision, and replay/reorder cases. Rejected data mutates nothing.

## Workstream 6 — Multiplayer integration and E2E proof

### 6.1 Headless two-client liquid convergence

Prove through the real server/client controllers:

- both clients join and receive identical initial liquid state in interested regions;
- an authoritative bucket operation changes server truth and the other client converges;
- natural liquid settling changes converge without full-world refresh;
- a pump pulse moves liquid once, server volume is conserved, and both clients converge to the same type+amount cells;
- water/lava reaction converges including the resulting world tile;
- disconnect/rejoin/resync restores the current liquid truth, not the join-time baseline;
- moving out of and back into interest restores current liquid truth;
- a delayed/slow client cannot stall server simulation or corrupt another client's liquid state.

### 6.2 Multiplayer mechanism proof

At least one non-primary player must:

- trigger a pressure plate through authoritative movement;
- cause a connected receiver/pump to fire exactly once on the rising edge;
- be protected by door close collision safety;
- receive trap damage as itself where applicable, without damaging the primary player instead.

### 6.3 Browser Journey O

Add a production-path Playwright journey over the real WebSocket host, following the A–N evidence style. It must visibly/diagnostically prove a coherent W24 story, for example:

1. two Chromium clients join the same world;
2. deterministic fixture/debug setup creates a small wired inlet/outlet pump rig and known liquid volumes through existing supported test seams;
3. the non-primary client activates/presses the mechanism through a real gameplay/network intent;
4. server transfer occurs once;
5. both browsers observe matching inlet/outlet liquid state and mechanism result;
6. one client disconnects, host changes liquid again, then rejoin/resync observes current truth;
7. shutdown is clean.

Use semantic diagnostics/assertions, not screenshot-only proof or arbitrary sleeps. If a new debug readout is required, keep it read-only and production-safe.

## Workstream 7 — Performance, stress and recovery

Extend existing benchmark/soak tooling rather than inventing an unrelated harness.

### 7.1 Liquid/pump stress benchmark

Add or extend `tools/bench-scenarios.js` with representative scenes:

- settled large pool / idle liquid;
- active settling cascade;
- many wired pump endpoints with repeated pulses;
- mixed pump + ordinary world edits.

Record before/after median tick/subsystem timings and active/backlog/cap counters. There must be no whole-world-per-tick behavior and no unexplained material regression in unchanged scenes.

### 7.2 Multiplayer bandwidth benchmark

Extend `tools/bench-multiplayer.js` with at least:

- idle two-player scene (must retain W23 idle suppression; no liquid changes must not create periodic liquid spam);
- bounded liquid-settling churn;
- pump-burst scene;
- interest leave/re-entry/resync liquid scene.

Report bytes/s and message/region counts before/after where comparable. Liquid deltas must respect configured byte budgets; do not solve W24 by sending full liquid regions every replication tick.

### 7.3 Soak/fuzz

Run seeded soak/fuzz with repeated pump pulses, settling, bucket operations, region interest movement, reconnect/resync, and malformed/stale messages. Assert deterministic final digests/counters where appropriate, no negative/overflow liquid amounts, no volume creation, bounded queues, and leak-free teardown.

## Workstream 8 — Documentation and durable handoff

Before completion, truth-sync:

- `docs/ARCHITECTURE.md`: add a W24 section describing pump semantics, liquid authority, protocol v3 liquid-region format, client mirror boundary, wiring player-enumeration rule, boundedness, and evidence map;
- `docs/TASK_BOARD.md`: mark LIQ-006 DONE only if acceptance is proven; replace stale W24 follow-ups with actual remaining work;
- `AGENTS.md`: update module/API contracts and contributor rules for pumps/liquid replication/protocol v3; preserve the `TC.GameRng`, `TC.Targets`, `WorldRegions`, localization, and stable-ID rules;
- `README.md` only where player-visible pumps/multiplayer liquid behavior should be documented;
- `.agent/EXECUTION_PROMPT.md`: set `Status: COMPLETED` only after the completion gate passes and point to the W24 handoff;
- `docs/HANDOFF-W24-liquid-wiring-completion.md`: durable report with starting/final SHAs, reconciliation, defects/root causes, design decisions, protocol change, identity/fingerprint delta, migrations, tests, browser evidence, benchmark numbers, CI result, remaining limitations, and exact next-campaign candidates.

Do not mark unrelated MOD/performance/localization follow-ups DONE.

## Required validation

At minimum execute and preserve evidence for:

```text
npm run check
npm run check:i18n
npm run test:world
npm run test:net
npm run test:core
npm test
npm run build
npm run verify:build
npm run test:browser
npm run validate
```

Also run the W24 benchmark/soak commands added or extended by this campaign.

Targeted suites must include the existing liquid boundary/bucket/wiring coverage plus new pump, liquid-network, mechanism-multiplayer, protocol-v3, save/identity and Journey O coverage.

If a test exposes a pre-existing Critical/High defect that blocks W24 correctness, root-cause and fix it in scope. Do not opportunistically refactor unrelated systems.

## Acceptance criteria

W24 is complete only when **all** of the following are true:

1. LIQ-006 has functional inlet/outlet pumps wired into the canonical mechanism system.
2. A powered connected component discovers/processes pump endpoints once, deterministically, within explicit caps.
3. Pump transfers preserve exact liquid volume/type except canonical water/lava reaction consumption, with no duplication/transmutation exploits.
4. Pump mutations use `TC.Liquids`; no parallel liquid store/simulator exists.
5. Protocol is explicitly revised to v3 for liquid-region truth, with clean v1/v2/unknown rejection.
6. Initial snapshot, incremental region delta, interest entry, reconnect and resync all carry correct liquid type+amount.
7. Joined clients mirror authoritative liquid state and do not independently mutate it through settlement/pumps/reactions.
8. Bucket, natural settling, reaction and pump changes converge on two real clients.
9. Pressure plates, door safety and trap/player contact operate on the correct registered player set; non-primary players are proven.
10. Existing single-player wiring/liquid behavior remains green.
11. Existing stable content IDs are unchanged; pump IDs are additive; identity fixture/fingerprint is intentionally updated with proof.
12. Pre-W24 saves load; pump content and relevant liquid/wiring state round-trip correctly.
13. New user-visible text is localized and pseudo-locale/fallback rules remain intact.
14. Hostile protocol inputs fail closed and mutate nothing.
15. Deterministic pump replay and conservation matrices pass.
16. W24 stress tests show bounded work/queues and no whole-world-per-tick/pulse regression.
17. Multiplayer benchmark shows no idle liquid spam and bounded liquid-churn/pump bandwidth under existing byte budgets.
18. Browser Journey O passes over the real WebSocket host and proves non-primary mechanism activation + liquid convergence + rejoin truth.
19. Full `npm run validate` passes on the final implementation head with no known Critical/High regressions.
20. Documentation/task board/AGENTS/README are truth-synced and W24 handoff records real evidence, not planned claims.
21. Working tree is clean, `main` is reconciled with `origin/main`, all W24 commits are pushed, and the pushed final head's GitHub Actions result is checked. If CI fails, root-cause and repair before marking COMPLETED unless a genuine external blocker is documented.

## Completion gate / stopping rule

- **COMPLETED:** every acceptance criterion above is proven. Mark this prompt COMPLETED, write the W24 handoff, commit/push final truth-sync, then stop. Do **not** automatically begin MOD-001 or another campaign.
- **BLOCKED:** only for a genuine external blocker that cannot be solved in-repo. Record exact blocker, evidence, partial work, and the first resumable action; commit/push safe partial state if repository policy permits.
- **ACTIVE:** if any material acceptance criterion remains, continue autonomously from the first genuinely incomplete requirement. Do not stop after “core pumps work” while replication, multiplayer mechanisms, save compatibility, benchmarks, Journey O, or the final gate remain open.

## Git / integration requirements

1. Work on `main` as repository policy/history currently does; reconcile remote changes before each push.
2. Keep commits coherent by workstream (pump core, liquid replication/protocol, mechanism multiplayer parity, tests/benchmarks, docs/handoff) rather than one opaque mega-commit where practical.
3. Never force-push.
4. Never discard unrelated user work.
5. If concurrent agents contribute, integration owner must rebase/reconcile intentionally and rerun affected tests after each merge/cherry-pick.
6. Final commit message/handoff must include the full campaign evidence summary: root causes, behavior added, protocol/identity changes, validation counts, benchmark/soak results, remaining known limitations, and final SHA.

## Executor final report

When done, report succinctly:

- start SHA → final SHA and pushed branch;
- W24 commits/workstreams landed;
- pump semantics and liquid-conservation proof;
- protocol v3/liquid-replication design and multiplayer convergence proof;
- wiring multiplayer authority fixes;
- old→new registry fingerprint/count and save compatibility result;
- exact test/Playwright counts and `npm run validate` result;
- benchmark/soak numbers and any justified regressions;
- GitHub Actions result;
- remaining deferred work and the best candidate for the next planner campaign.

# W23 — Multiplayer Productionization: Gameplay Parity, Latency, Determinism & Scalable Replication

**Status:** COMPLETED  
**Planned-From:** `1fa43f4bdbbd5d38f98fb143d51927f416df7b80`  
**Completed-At:** 2026-08-26 (see git log; base after reconciliation `d87523f`)  
**Evidence:** docs/HANDOFF-W23-multiplayer-productionization.md — all acceptance
criteria proven: protocol v2 craft/shop/container parity, TC.Targets policy,
TC.GameRng replay determinism (enemy AI included), interpolation/prediction,
NET-004 productionized (-66% idle-2p outbound), 4-player + soak + journey N
evidence, full `npm run validate` green on final head.
**Target-Branch:** `main`  
**Campaign-Type:** major implementation + integration + hardening  
**Execution entrypoint:** repository-native `goal` continuation (`/goal continue`, `continue`, or equivalent supported by the active harness)

## Mission

Productionize the W22 authoritative multiplayer slice into a robust, latency-tolerant, systemically fair **2–4 player** gameplay path without weakening the server-authority contract or regressing single-player behavior.

This is not a networking rewrite. Build directly on `TC.NetProto`, `TC.NetTransport`, `TC.NetServer`, `TC.NetClient`, `TC.Players`, `TC.WorldRegions`, `TC.Runtime`, `TC.Systems`, and `TC.Commands`. Close the user-visible gameplay gaps that remain after W22, then make replication and client presentation production-worthy under realistic latency/jitter and multi-client load.

Do not stop after one coherent subset while material requirements below remain. The campaign is complete only when the full acceptance gate passes or a genuine external blocker is documented.

## Planner reconciliation / evidence

The planner inspected current `main`, recent W18–W22 history/diffs, repository instructions/state files, `docs/TASK_BOARD.md`, `docs/ARCHITECTURE.md`, the W22 handoff, parity backlog, current network/runtime/command/AI source seams, test commands, PR state, and live GitHub Actions.

Current truth at planning time:

- `main` / `origin/main` head observed at `1fa43f4bdbbd5d38f98fb143d51927f416df7b80` (`feat(w22): authoritative multiplayer foundation & two-client vertical slice`).
- GitHub Actions run `32865521488` for that head completed **successfully**.
- No open PRs were observed for the repository.
- W22 delivered the correct authority boundary, hostile protocol validation, two-client join/move/mine/place/combat/inventory/rejoin proof, private WorldRegions consumers, and a real WebSocket browser journey. Do **not** recreate those foundations.
- `TC.Commands` already exposes canonical `CraftRecipe`, `ShopBuy`, and `ShopSell`, but protocol v1's network whitelist currently includes only MineTile/MineWall/PlaceTile/PlaceWall/UseItem/MoveItem/EquipItem/InteractTile. The server's `_execCommand` likewise has no network-safe mapping for crafting/shop operations. Treat this as a real multiplayer gameplay-parity gap, not a reason to bypass transactions.
- Network MoveItem currently resolves both inventory endpoints to the acting player's inventory. Audit chest/container transfer flows and close any remote-player transaction gap through server-resolved authority rather than client-provided object references.
- `enemyai.js` still uses `TC.player` throughout archetypes and explicitly treats `Math.random` as gameplay randomness. In multiplayer this means target selection remains primary-player-centric and full replay determinism excludes enemy AI. Audit every authoritative `TC.player` assumption and every gameplay-affecting `Math.random` use across the runtime, not just the first matches.
- `TC.NetClient` applies authoritative local/remote player and enemy poses by direct assignment (`x/y/vx/vy` hard snaps). Loopback/LAN hides this; it is not sufficient under meaningful RTT/jitter.
- `TC.NetServer.replicate()` sends a `worldupd` every tick containing full player/enemy/drop snapshot arrays even when little changed. Region cells are baselined deltas, but entity replication is not. W22 measured ~86 KiB/s outbound for two steady-state clients at 60 Hz.
- NET-004 is explicitly only a prototype. Open W22 follow-ups include prediction/interpolation, multi-target AI, seeded runtime RNG, crafting/shop networking, payload compression, priority queues, interest tuning, and configurable detach grace.
- The repository's canonical validation command remains `npm run validate` (syntax + i18n + all headless suites + release build/verify + Playwright browser suite).

Treat historical parity/audit docs as clues where they conflict with live code. Live implementation/tests/current handoffs win.

## Non-negotiable preserved behavior

1. **Server authority remains absolute.** Clients send input/intents, never authoritative position, damage, inventory, loot, world mutation, prices, recipe validity, station proximity, NPC stock, or progression results.
2. **Single-player remains the degenerate zero-network path.** Do not make ordinary local play require a session/server, and do not add networking overhead when no multiplayer session is active.
3. Preserve current world/save compatibility unless a migration is strictly required and proven. Joined clients still cannot save a mirror; the host remains save owner.
4. Preserve stable registry identity/fingerprint semantics and W20 localization identity rules. Any new user-visible text gets catalog keys and must pass `check:i18n`.
5. Preserve canonical `TC.Runtime -> TC.Systems -> TC.Commands` ordering and transaction ownership. No parallel mutation path may be added for multiplayer convenience.
6. Preserve `TC.WorldRegions` multi-consumer independence. Networking must never steal renderer/lighting/minimap invalidations.
7. Preserve W17–W22 gameplay behavior and browser assertions unless a behavior change is intentional, documented, and covered by stronger acceptance evidence.
8. Do not hide regressions with blanket retries, arbitrary sleeps, broad timeout inflation, disabled assertions, swallowed failures, or test-only gameplay shortcuts.
9. Do not force-push, rewrite shared history, or discard unrelated user work.
10. Do not assume a particular model, agent harness, or sub-agent system. If parallel execution is available, use disjoint ownership with one integration owner; otherwise execute sequentially.

## Scope / out of scope

### In scope

- authoritative multiplayer transaction parity for normal shared-world gameplay;
- multi-player-aware enemy/boss targeting and other primary-player assumptions that materially affect gameplay;
- deterministic gameplay RNG for authoritative runtime decisions needed to bring enemy/session replay under deterministic test coverage;
- local movement prediction/reconciliation and remote entity interpolation suitable for realistic RTT/jitter;
- productionization of NET-004: compact/baselined entity replication, region prioritization, interest tuning, bounded backpressure/work budgets, explicit removals/tombstones, and measurable bandwidth reduction;
- 2–4 player session behavior, reconnect/resync, host options needed by the above;
- adversarial, latency/jitter, deterministic replay, soak/fuzz, real-WebSocket browser, and benchmark coverage;
- docs/task-board/architecture/AGENTS/README truth-sync and durable W23 handoff.

### Out of scope unless required to satisfy an in-scope invariant

- public matchmaking, NAT traversal, accounts/authentication, relay infrastructure, cloud hosting;
- MMO-scale player counts;
- client-authoritative shortcuts or anti-cheat beyond the existing authoritative design;
- unrelated content expansion, graphics/audio overhaul, modding/resource packs;
- wholesale framework/bundler migration;
- arbitrary third-party networking dependencies or a binary-protocol rewrite without benchmark evidence that the existing transport boundary cannot meet the campaign targets.

## Workstream 0 — Reconcile actual state before editing

Before implementation:

1. Fetch/prune/reconcile `main` with `origin/main`; inspect status, current HEAD, open PRs/issues relevant to W22/W23, and any commits that landed after `Planned-From`.
2. Read applicable `AGENTS.md`, `.agent/PLANNER_HANDOFF.md`, this file, W22 handoff, `ARCHITECTURE.md` §26, current TASK_BOARD, package scripts, and native state/OpenSpec files if present.
3. If work after `Planned-From` overlaps this campaign, classify each requirement as already satisfied, partially satisfied, stale, or still open. Do not redo landed work.
4. Run the clean baseline gate before edits. At minimum run `npm run validate`; if environment prevents a stage, capture the exact blocker and still run every available narrower gate.
5. Build a fresh W23 ledger (repo-native task/OpenSpec/state format if one exists; otherwise track it in the W23 handoff as work proceeds) containing:
   - confirmed W22 follow-ups;
   - stale/superseded follow-ups;
   - newly discovered defects from whole-codebase audit;
   - external blockers;
   - evidence for every checked/completed item.
6. Perform a **whole-codebase impact audit**, not merely a W22-file review. In particular search all authoritative gameplay modules for direct `TC.player` assumptions, gameplay-affecting nondeterminism, transaction bypasses, save/session leakage, and presentation code that could accidentally mutate authority.

## Workstream 1 — Close authoritative gameplay-transaction parity gaps

Make networked gameplay use the same canonical transactions that single-player uses.

### 1.1 Command capability audit

Create a table of `TC.Commands.names()` versus:

- local UI/player call sites;
- network whitelist/schema support;
- server-side safe context reconstruction;
- required client feedback/refresh behavior;
- headless + browser coverage.

Do not assume the planner's named gaps are exhaustive.

### 1.2 Crafting

Add a safe network form of `CraftRecipe`.

Requirements:

- Client sends only bounded stable intent data (for example a stable recipe identifier plus no client-trusted station/progression truth).
- Server resolves the recipe from canonical data, acting player's inventory, live nearby stations/environment, and progression conditions.
- Duplicate/replayed/stale command sequences craft at most once.
- Invalid recipe ids, missing ingredients, missing stations, progression locks, full inventory, malformed fields, and spoof attempts mutate nothing.
- Successful craft produces immediate truthful inventory/UI feedback; do not wait for an arbitrary periodic refresh if that creates stale UX.

### 1.3 Shops

Add safe network forms for `ShopBuy` and `ShopSell`.

Requirements:

- Server owns NPC/shop identity validation, stock, prices, progression gates, player proximity/interaction eligibility, currency, slot/count validation, and inventory capacity.
- Client never declares a trusted price or stock row.
- Exactly-once currency/item conservation holds under duplicate/reorder/reconnect cases.
- Selling currency or invalid items continues to fail closed as local transactions require.

### 1.4 Containers / inventory routes

Audit chest/container gameplay. Current network `MoveItem` forces both endpoints to the acting player's inventory; if remote chest transfer is therefore incomplete, implement a bounded server-authorized container reference/session mechanism rather than allowing arbitrary inventory selection.

Acceptance must prove:

- a remote client can open an eligible container through canonical interaction;
- transfer player↔container and relevant quick-transfer paths conserve items exactly;
- one client cannot mutate another player's inventory or a container it is not authorized/reachable to use;
- disconnect/close invalidates stale container authority cleanly.

### 1.5 Protocol safety

If the wire schema changes materially, version it explicitly. Either:

- evolve v1 compatibly with strict new payload validation; or
- bump protocol version and provide explicit clean version rejection.

Never silently accept unknown payload fields or arbitrary nested client objects.

## Workstream 2 — Make authoritative gameplay genuinely multi-player-aware

W22 made contact damage/projectiles/pickups multi-player-aware but enemy behavior still commonly targets the primary pawn.

### 2.1 Canonical target selection

Introduce or formalize one deterministic target-selection service/policy used by enemy AI instead of direct `TC.player` access where targeting is intended.

At minimum support:

- eligible live players only;
- distance/visibility/encounter constraints appropriate to existing behavior;
- deterministic tie-breaking by stable player identity;
- target stickiness/hysteresis so enemies do not thrash every tick;
- boss-specific override policies where needed;
- graceful no-target behavior;
- single-player behavior equivalent to the current primary-player path.

Do not mechanically replace every `TC.player`; classify uses. UI/camera/local-input ownership may correctly remain primary/local. Authoritative enemy/spawn/encounter decisions must not accidentally do so.

### 2.2 Audit broader primary-player assumptions

Inspect at least enemy AI, enemy spawning/zone placement, boss lifecycle/despawn, hostile projectile aim, NPC/world events, loot/pickup eligibility, interaction reach, and any runtime systems that use `TC.player` in gameplay decisions.

Fix only semantics that should be multi-player-aware, but document deliberate primary-player-only uses.

### 2.3 Multiplayer death/rejoin/encounter edge cases

Prove sensible behavior when:

- current target dies;
- host dies while a remote player lives;
- remote target disconnects and later rejoins;
- players occupy different regions/biomes;
- a boss/encounter is active during target loss.

No boss or enemy should despawn merely because the legacy primary pawn died if another eligible player should sustain the encounter.

## Workstream 3 — Deterministic authoritative gameplay RNG

Bring gameplay-affecting runtime randomness under a deterministic service without forcing cosmetic randomness into lockstep.

### 3.1 Audit/classify randomness

Search the whole repository for `Math.random`, timestamp-derived randomness, and equivalent entropy sources. Classify every occurrence as:

- authoritative gameplay outcome;
- world generation (already deterministic contract; preserve its existing model unless required);
- cosmetic/presentation-only;
- identifier/session entropy that does not affect replayed gameplay state.

### 3.2 Runtime RNG authority

Implement a small explicit deterministic RNG authority for gameplay runtime decisions. Prefer named subsystem streams or another design that avoids unrelated cosmetic/order changes perturbing combat/AI outcomes.

Requirements:

- seed derives deterministically from authoritative session/world state;
- gameplay AI/spawn/loot/other runtime decisions that affect replicated truth use it;
- renderer/particles/audio may remain nondeterministic if they cannot mutate gameplay state;
- resetting/loading/starting a world/session resets RNG state intentionally;
- no joined client simulation depends on locally generating authoritative random outcomes.

### 3.3 Determinism proof

Extend replay/state digests so two independent authoritative realms with the same seed + command/input trace converge including enemy AI/spawn outcomes covered by the new RNG authority.

Run enough ticks and events to prove this is not a trivial static digest.

## Workstream 4 — Latency masking without weakening authority

### 4.1 Remote interpolation

Stop rendering remote players/enemies as raw hard snaps.

Implement a bounded authoritative snapshot buffer keyed by server tick/time and interpolate presentation transforms between snapshots. Define explicit behavior for:

- spawn/first sight;
- normal motion;
- packet jitter/late snapshots;
- teleport/large correction thresholds;
- death/removal;
- resync/reconnect/world change.

Interpolation is presentation only. It must not feed authoritative collision, combat, inventory, or world mutation.

### 4.2 Local movement prediction + reconciliation

Add conservative prediction for the local joining player's locomotion so normal movement feels responsive under non-zero RTT.

Requirements:

- server remains authoritative;
- retain an input history keyed to client sequence/server tick;
- authoritative snapshots acknowledge/correct predicted state;
- small errors reconcile smoothly; large/divergent errors snap or converge under an explicit bounded policy;
- prediction must not predict authoritative mining results, loot, damage, inventory, crafting, or world mutation;
- collision/world edits that invalidate prediction reconcile safely;
- resync/reconnect flushes stale prediction history.

Reuse canonical movement/collision semantics where practical; do not create a permanently divergent second physics engine.

### 4.3 Network-condition harness

Extend deterministic test transport tooling to model latency, jitter, duplication, reorder, temporary stall, and disconnect/reconnect while preserving controllable/manual pumping.

Use it to prove correction and interpolation behavior rather than relying on arbitrary sleeps.

## Workstream 5 — Productionize replication / NET-004

### 5.1 Entity delta protocol

Replace unconditional full entity arrays per tick with per-connection baselined replication for stable player/enemy/drop identities.

Requirements:

- stable ids for every replicated entity class; add a stable drop identity if current drops cannot support deltas/removal safely;
- send only changed fields under a bounded schema;
- explicit spawn and removal/tombstone semantics;
- periodic/keyframe recovery or explicit resync path so lost/stale baselines cannot become permanent corruption;
- no ghost entities after leaving interest, death, pickup, disconnect, or resync;
- deterministic encoding for identical state/baseline.

### 5.2 Replication cadence

Decouple presentation replication cadence from the authoritative 60 Hz simulation where beneficial. Preserve authoritative tick stamps so interpolation/reconciliation has correct timing.

Input sampling may remain high-rate; outbound entity/world updates should be evidence-driven. Avoid empty `worldupd` spam when no state requiring delivery changed.

### 5.3 Region payload productionization

Build on the existing WorldRegions private-consumer model:

- prioritize changed regions by player relevance (distance, newly entered interest, reason/recency as appropriate);
- ensure dirty interested regions cannot starve behind off-interest backlog;
- tune configurable interest radius/budgets from measured evidence;
- compact full-region payloads beyond raw hex when a simple deterministic no-dependency encoding materially reduces bytes;
- keep delta/full snapshot logic fail-closed and bounded;
- preserve renderer/lighting/minimap consumer independence.

### 5.4 Backpressure and bounded work

Ensure slow clients cannot cause unbounded queues/memory growth or monopolize server tick work.

Define and test bounded policies for:

- inbound inbox;
- pending commands;
- snapshot/resync queues;
- dirty region/entity replication queues;
- transport buffering where observable;
- disconnect/drop/resync behavior when limits are exceeded.

### 5.5 Host/session tuning

Make at least the already-deferred detach grace and interest/rate/budget knobs configurable through stable server options. For the Node dedicated host, expose practical CLI flags where appropriate and document defaults.

Keep defaults safe and deterministic. Do not expose settings that let a client grant itself authority.

## Workstream 6 — 2–4 player systemic integration

The W22 proof is two-client. W23 must establish that the architecture scales coherently to four active players without special-casing a single remote.

Exercise overlapping and separated interest regions, simultaneous mutations, combat, inventory/economy transactions, target switching, one client disconnect/rejoin, and one slow/stalled client while others continue.

Any shared-world mutation must remain exactly once and converge for all interested clients.

## Workstream 7 — Testing, adversarial validation, soak and benchmarks

### Headless tests

Add/extend deterministic suites for at least:

1. protocol schemas/versioning for all new message/command forms;
2. craft/shop/container transaction parity and malicious client contexts;
3. duplicate/stale/reordered command exactly-once invariants;
4. multi-player enemy target selection and target-loss transitions;
5. authoritative RNG replay determinism including enemy AI/spawn behavior;
6. local prediction/reconciliation under latency/jitter and collision corrections;
7. remote interpolation buffer behavior, teleports, removals, resync;
8. entity delta spawn/change/remove/keyframe/resync semantics;
9. region priority/interest crossing/starvation resistance;
10. bounded queue/backpressure behavior;
11. four-player convergence and one-slow-client isolation;
12. disconnect/rejoin with in-flight inputs/commands and stale-generation rejection.

### Browser / E2E

Keep journey M green and add a new real-browser multiplayer journey (journey N or the repository's next naming convention) over the real Node WebSocket host.

It must exercise production UI/input paths, not direct gameplay mutation hooks. At minimum prove:

- two real Chromium clients join the same host;
- a remote client performs one newly networked transaction path (craft/shop and, if applicable, chest/container transfer);
- enemies can legitimately target a non-primary player and both clients observe coherent results;
- remote entity motion is rendered through interpolation rather than visible fixed-rate teleporting (assert via exposed diagnostic state/tick buffers, not fragile pixel timing alone);
- reconnect/resync remains coherent;
- server shutdown returns clients cleanly.

If browser network throttling for WebSockets is unreliable, keep latency/jitter proofs in deterministic transport tests and use browser E2E for the real transport/UI boundary.

### Deterministic soak/fuzz

Add a bounded seeded multi-client soak/fuzz scenario long enough to catch lifecycle/queue/replication leaks (for example tens of thousands of authoritative ticks, not a token 100-tick smoke). Randomized actions must be driven by a test seed and produce reproducible failure traces.

Track at minimum:

- final world/player/inventory/progression digests;
- duplicate/lost mutation counts;
- active/detached player/entity/consumer counts;
- queue high-water marks;
- bytes/messages sent;
- resync count;
- memory/collection counts where cheaply observable.

### Benchmarks

Extend `tools/bench-multiplayer.js` (or a clearly named successor) with repeatable scenes:

- idle 1/2/4 players;
- simultaneous movement 2/4 players;
- separated-interest exploration;
- mining/building burst;
- combat with multi-target AI;
- craft/shop/container transaction burst;
- reconnect/resync churn;
- one slow client/backpressure;
- prediction/interpolation CPU overhead where measurable.

Record W22's ~86 KiB/s two-client steady-state outbound baseline alongside W23 results.

Performance acceptance:

- demonstrate a **material reduction** in steady-state two-client outbound bandwidth (target at least ~35% versus W22 unless a stronger measured constraint is discovered and documented);
- four-client steady state must remain bounded and scale approximately with interested state rather than blindly multiplying full snapshots;
- no newly introduced scene may show an unexplained >15% authoritative tick-time regression versus its reconciled baseline;
- no unbounded queue/memory growth during the soak/backpressure scenarios.

Do not game these numbers by reducing correctness, interest coverage, or update semantics without documenting the tradeoff.

## Workstream 8 — Documentation / truth sync

Before completion, update repository truth to match implementation:

- `docs/ARCHITECTURE.md` — add W23 contracts (targeting, gameplay RNG, protocol/replication changes, prediction/interpolation boundary, host tuning, failure/backpressure behavior, benchmarks);
- `docs/TASK_BOARD.md` — reconcile stale status headings and NET-004/follow-ups against actual W23 results; distinguish DONE from remaining prototype/future work;
- `AGENTS.md` — update module/public-contract tables and multiplayer rules so future agents do not reintroduce primary-player or client-authority regressions;
- `README.md` — current multiplayer usage, limits, dedicated-host options, protocol compatibility as appropriate;
- add `docs/HANDOFF-W23-multiplayer-productionization.md` with the durable completion evidence required below;
- update this file's `Status` to `COMPLETED` only when every completion criterion is proven; use `BLOCKED` only for a genuine blocker with reproducible evidence.

## Acceptance criteria

W23 is complete only if all applicable items are true:

1. Clean/reconciled `main` baseline was established and post-`Planned-From` work was not overwritten or duplicated.
2. Every user-facing canonical mutation reachable in the multiplayer slice has an explicit network disposition; crafting and shops are server-authoritative and working, and container transfer is either implemented safely or proven already complete with evidence.
3. Remote clients cannot choose another player's inventory, forge shop prices/stock, bypass recipe/station/progression requirements, or cause duplicate/lost inventory/currency under replay/reorder/reconnect.
4. Enemy/boss targeting is multi-player-aware through a canonical deterministic policy; direct primary-player assumptions that remain are deliberately classified and documented.
5. Gameplay-affecting runtime randomness required for enemy/session determinism uses the authoritative RNG contract; identical seed + trace replay now includes relevant enemy AI/spawn outcomes.
6. Remote players/enemies interpolate authoritative snapshots; local joining-player locomotion uses bounded prediction/reconciliation under non-zero latency while the server remains authority.
7. NET-004 is no longer merely the W22 prototype: entity state is delta/baseline driven with correct spawn/removal/resync semantics, region delivery is prioritized/bounded/configurable, and empty/full-snapshot spam is materially reduced.
8. Two-to-four-player shared-world scenarios converge correctly under simultaneous actions, separated interest, one slow client, disconnect and rejoin.
9. No queue, consumer, detached identity, mirror entity, or prediction history leaks across world/session teardown.
10. New network surfaces remain strict/fail-closed under malformed/oversize/wrong-direction/spoofed/stale payloads.
11. Single-player behavior, save compatibility, registry identity, localization contract, world determinism, runtime scheduling, and WorldRegions consumer independence remain intact.
12. Required new headless, browser, replay, soak/fuzz, and benchmark evidence exists and is documented.
13. `npm run validate` passes on the final intended head. Relevant new network suites are also repeated enough to demonstrate stability without retries masking flakes.
14. No known Critical/High regression remains. Any lower-severity limitation is explicitly documented with rationale and follow-up.
15. Final GitHub Actions for the pushed W23 head is green, or an external CI outage/blocker is demonstrated with local full-gate evidence and exact run/status details.

## Completion gate / Git requirements

Repository policy for this campaign is **main-only at completion**.

1. Before editing, fetch/prune and reconcile with `origin/main` without destructive history rewriting.
2. Preserve unrelated user changes; never reset/checkout them away.
3. Use logical commits during implementation when helpful. Commit messages should explain root cause/contracts/tests, not just filenames.
4. Before final push:
   - inspect the full diff from the reconciled base;
   - remove scratch probes/artifacts not intentionally tracked;
   - run the full validation gate;
   - ensure documentation and handoff are truthful to what was actually run.
5. Re-fetch/reconcile `origin/main`; resolve concurrent upstream changes safely. Never force-push.
6. End on local `main` with all intended W23 commits pushed to `origin/main`.
7. Verify `HEAD` equals `origin/main` and the worktree is clean.
8. Verify the remote commit SHA and inspect the corresponding GitHub Actions result. If CI fails, root-cause from logs/artifacts/annotations and repair material campaign-related failures before claiming completion.
9. Do not auto-merge unrelated PRs or close unrelated issues as cleanup.

## Final handoff must report

The durable W23 handoff and final commit message must include:

- starting SHA and final SHA;
- reconciliation findings, including anything already landed after `Planned-From`;
- exact root causes and fixes for newly discovered defects;
- protocol/authority changes and compatibility/version behavior;
- command capability matrix outcome (including craft/shop/container disposition);
- multiplayer targeting policy and deliberate primary-player-only exceptions;
- RNG contract and replay-determinism evidence;
- prediction/interpolation design, correction thresholds/buffer policy, and latency-test evidence;
- entity/region replication design and before/after bandwidth/tick-time table;
- 2/4-player, slow-client, reconnect, and soak/fuzz evidence;
- save/registry/localization compatibility evidence;
- tests actually run and exact results;
- browser E2E evidence;
- GitHub Actions run/result;
- known limitations / deliberately deferred work;
- final clean-worktree and `main == origin/main` verification.

## Stop condition

Only mark this campaign `COMPLETED` when the acceptance criteria and completion gate are satisfied. If a genuine external prerequisite makes completion impossible, mark `BLOCKED` with exact evidence, preserve all validated progress, push a truthful handoff, and stop. Otherwise continue from the first incomplete requirement.

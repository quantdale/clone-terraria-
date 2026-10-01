# Design — fix-player-registry-world-transition

## Context

Three modules share responsibility for player identity, and their contract is
currently enforced only by convention:

| Module | Role today |
|---|---|
| `js/players.js` | Owns the registry (`entries` Map, `primaryId`, `nextOrdinal`), the `TC.player` alias, and `resetForNewWorld` / `retainOnly` / `remove`. |
| `js/main.js` | Owns browser world transitions (`newGame`, `continueGame`, `quitToTitle`) and drives the movement system from `TC.Players.all()` when the registry is non-empty. |
| `js/runtime.js` | Owns headless world creation (`createWorld`) and full teardown (`reset`), and emits `WorldLoaded`. |
| `js/netserver.js` | Owns session membership: `attachLocal` seats the host primary (`p1`), `stop` retains the local primary and drops remotes. |

Two facts create the defect:

1. `js/players.js` documents the intended rule — *"World swap: entities die
   with the old world object graph. The host re-registers whoever survives the
   transition."* — and ships `resetForNewWorld()` to implement it. That function
   is exercised only by `tests/net/players.test.js`; no production path calls
   it.
2. `js/main.js` and `js/runtime.js` construct a new `Player` and assign it to
   `TC.player` directly, with no registry participation at all. In a session
   that never hosted, the registry stays empty and the `[TC.player]` fallback in
   the movement system masks the omission. After `NetServer.stop()` retains
   `p1`, the registry is non-empty and the fallback no longer applies.

The consumers that inherit the inconsistency are all registry-driven, which is
why the symptom is broad rather than cosmetic:

- `js/main.js` movement system → iterates `TC.Players.all()`;
- `js/targeting.js` (`TC.Targets`) → prefers registry entries, and is the
  mandated authority for enemy AI, despawn and spawn anchoring;
- `js/items.js` pickup → scans `TC.Players.all()`;
- `js/enemies.js` contact damage and hostile-shot victims → `TC.Players.all()`.

The save path is a separate concern and is already correct: `quitToTitle`
saves *before* clearing state, and the host world is the save.

## Goals / Non-Goals

**Goals:**
- Enforce one invariant: **a `Player` entity never outlives its world.**
- Make the invariant hold at the seams that create worlds, not in each
  consumer.
- Keep the multiplayer session lifecycle byte-for-byte unchanged while a
  session is running.
- Make any repair observable.

**Non-Goals:**
- Not changing how remotes are spawned, replicated, despawned, or garbage
  collected (netserver/netclient replication is untouched).
- Not changing `TC.Targets` selection policy (nearest-by-d2 with 20%
  challenger stickiness and stable-id tie-break) — it is correct; it is being
  fed a wrong population.
- Not making solo play eagerly populate the registry. An empty registry in a
  never-hosted session is a supported, cheap degenerate case and the
  `[TC.player]` fallback is legitimate.
- Not touching `TC.Players.MAX` limits or the reconnect grace policy.

## Decisions

### D1: Reset the registry at world construction, in `main.js` and `runtime.js`

Call `TC.Players.resetForNewWorld()` (guarded for optional dependency, matching
the surrounding style) as the first step of `TC.newGame`, `TC.continueGame`, and
`TC.Runtime.createWorld` — *before* the new `Player` is constructed.

Rationale: world construction is the only moment at which "entities die with
the old world object graph" is true by definition. Resetting there makes the
invariant structurally guaranteed rather than dependent on every future
transition author remembering.

**Alternative considered — reset in `quitToTitle` only.** Rejected: it leaves
the invariant unenforced for any world-creation path that does not pass
through the title screen (for example a future direct `createWorld` call, or a
failed `newGame` that aborts midway), and it couples correctness of world
creation to the UI flow.

**Alternative considered — reconcile lazily in the movement system** (e.g. if
the primary's player is not `TC.player`, rebuild). Rejected: it hides the
inconsistency at the symptom layer, leaves `TC.Targets` and item pickup still
reading the stale set, and would make the bug's blast radius depend on which
consumer runs first.

### D2: Re-seat the local primary in solo worlds so the registry is not left empty mid-world

After the reset, register the new local player as the primary
(`TC.Players.create(player, { primary: true })`) so that from the moment the
world is live, the registry, the `TC.player` alias, and every consumer agree on
exactly one player.

Rationale: with a non-empty registry the `[TC.player]` fallback in the movement
system is not used, so a *stale* entry is fatal — but a *correct* single entry
makes the solo path structurally identical to the multiplayer path and removes
the dual-code-path hazard entirely. `Players.create` already auto-elects the
first non-remote entry as primary (`wantPrimary = opts.primary === true ||
(primaryId === null && !rec.remote)`), and `setPrimary` maintains the
`TC.player` alias, so this uses existing, tested behavior.

**Alternative considered — leave solo sessions with an empty registry.** Also
valid and lower-churn, and the lifecycle test would then assert "empty registry
+ singleton fallback." Rejected because it preserves two subtly different solo
code paths (registry-empty vs registry-single) and because the defect we are
fixing is precisely that the two paths disagree. If the implementer prefers
this variant, the spec's scenarios still hold as long as the *observable*
requirements are met — but D2's single-entry invariant is the recommended
reading and makes the "only registered players are simulated" requirement
trivially checkable.

**Note on the hosting path**: `NetServer.start()` with `adoptWorld: true`
adopts an already-playing world, and `attachLocal()` then registers `p1` from
`TC.player`. That order already yields a correct single primary. The reset in
D1 happens during `newGame` (which `actHostMultiplayer` calls *before* creating
the server), so `attachLocal` still sees an empty registry and seats `p1`
normally. This must be preserved and covered by the lifecycle test.

### D3: Make `NetServer.stop()` release the local primary instead of retaining it

Change the teardown so the host's local primary is not retained for reuse in a
subsequent world.

Rationale: `stop()` currently calls `TC.Players.retainOnly([localPid])`, which
exists to keep the host player alive *for the rest of the session* — but `stop`
*ends* the session, so retaining past the session boundary has no legitimate
consumer. With D1 in place this is defence in depth rather than the primary fix.

**Alternative considered — leave `stop()` alone and rely on D1.** This is
sufficient to fix the defect. It is retained as a separate decision only because
retaining a dead-world player across a session boundary is independently
incorrect and will otherwise look like a deliberate design choice to the next
reader. If the implementer judges the change too risky for this cycle, D1 plus
the lifecycle test is an acceptable complete fix; record that judgement in the
change's completion notes.

### D4: Emit an observable repair diagnostic

Have the world-transition reset report whether it found a non-empty registry
holding foreign players (e.g. a counter on the runtime/debug observability
surface, or an event), so a recurrence is visible in the F3 overlay / test
output rather than being silently corrected.

Rationale: the whole class of failure was invisible because a throw was
swallowed by a counter and a stale registry was never checked. A repair counter
costs one integer and makes the invariant self-monitoring. Prefer reusing the
existing observability conventions (`TC.Debug` counters, `TC.Events`) over
inventing a new surface.

## Risks / Trade-offs

- **[Reset happens before save-on-quit and loses the host save]** → Mitigation:
  `quitToTitle` saves before it clears anything, and the reset is in the
  *world-construction* path, not the teardown path. The lifecycle test asserts
  a save exists and reloads after a host-quit cycle.
- **[Resetting after `attachLocal` would strip the host primary]** → Mitigation:
  D1 orders the reset inside `newGame`/`continueGame`/`createWorld`, which the
  host flow calls before `NetServer.create(...).start()`. Covered explicitly by
  a scenario in the lifecycle test.
- **[A joined network client re-entering a world]** → Mitigation: a joined
  client does not own world truth; its mirror teardown path already removes
  remote entries and its `WorldLoaded` handling is unchanged. Add a scenario
  asserting a joined client that reconnects after a world transition gets a
  coherent set.
- **[Double registration if a caller already registered]** → Mitigation:
  `Players.create` returns the existing id if the same id is passed and refuses
  duplicates; prefer a single, explicit re-seat call site per transition rather
  than defensive scanning.
- **[Behaviour change is "the game now works"]** → Intentional. Any consumer
  that depended on the stale registry was depending on a bug; the lifecycle
  test enumerates the affected consumers so the blast radius is explicit.

## Migration Plan

1. Land D1 (reset at world construction) + the lifecycle test. This alone
   fixes the confirmed defect.
2. Land D2 (re-seat primary) and re-run the lifecycle test; update the test's
   solo assertions to the single-entry invariant.
3. Land D3 (release primary at `stop`) and D4 (diagnostic) if judged in scope.
4. No save-format change, no protocol change, no migration of stored data.
   Fully reversible per step.

## Open Questions

None blocking. One judgement call is left to the implementer and is recorded in
D2/D3: whether to land the re-seat and `stop()`-release steps in this cycle or
defer them to a follow-up once D1 is proven.

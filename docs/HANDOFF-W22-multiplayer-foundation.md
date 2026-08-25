# Campaign Handoff — W22: Authoritative Multiplayer Foundation & Two-Client Vertical Slice

Task ID: W22 (NET-001 reconciliation + NET-002 + NET-003 + first NET-004
prototype; baseline CI/browser failure fixes).

Branch / commit: `main` (all W22 work lands on main, locally and remotely;
no campaign branch — per owner instruction carried from W21).

Base at session start: `main` = `abc9b8b` (W21 final docs commit), working
tree clean, `origin/main` verified equal via `git ls-remote` (network to
github.com was intermittent during the session; fetch succeeded on retry
and the remote was confirmed up to date before work began). Node v24.3.0.

## Reconciliation performed

- Baseline gate ran BEFORE any edits: syntax ✓ (49 files), i18n ✓
  (fingerprint `bdad6cfa` / 368 stable ids unchanged), node tests ✓ 481/481.
- Browser baseline REPRODUCED the CI failures locally: journeys D/ranged and
  F/fishing failed exactly as recorded in CI (plus H/platform from the known
  rotating set). All three were then root-caused and fixed at the assertion
  level (below); gameplay code untouched for these.
- `git status` kept clean of stray files throughout; scratch probes deleted.

## Baseline failures: root causes and fixes (CI note resolved)

1. **Journey D / ranged combat** ("arrow must collide and kill", "zero gel"):
   two stacked issues. (a) Arrows are gravity projectiles; aiming dead-center
   connects only when a hop crosses the descending arc — a physics lottery,
   lost under load when hop phase desyncs. (b) The loot assertion counted only
   physical drops; slimes hop TOWARD the player, so a near kill legitimately
   magnet-collects its gel once pickupDelay (0.9 s) elapses, and the
   uncontrolled live time between kill detection and assertion under CI load
   let that happen. Fix: pin the target each shot, solve the low-arc launch
   angle against live game constants (`TC.Projectiles.TYPES.arrow`), and
   assert the durable invariant — gel in drops PLUS inventory delta ≥ 1
   (melee test got the same durable-invariant treatment).
2. **Journey F / fishing** ("reeling must register a catch"): the real CDP
   click raced the 0.95 s game-time bite window across process boundaries;
   under load it landed after expiry where the same click means "pull line"
   (recall). Fix: watch the game state from INSIDE the page and press through
   `TC.Input.mouse.down` — the canonical seam a real mousedown drives —
   within one frame of the `biting` transition, hold ~4 frames, release. No
   gameplay code special-cased; the full cast→bite→hook→catch→persist flow is
   still exercised.
3. **Journey H / platform S-drop**: assertion compared on-deck FEET against
   on-floor TOP (a one-player-height margin that flips on sub-pixel landings
   under different pacing). Now compares feet-to-feet with a >16 px margin.

Result: D/F/H suites pass repeatedly; no retries enabled anywhere
(`retries: 0` policy intact), no timeouts inflated beyond existing budgets,
no assertions weakened — all three now assert stronger/durable invariants.

## Architecture delivered

Full contract text lives in docs/ARCHITECTURE.md §26 (authority model,
protocol, transports, server/client lifecycles, replication model,
persistence boundaries, tests/benchmarks). Summary:

| Module (file) | Role |
|---|---|
| js/players.js | `TC.Players` identity registry (stable ids, single primary aliased by `TC.player`, remote mirrors, teardown hygiene) |
| js/netproto.js | protocol v1: fail-closed envelope validation, message types, command whitelist, region codecs, state digests |
| js/nettransport.js | endpoint boundary: deterministic loopback pair (with hostile injection) + platform WebSocket client |
| js/netserver.js | authoritative session runner: inbound processing → canonical tick → per-client region replication; reconnect/resync; diagnostics |
| js/netclient.js | joining controller: handshake, input streaming, intent submission, presentation mirror, explicit resync |
| tools/net/wsserver.js | zero-dependency Node RFC6455 server shim (handshake/masked frames/ping/close) |
| tools/mp-server.js | headless dedicated host over the REAL game scripts (VM loader) |

Integration seams (minimal, additive): per-player `inputSource` in
Player.update; multi-player movement iteration in main.js; enemy contact +
hostile-shot loops iterate players via `Combat.hurtPlayer(..., {target})`;
drop magnet selects nearest collector among all players; enemies carry `eid`
for replication identity; `Save.autosave`/`quitToTitle` gates for joined
clients; title menu Host/Join entries (+ `ui.net.*` localized strings);
`Systems.unregister` added as the symmetric lifecycle API; F3 shows bounded
net stats lines.

## Two-client functionality (what actually works)

Join → same world/session/seed with distinct stable identities → movement
replicates both ways (input cannot move another player) → mining replicates
exactly once (duplicate intents rejected at sequence level AND idempotent
semantically) → placement consumes exactly once (rejected placement consumes
nothing; unknown items conjure nothing) → one combat path (pooled arrows)
kills authoritatively with a single EntityKilled + single loot spawn visible
to both clients → inventory mutations are server-owned and replay-proof
(cross-player selection structurally impossible) → disconnect/rejoin rebinds
the SAME identity with edits-made-while-absent delivered via fresh snapshots
and stale-generation packets rejected → server shutdown returns clients to a
coherent title state. Single-player path untouched (zero networking when no
session exists).

## Tests added (30 headless + 2 browser specs)

- tests/net/proto.test.js (5): hostile schema validation, decode caps,
  codec round-trip/diff, digest stability.
- tests/net/players.test.js (5): identity lifecycle, primary election,
  mirror isolation, teardown hygiene.
- tests/net/transport.test.js (4): loopback FIFO/manual pump, hostile
  injection, closed semantics, REAL WebSocket echo through the RFC6455 shim
  using the platform client.
- tests/net/session.test.js (9): the vertical slice incl. hostile packets
  fingerprint check and deterministic two-client replay digests (world ^
  inventory equality across independent realms; enemy AI excluded by its
  documented Math.random policy).
- tests/net/replication.test.js (6): consumer independence, interest
  crossing, edit-while-uninterested, forced resync on bogus acks, burst
  coalescing vs last-sent baselines, bye-teardown consumer forget.
- tests/net/crossrealm.test.js (1): shipped NetClient joined to a real
  NetServer across two VM realms: mirror equality, authoritative command
  round-trip into the mirror, link loss, same-identity resync.
- tests/browser/journey-m-multiplayer.spec.js: two Playwright pages over the
  real mp-server WebSocket host (same-world ids, movement observation,
  mine→loot→place chain with exactly-once inventory accounting, reload
  resync-to-newcomer, shutdown coherence).

Suite totals after W22: 511 headless tests green; browser suite green
including journey M.

## Benchmark evidence (tools/bench-multiplayer.js, 300-tick scenes)

VM-realm tax applies (see W21 handoff); relative deltas are the signal:

```
idle-2p          tick 27961.7 µs   out msg/tick 2.81   out KiB/s 86.0
move-2p          tick 27744.3 µs   out msg/tick 2.81   out KiB/s 85.8
mine-burst       tick 31357.2 µs   out msg/tick 2.40   out KiB/s 47.9
resync-churn x2  tick 28269.3 µs   out msg/tick 0.80   out KiB/s 25.9
one-client vs two-client median tick: +2%
```

Reading: steady-state replication costs ~2.8 msgs/tick (~86 KiB/s outbound
for two clients at 60 Hz — trivially LAN-scale); burst mining adds ~13%
over idle; full snapshot resyncs every 2 s are absorbed without tick-cost
spikes. PERF-003 remains deferred (W21 evidence stands).

## Compatibility considerations

- Save formats untouched; clients never save; host saves exactly as before.
- Registry fingerprint unchanged (`bdad6cfa`, 368 ids — i18n gate proves it).
- Single-player behavior identical when no session exists (registry-empty
  fallback paths preserve legacy singleton semantics; suite totals prove it:
  511/511 including all pre-existing suites).
- index.html script order extended (netproto/nettransport/players after
  savecore; netserver/netclient before debug/main) — headless loaders derive
  order from index.html automatically.

## Known limitations / deferred

- Client-side prediction/interpolation absent (server-driven positions at
  60 Hz feel fine on loopback/LAN; latency masking was explicitly deprioritized).
- Enemy AI targets the primary pawn only; multi-target AI deferred.
- Region payloads use simple hex layers/cell lists; compression deferred.
- Full lockstep determinism excludes enemy AI (Math.random policy);
  digests cover world/inventory/player state.
- Crafting/shop commands not yet network-whitelisted.
- Detached-session grace fixed at ~5 min (not yet configurable per host).

## Follow-up candidates

See docs/TASK_BOARD.md "W22 multiplayer follow-ups" (prediction, AI targets,
compression, seeded runtime RNG, crafting/shop over network, interest
tuning, browser-measured benchmark variant).

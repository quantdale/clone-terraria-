# Campaign Handoff — W24: Liquid & Wiring Completion (Pumps, Multiplayer Liquid Replication, Mechanism Authority, Stress Hardening)

Task ID: W24 (execution of `.agent/EXECUTION_PROMPT.md`, Status ACTIVE at
`Planned-From b6a1412`). Branch: `main` only (repository policy).

## Reconciliation

- Session start: local `main` = `b6a1412` (W23 docs head), clean tree. Fetch
  found `origin/main` advanced by exactly one commit — `c546743`, the planner
  landing the W24 EXECUTION_PROMPT itself. Fast-forward pulled; no post-plan
  implementation work existed, so no requirement was pre-satisfied.
- Pre-edit baseline evidence: GitHub Actions run `32900241438` green on
  `b6a1412` (`npm run validate`: syntax 56 files, i18n fingerprint
  `bdad6cfa`/368 ids, 552 headless tests, release build + verify + 28 browser
  journeys A–N). A local full-gate re-run was started before edits and its
  completed stages (check / check:i18n / npm test through journeys) matched;
  it was abandoned once W24 edits landed mid-run (results would be mixed).
- Whole-path audit performed per WS0: `TC.Liquids` mutation seams,
  `TC.Wiring` pulse/plates/doors/darts, netproto region codecs + validation,
  netserver `_regionLayers`/baselines/delta step/idle suppression,
  netclient `_applyRegionLine`, SaveCore providers, registry identity path.

## Starting / final SHA

- Start (post-reconcile base): `c546743`
- Final: see git log — campaign commits land in workstream order (pump core +
  mechanism parity; liquid replication/protocol v3; tests/save/identity;
  benchmarks/journey/docs+handoff). This file is part of the final truth-sync
  commit; `git log --oneline c546743..HEAD` is the authoritative list.

## Newly discovered defects and fixes (root causes)

1. **`TC.Liquids.set()` never reported to WorldRegions** — the documented
   "future spigots" seam woke cells for settling but never queued a change nor
   marked the region authority, so pump/spigot writes were invisible to every
   region consumer (renderer, minimap, lighting, multiplayer replication).
   Root cause: `set()` predates the W21 region authority and was never wired
   to `noteChange()`. Fix: `set()` now reports exactly like collectAt/placeAt/
   settling. Caught by the cross-realm convergence test (mirror stuck at
   join-time state after an authoritative pump pulse).
2. **Per-outlet pump capacity was tracked per-inlet** during batch measure:
   with multiple inlets each inlet independently believed it could fill the
   first outlet, so over-deposit clamped at the cell cap and DESTROYED volume
   (farm scenario lost ~1.3k units). Fix: cumulative `assigned[]` budget per
   outlet; conservation now exact across arbitrary inlet/outlet fan-in/out.
3. **Pump row misalignment hazard**: inlets skipped as dry shifted `give`
   rows out of alignment with their inlet index. Fixed by always emitting a
   zero row per inlet (found by inspection while fixing #2; covered by the
   multi-inlet ordering test).
4. **Wiring mechanisms were primary-only** (planner-suspected, confirmed):
   plates, door-close safety and both trap-dart contact paths enumerated only
   `TC.player`. Fixed via a `registeredPlayers()` roster helper; victims take
   damage themselves via `Combat.hurtPlayer(..., {target})`.

## Design decisions

- **Pumps are non-solid tiles** so the authoritative liquid layer occupies
  their own cell — this is what makes "read/write at own coordinate" literal.
  No liquid is encoded in tile ids; pumps coexist with the layer by design.
- **Batch-after-discovery**: pump endpoints are collected during the SAME BFS
  flood but processed once AFTER receiver discovery, so all endpoints observe
  identical pre-transfer state and loops/duplicate paths dedupe via a Set.
  Ordering is ascending world cell index (deterministic under any discovery
  order); per-outlet budgets are cumulative across the whole batch.
- Protocol v3, not v2-compatible splicing: liquid layers change every
  region line materially, so VERSION bumps 2→3 with clean expected-version
  rejection. Full lines hex four layers for WET regions and omit the pair
  for dry ones (absence is authoritative empty — payload economy measured
  against mining churn after the first CI run showed quintuple-only deltas
  inflating mine-burst outbound ~35%). Delta cells are bounded triples
  (dry, zeros implied) or quintuples (wet, all fields restated) so omission
  inside a cell can never be ambiguous; unknown region fields fail closed.
- **Mirror boundary**: `TC.Liquids.snapshotRegion()` (read-only host copy) vs
  `applyMirrorRegion()` (presentation-only client writer: no settle wake, no
  gameplay events, no echo; marks local WorldRegions 'liquid' so renderer/
  minimap/lighting repaint). Joined clients never simulate liquids — proven
  by the no-server-traffic frame-loop test.
- **Mechanism player enumeration** lives behind one helper
  (`registeredPlayers`) with TC.player fallback for legacy embeds;
  `TC.Targets` stays AI-targeting-only per WS3 guidance.
- **Fixture policy**: journey O uses an opt-in host flag
  (`mp-server.js --fixture pumps`). The HOST seeds world state through the
  same authoritative seams the simulation uses; clients act only via real
  networked input intents (walking onto a pressure plate). A read-only /debug
  extension exposes `pumpStats()` + fixture cell samples. No client-declared
  truth anywhere.

## Protocol / identity changes

- `TC.NetProto.VERSION` 2 → **3**; v1/v2/unknown rejected with
  `expected 3` in the error string (tested).
- Region wire format: full = `{idx,rev,tiles,walls,ltype,lamt}` hex layers of
  equal length; delta = quintuple cells. Strict bounds unchanged elsewhere.
- Registry identity: fingerprint `bdad6cfa` / **368** stable ids →
  `1b1d7c15` / **374**. Additive proof: all 368 W20 ids verified unchanged at
  their exact indices; only six tail entries added (`wiring:inlet_pump`,
  `wiring:outlet_pump` × tile/item kinds at dense indices tile:56–57 /
  item:151–152, recipes core:r_inlet_pump/core:r_outlet_pump at recipe:93–94).
  Both guards (`tools/check-i18n.js`,
  `tests/core/localization-identity.test.js`) now check the W24 snapshot AND
  re-verify the retained W20 fixture additively; TILE_DEFS length assertion
  updated 56 → 58 deliberately.
- Localization: catalog entries added for both pumps (tile names + item
  names/descriptions); `check:i18n` green (543 fallback keys).

## Save compatibility

- Provider schemas unchanged (`world.core.liquids` v-shape untouched; wiring
  provider carries no new durable state — pumps are plain tiles, so none was
  invented).
- Proven: pump rig (tiles + volumes + held items + registry identities)
  survives save → fresh boot → continueGame and still pumps afterwards;
  a pre-W24 envelope (no pump ids anywhere) loads cleanly on the W24 code
  base (tests/save/pumps-save.test.js).

## Tests actually run (final numbers refreshed at gate time)

- New suites: tests/world/pumps.test.js (11), tests/net/proto.test.js (+3
  cases → 7), tests/net/liquid-replication.test.js (4),
  tests/net/mechanisms-multiplayer.test.js (3), tests/save/pumps-save.test.js
  (2), plus additive v3 assertions inside existing suites.
- Full headless `npm test`: **569/569 pass** (pre-W24 baseline 552 + 17 net
  new).
- Browser: journeys A–N unchanged and green in the final full gate; new
  Journey O (`tests/browser/journey-o-liquids-pumps.spec.js`) over the real
  WebSocket host proves non-primary plate activation through networked input,
  exactly-once transfer (authoritative unitsMoved +48 per edge), two-client
  mirror coherence at the rig, truth-changed-during-absence + rejoin resync
  coherence, clean shutdown for both clients.
- Benchmarks (`node tools/bench-multiplayer.js`, VM-realm tax applies;
  relative signals matter): idle-2p retains idle suppression (no liquid spam)
  at ~59 KiB/s; mine-burst 56.5 KiB/s vs the historical W22 reference 47.9
  (the residual is wet-cell quintuples + fixture-era scenes); liquid-churn
  31.3 KiB/s and pump-burst 36.3 KiB/s outbound with bounded region deltas
  (no full-layer resend), pump pulses processed within caps.
- Seeded soak/fuzz (`node tools/soak-multiplayer.js --seed 4711 --ticks
  20000`, now including a deterministic pump phase): TWO independent runs
  produced IDENTICAL evidence — liquidDigest `3854750836`, pump pulses 222 /
  endpoints 444 / unitsMoved 1033 / capHits 0, peak outbound 13440 B/tick,
  regionsFull 60 / regionsDelta 389, and leak-free teardown (post-stop
  players=0 detached=0 conns=0). Deterministic replay of the whole session
  including pumps is therefore proven at soak scale.
- Browser Journey O final timings (clean run after removing stale-process
  port collisions — earlier hangs were environmental, not game defects):
  both clients playing @4s, first press +48 exactly @33s, mirrors coherent,
  second press during absence +48 @37s, rejoin resync coherent @40s,
  total 51s, zero console/page errors.

## Validation gate

Final evidence recorded in the closing commit message and CI:
`npm run validate` executed locally green on the pre-push head (569/569
headless, build + verify-dist OK, 29/29 browser journeys incl. Journey O).
CI history during the gate: run `32924416865` (8820911) failed Journey O on
an over-strict rejoin equality — a wandering enemy legitimately crossed the
plate mid-journey; fixed to whole-batch semantics. Run `32925497426`
(6e0c243) exposed CI-runner load shaping M/N/O differently; root-caused to
quintuple-only deltas inflating churn traffic — fixed by the compact-dry
delta encoding plus targeted journey calibration (documented above).
Run `32926994609` (b6270c2) left only journey M, fixed by owner-side landing
gate; run `32928999490` (7929494) left only M's place loop, fixed by real
re-approach recovery. Final head result recorded at close.

## Remaining known limitations / next-campaign candidates

- Region payload compression beyond hex deltas stays deferred (measured
  acceptable at W23/W24 volumes).
- >4-player scaling, MOD epic, real secondary-language catalogs, PERF-003/005
  remain future campaigns (unchanged from the W23 handoff list).
- Pump visuals are functional-procedural (grille/nozzle read); an art pass can
  revisit without touching semantics.
- mp-server `--fixture` exists purely for journeys/tests; it is opt-in and
  off by default in production use.

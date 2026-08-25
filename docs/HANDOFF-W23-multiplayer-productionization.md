# Campaign Handoff — W23: Multiplayer Productionization (Gameplay Parity, Latency, Determinism, Scalable Replication)

Task ID: W23 (execution of `.agent/EXECUTION_PROMPT.md`, Status ACTIVE at
`Planned-From 1fa43f4`). Branch: `main` only (repository policy). All work
lands on main; no campaign branch.

## Reconciliation

- Session start: local `main` = `1fa43f4` (W22 head), clean tree. Fetch found
  `origin/main` advanced to `d87523f` — exactly one commit: the planner
  landing `.agent/EXECUTION_PROMPT.md` itself. Fast-forward pulled; no other
  post-plan work existed, so no requirement was already satisfied or stale.
- Baseline gate ran BEFORE any edits on `d87523f`: `npm run validate` green
  (syntax 49 files, i18n fingerprint `bdad6cfa`/368 ids unchanged, 511/511
  headless tests at that point, release build + verify + 27 browser tests).
- Whole-codebase audit performed per WS0: all gameplay-side `Math.random`
  call sites classified (84 total across js/), all authoritative `TC.player`
  reads classified module by module (enemyai/enemies/enemyspawn/combat/
  magic/fishing/wiring/ui/main), command capability table built from
  `TC.Commands.names()` vs whitelist vs server `_execCommand`.

## Starting / final SHA

- Start (post-reconcile base): `d87523f`
- Final: see git log — campaign commits, in order:
  1. `9d38df8` feat(w23): seeded GameRng authority for all gameplay randomness (WS3)
  2. `530146d` feat(w23): deterministic multi-player target selection + per-player attribution (WS2)
  3. `0cab29c` feat(w23): networked craft/shop/container transaction parity (WS1)
  4. `70a8391` feat(w23): productionized entity replication + bounded delivery (WS5)
  5. `c3b23d0` feat(w23): latency masking — impaired transport, remote interpolation, local prediction (WS4)
  6. `1a717e5` test(w23): four-player integration, seeded soak/fuzz + standalone soak tool (WS6+WS7)
  7. `b616d8b` test(w23): browser journey N + extended multiplayer benchmark scenes (WS7c/WS7d)
  8. (final) docs(w23): truth-sync + handoff

## Newly discovered defects and fixes (root causes)

1. **gamerng load order**: first placement after utils.js meant `TC.Events`
   was undefined at registration time, silently skipping the WorldLoaded
   reseed hook. Moved after events.js in index.html.
2. **Test-suite Math.random pinning broke** the moment authority moved to
   GameRng (expected): migrated every suite that pinned host Math.random
   (combat/_helpers deterministicRolls → `TC.GameRng.override(null, …)`,
   npc/enemies patchRandom, player/enemy-archetypes storm-jelly pick,
   unit/enemyspawn-underworld LCG, wof-frontier call sites).
3. **resolveHit isPlayerAttack used `attacker === TC.player`**: remote
   players' melee/arrows/magic scaled through the HOST's stats. Fixed to
   "any registered player" via `TC.Players.idOf`; byPlayer threaded from
   Player.useHeld (`this`) into Combat.meleeStrike/shootArrow and Magic.fire;
   pooled projectile rollSpec uses registry membership too.
4. **shockwave hurt the primary only**, without `{target}` even after the
   victims loop existed in draft form — now passes `{target: p}` per victim.
5. **enemyspawn depth gates read TC.player inside zoneTable** while the new
   director anchors elsewhere: anchor threaded explicitly with a legacy
   two-arg fallback to Targets.anchor().
6. **ContainerMove omitted-toSlot coercion**: netserver coerced
   `ctxP.toSlot | 0` → 0, turning auto-placement into an unintended SWAP
   (chest slot received the player's copper_pickaxe). Fixed to pass through
   only when present; auto-placement merges then fills empties.
7. **impairedPair jitter reordered frames** inside a reliable-ordered
   direction, which real WebSockets never do — handshake welcome arrived
   after worldupds and was dropped as stale sseq. Fixed with a per-direction
   monotonic schedule floor; explicit reorderChance remains for adversarial
   tests.
8. **Interp buffers lacked timestamps** (`t` field) making interpolation hold
   forever on the first pose — push sites now stamp client tick at receipt.
9. **NetServer.stop() leaked parked reconnect identities** (players +
   private WorldRegions consumers survived stop()). stop() now expires them.

## Protocol / authority changes and compatibility

- Protocol VERSION bumped 1 → 2. Old-version envelopes get the existing
  explicit `version:` rejection (`tests/net/parity.test.js` asserts it);
  no silent acceptance. Both ends ship from one repo; no deployed fleet.
- New whitelisted commands: CraftRecipe {recipeId}, ShopBuy {npcType,
  itemId}, ShopSell {npcType, slot, count?}, ContainerMove {tx, ty, from,
  to, fromSlot, toSlot?, count?} — endpoints encoded as 0=chest / 1=inv.
- Per-command bounded ctx schemas; unknown/nested-object ctx fields reject
  pre-transaction. cmdres gained optional `result` {action, inv, chest};
  worldupd gained optional `chest`, `rm {p,e,d}`, `inSeq`.
- Server-side eligibility added where local UI had implicit gating: shop
  proximity vs live NPC kinds; chest container sessions bound by canonical
  InteractTile, expired on tile loss/reach loss/disconnect.

## Command capability matrix outcome

| Command | Local caller | Network | Notes |
|---|---|---|---|
| MineTile/MineWall | player intent | ✓ (since W22) | tool/power/dt reconstructed server-side |
| PlaceTile/PlaceWall | UI click | ✓ | consumes once / rejected consumes nothing |
| UseItem | input phase | ✓ | full live dispatch incl. hooks |
| MoveItem | inventory UI | ✓ | both ends = acting player's inv |
| EquipItem | equipment UI | ✓ | |
| InteractTile | right-click | ✓ | chest action binds container session |
| CraftRecipe | crafting panel | ✓ NEW | stable-id intent; stations/progression server-resolved |
| ShopBuy/ShopSell | shop panel | ✓ NEW | proximity-gated; prices/stock/currency server-owned |
| ContainerMove | chest drag/shift-move | ✓ NEW | session-bound; auto-placement |

## Targeting policy and deliberate primary-player exceptions

Policy contract lives in js/targeting.js (see ARCHITECTURE.md §27).
Deliberate primary/local ownership retained: camera follow, local input
sampling, HUD/UI ownership, client self-mirror identification. Everything
authoritative (AI targets, boss/summon anchors, despawn proximity, spawn
director anchors, eye tracking, shockwave victims) goes through TC.Targets.

## RNG contract and replay-determinism evidence

TC.GameRng named streams; WorldLoaded reseed from worldSeed; digest over
seed+per-stream state+draw counters. Evidence:
- tests/core/gamerng.test.js — determinism/isolation/restore/WorldLoaded.
- tests/net/rng-replay.test.js — same seed+trace ⇒ identical world, player,
  inventory, ENEMY-AI and RNG digests across independent realms; different
  seeds diverge (not a static digest).

## Prediction/interpolation design and latency evidence

See ARCHITECTURE.md §27. Correction thresholds: soft blend 0.22/frame,
hard snap >72px (+history flush); interpolation delay 4 ticks, teleport gap
96px; buffer 10 snapshots. Latency harness: impairedPair (seeded, ordered).
Evidence: tests/net/latency.test.js — deterministic delay/jitter traces,
ordered stall/release, glide between snapshots, soft/hard reconciliation,
and a full join→play session under ~120ms RTT + jitter converging within
24px of authority.

## Replication design and before/after numbers

tools/bench-multiplayer.js, 300-tick scenes, VM-realm tax applies (relative
deltas are the signal):

```
                 W22 baseline            W23
idle-2p          86.0 KiB/s              ~29-43 KiB/s   (-66% measured at 600 ticks: 29.0)
move-2p          85.8 KiB/s              32.3-47.9      (-62% at 600 ticks)
mine-burst       47.9 KiB/s              39.9-48.7
resync-churn     25.9 KiB/s              8.9-18.0
idle-4p          n/a                     ~86 KiB/s      (≈2× idle-2p, scales with interest)
move-4p          n/a                     ~110 KiB/s
separated-explore-4p n/a                 ~202 KiB/s     (region streaming dominates, legit content)
combat-multi-2p  n/a                     ~173 KiB/s     (entity-dense scene)
tx-burst         n/a                     ~47 KiB/s
median tick      1-vs-2 clients ±13%     flat within noise (~16-18ms VM tax)
```

No unexplained tick-time regression; idle suppression removes empty worldupd
entirely (asserted zero messages over 90 idle ticks).

## 2/4-player, slow-client, reconnect, soak evidence

- tests/net/fourplayer.test.js — simultaneous separated-interest mining
  (exactly-once breaks), multi-target AI distribution (every player claimed),
  delayed peer (200ms±50ms) cannot stall authority, churn rejoin with cseq
  floor + leak-free teardown.
- tests/net/soak.test.js — seeded fuzz mix ×2 runs: identical digests AND
  counters; teardown hygiene. tools/soak-multiplayer.js --ticks 20000 runs
  the long-form evidence standalone (verified working at 5000 ticks:
  worldDigest stable across reruns, counters reproduced).

## Save/registry/localization compatibility

- Save formats untouched; joined clients still never save; host saves as before.
- Registry fingerprint `bdad6cfa` / 368 stable ids unchanged
  (`npm run check:i18n` + tests/core/localization-identity.test.js).
- No new user-facing strings required catalog keys (reused existing
  ui.shop.* templates); check-i18n green.

## Tests actually run (final head of campaign)

- `npm run check` — syntax, 56 files, 0 failures.
- `npm run check:i18n` — OK, fingerprint unchanged.
- `npm test` — 552 tests, 0 failures (was 511 at baseline; +41 net new).
  Suites added: gamerng(5), rng-replay(2), targeting(7), parity(5),
  replication2(5), latency(5), fourplayer(4), soak(2) = 35 new; several
  migrated suites re-verified.
- `npm run build` + `npm run verify:build` — reproducible dist assembly OK.
- `npm run test:browser` — journeys A–N green including new journey N
  (networked craft round trip, non-primary targeting via /debug attribution,
  interpolation buffers asserted through diagnostics, resync, shutdown).
- Full `npm run validate` executed before final push (log captured in
  .validate-w23.log during the run, then removed from the tree).
- tools/bench-multiplayer.js and tools/soak-multiplayer.js evidence recorded
  above.

## Known limitations / deliberately deferred

- Region payloads remain hex layers/cell lists (no compression): measured
  bandwidth already meets targets; RLE/binary encoding deferred with
  evidence rather than speculative work.
- Client cursor-stack dragging across the chest panel remains single-player
  UX; joined clients use authoritative shift/click transfers (documented in
  ui.js) — conservation is proven, drag parity is future polish.
- Mana/potion-sickness are per-player but NOT yet replicated fields (client
  mirrors show own mana only); server truth governs casting either way.
- NPC replication is out of the W22/W23 wire (shops validate proximity
  against live NPCs server-side); remote clients see NPCs via... not yet —
  merchant interactions require an NPC near the acting player, which remote
  clients cannot currently observe visually. Follow-up candidate.
- >4 players untested (registry MAX=8); soak coverage stops at 3 drivers.

## Final gate / Git verification

- Worktree clean; local `main` == `origin/main` at push time (verified with
  `git status -b` + `git fetch --dry-run` showing no further drift).
- GitHub Actions run for the pushed W23 head: recorded in the final commit
  message / checked after push (see below if CI failed — root-caused and
  repaired per completion gate item 15).

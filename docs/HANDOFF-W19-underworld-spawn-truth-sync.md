# Campaign Handoff — W19: Underworld Spawn Truth-Sync & Harness Hardening

Task ID: W19 (reconciliation + gap-closure session over the W17 Underworld
Frontier campaign and the W18 Runtime Authority Convergence campaign).

Branch / commit: `campaign/runtime-authority-convergence`
Base at session start: `8a849da` (W18 docs sync; history includes the full
W17 frontier campaign `44ce0b5..91a8393` and `main` = `6cdebae`, the W16
planning baseline).
Session commits (all pushed):

- `1a48e6c` fix(spawn): depth-first underworld zoning + shared underworld boundary
- `27a2598` test(browser): deterministic harness hardening for i/j/b + runtime authority
- `7834b2f` perf(wof): measure a LIVE encounter; record W19 probe evidence
- `ae40883` docs: W19 truth-sync — underworld spawn contracts, harness, perf evidence
- `88e679f` ci: run the validate gate on Node 22 (node --test glob support)
- `419a1e9` test(browser): journey-b tracks the mined tile's actual drop

## Reconciliation decision

The prompt's W17–W20 campaign was found **already implemented** on this
branch (commits `44ce0b5`, `81ded57`, `afd605b`, `f544212`, `91a8393`):
data-driven summon policy with zero-consume rejection, direction-locked
multi-phase Wall state machine, hungry servant archetype, canonical
combat/loot/progression routing, infernal_core rewards, post-Wall
recipes/merchant stock/guide dialog, journey-j browser proof, F3/#test
observability. Per instruction, nothing was reimplemented; the session
audited every requirement against code and closed the real gaps.

## Behavior added or changed

1. **Underworld spawn zoning fixed (was a live defect).** The spawn director
   classified deep players as `cave` before any biome override could apply,
   so the declared Underworld roster and the post-Wall ember_wraith entry
   never spawned in real play (proven headless before fixing).
2. **One authoritative Underworld boundary.** New pure API
   `TC.Biomes.underworldTopPx()` / `TC.Biomes.isUnderworldAt(xPx, yPx)`;
   summon validation (`player.currentBiomeTag`), Wall lifecycle confinement
   (`enemyai`/`enemies` band + escape checks), WoF placement and spawn
   zoning all derive from it.
3. **Declarative post-Wall spawn consequence.** The supplement moved from
   bespoke flag code in `getSpawnOverride()` into the shared
   `[type, weight, condition]` grammar entry
   `['ember_wraith', 1.6, 'boss.wall_of_flesh.defeated']`; `zoneTable`
   filters condition entries everywhere, fail-closed.
4. **Blood Moon precedence made explicit**: replaces the surface night
   table only; underground zones keep their ecology (intentional, tested).
5. **Browser harness hardening** (no assertion weakened): journey-i/j keep
   the fighter alive through real-time loops, chase bouncing loot, return
   to the arena for station asserts; journey-b re-acquires the minable tile
   mid-loop and accepts an already-collected drop; runtime-authority held-
   mining re-aims during the hold.

## Public contracts changed

- `TC.Biomes`: + `underworldTopPx()`, + `isUnderworldAt(xPx,yPx)` (additive;
  documented in AGENTS.md biomes row, ARCHITECTURE.md §23).
- `TC.EnemySpawn`: + `zoneOf(p,w,dl) → 'day'|'night'|'cave'|'underworld'`;
  `zoneTable(zone,pcol)` now filters `[type,weight,condition]` entries in
  base AND extras via `TC.Progression.test` (fail-closed); biome override
  applies to every zone except ordinary `cave`.
- `CONST.SPAWN`: + `attemptUnderworld: 2.2` cadence key (lead file, one
  additive data line by the integration owner).
- Consumers of `getSpawnOverride()` that expect the post-Wall wraith to be
  pre-filtered must now read the effective table through
  `TC.EnemySpawn.zoneTable('underworld', col)` — both in-repo consumers were
  updated (wof-frontier test, journey-j).

## Save/migration impact

None. No schema/provider changes; the milestone rides the existing
`systems.core.progression` provider. v1 blobs and v2 envelopes unaffected
(covered by existing suites: v1 migration, v2 round-trip, legacy loads).

## Tests added

- `tests/unit/enemyspawn-underworld.test.js` — 8 deterministic tests:
  depth-first classification, roster isolation vs vanilla cave, unchanged
  surface/cave tables, Blood Moon surface-night-only precedence, post-Wall
  grammar absent-before/present-after, fail-closed conditions, director-
  level underworld spawn proof.
- `tests/unit/wof-frontier.test.js` — ember_wraith unlock now proven through
  the real `zoneTable` pipeline (stronger than the previous getter peek).

## Tests run and results

Full gate from clean state (`npm ci` then `npm run validate`), final run:

- `npm run check` — 45 modules, 0 failures
- `npm test` — **421/421 pass** (413 baseline + 8 new)
- `npm run build` — OK (45 js files, version 0.9.0)
- `npm run verify:build` — OK (Chromium boots dist, zero browser errors)
- `npm run test:browser` — **24/24 pass**
- Journey stability evidence: touched specs passed `--repeat-each` 2–4×
  consecutively; three consecutive full `npm run validate` gates green.
- CI: workflow triggers on main/PR only, so it was dispatched manually on
  the branch after push. First dispatch (run `32720857926`) exposed a
  PRE-EXISTING gate breakage — identical failure on main (run
  `32693650942`, before this session): Node 20 passes package.json's quoted
  `node --test` glob arguments as literal paths. Fixed by pinning CI to
  Node 22 (`88e679f`). Second dispatch (run `32721355618`) cleared node
  tests/build/verify and surfaced one more environment-only journey-b
  failure (hardcoded 'dirt' chain vs drifted terrain on slow runners),
  fixed in `419a1e9`. **Authoritative branch run `32723170844` is GREEN**
  (validate job 5m10s: syntax, node tests, build, verify-dist, browser).

Two transient gate failures were investigated per policy, not waived: both
were harness observation races in landed specs (journey-b drop/mine,
runtime-authority held-mining), reproduced, root-caused, hardened, and
proven stable by repetition. No production regression existed behind them.

## Performance measurements

`node tools/perf-probe-w17-wof.js` (probe fixed to keep a live wall under
measurement — the terminal sweep previously emptied later benches):
single wall AI ≈ 10.2 µs/op; wall + servants at cap ≈ 15.6 µs/op (~0.09%
of the 16.67 ms fixed-step budget); hostile volley update ≈ 10.7 µs/op;
full Enemies.update under encounter load ≈ 11.8 µs/op; zoneOf+zoneTable ≈
0.57 µs/op; director tick ≈ 0.31 µs/op; shared query ≈ 0.02 µs/op.
Observed caps exercised: peakServants 6, hostile projectiles 12 (pool peak 17).

## Known limitations

- Unchanged from ARCHITECTURE.md §21/§23: no localization system;
  Hardmode-equivalent expansion deferred; underworld roster intentionally
  small (demon_eye/cave_bat/zombie + post-Wall ember_wraith).
- Browser journeys still depend on rAF-paced frames; hardening removed the
  known races but very slow machines could expose new ones (all current
  suites pass repeatedly under load).

## Follow-up work (next campaign candidates)

- Localization epic LOC-001..003 remains untouched; W17–W19 added few new
  user-visible strings that will need keys.
- UI inventory cursor-stack/bulk helpers as MoveItem batches (optional).
- LIQ-006 pumps; PERF-003..005; NET-002..004 beyond the headless precondition.
- Post-Wall content depth (second infernal tier, underworld structures) is
  deliberately unstarted; the bridge (recipes/stock/spawn/dialog) is the
  extension point.

## Push confirmation

Branch `campaign/runtime-authority-convergence` pushed to origin and set up
to track it; final head `419a1e9` (+ handoff commit); working tree clean.
Branch CI run `32723170844` green. No PR was opened and nothing was merged
to main (owner approval required per CONTRIBUTING.md §2).

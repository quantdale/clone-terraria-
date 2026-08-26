# Campaign Handoff — W25: Safe Extensibility Foundation (Resource Packs, Declarative Data Packs, Pack Identity, Save/Multiplayer Compatibility)

Task ID: W25. Branch: `main` only (repository policy).

## Reconciliation

- Planned-From: `93fc990` (expected W24 checkpoint). Fetch confirmed
  origin/main exactly there — no post-plan implementation existed.
- Actual-Start: `eda8fdf`. The working tree carried an UNCOMMITTED but
  complete perf/determinism package from an interrupted session (bounded
  chunk cache + liquid-only region skip + deterministic liquid settle order +
  persisted active set v2 + wall-variant pre-render + inlined noise). Per the
  never-discard rule it was validated first (573 headless tests, 29 browser
  journeys A–N, build+verify green) and landed as its own commit before any
  W25 edit.
- Reconciliation result: no W25 requirement was pre-satisfied; MOD-001..004
  were all TODO on the task board.

## Start / final SHA

- Start: `eda8fdf`
- Final: see `git log eda8fdf..HEAD` (workstream commits: plan → pack core →
  save diagnostics → protocol v4 → tests → docs/handoff; this file ships in
  the final truth-sync commit).

## WS0 audit outcome (whole content lifecycle)

Decisions per surface are recorded in docs/W25-PLAN.md. Headlines: tiles/
items/enemies/recipes chosen as pack families (declarative already,
strongly validatable); walls/NPCs/shops/loot-tables/projectiles/buffs/biomes
excluded with rationale; registry mirror stays idempotent; worldgen writes
built-in ids only; release build + test loader both derive from index.html
(loader extended to honor non-js/ scripts so headless boots exactly what the
browser boots).

## Changed files / modules

- NEW: js/packs.js (~1.6k lines incl. contract comments), packs/testpack.js,
  tools/fuzz-packs.js, tools/bench-packs.js, tests/packs/* (4 suites),
  tests/browser/journey-p-packs.spec.js, docs/W25-PLAN.md,
  docs/ADR-MOD-004-sandboxed-mods.md, this file.
- TOUCHED: js/registry.js (additive: forgetLast rollback seam, keyOf), js/
  localization.js (additive: extend() undoable fragment layers),
  js/events.js (+PacksChanged), js/savecore.js (packs envelope section +
  validation), js/main.js (deferred boot activation to DOMContentLoaded —
  load-order contract — and continueGame classification gate),
  js/netproto.js (v3→v4), js/netserver.js/_client (handshake identity),
  js/ui.js (title Content Packs panel + problem diagnostics), js/locales/
  en.js (ui.packs.* strings), index.html (+2 script tags), package.json
  (+tests/packss gate + test:packs), tests/helpers/load-game.js (repo-
  relative scripts + omitScripts + storage injection), tests/net/helpers.js
  (v4 default identity), README.md, AGENTS.md, docs/ARCHITECTURE.md §29,
  docs/TASK_BOARD.md.

## Feature matrix

| Requirement | Status |
|---|---|
| MOD-001 resource-pack loader | DONE — locale fragments via Localization.extend; resource paths validated traversal-free; resource packs can never carry gameplay content |
| MOD-002 declarative data packs | DONE — tiles/items/enemies/recipes with bounds + built-in-only references; commit-time normalization to canonical runtime forms |
| MOD-003 save diagnostics | DONE — envelope 'packs' metadata; classify before mutation; localized refusals; storage byte-untouched on refusal |
| Atomic activation | DONE — stage-everything then single journaled commit; compensating rollback; session-permanence enforced |
| Deterministic identity | DONE — order-independent canonical digests; topo order + ascending-id tie-break dense indices; zero-pack boot preserves base fingerprint exactly |
| Multiplayer compatibility | DONE — protocol v4 hello/welcome packs meta; server gates fresh join AND rejoin pre-binding; client cross-checks welcome |
| Fixture pack | DONE — packs/testpack.js through provide→activate→craft/place/mine/summon/loot/save/reload, incl. browser journey P |
| MOD-004 | RESEARCH ONLY — ADR with DEFER recommendation; no runtime code |

## Security decisions

- Untrusted-input pipeline: parse → structural → semantic/reference →
  dependency/version → identity → staged → atomic commit; every arrow fails
  closed (see ARCHITECTURE §29 for the full rejection list).
- Prototype-pollution keys rejected wherever they appear; functions/symbols
  and non-finite numbers rejected at scan time (programmatic API included).
- Namespace rule: stable ids are always `<packid>:<key>`; reserved namespaces
  ('core', 'tc', 'system') cannot be provided; bare-key collisions with
  built-in tables reject activation.
- Boss machinery is unreachable to packs (ai allow-list excludes boss
  archetypes; summons require target boss:true which routes only through the
  existing encounter lifecycle).
- No eval/new Function/script injection anywhere; no pack-supplied callbacks;
  ai/look/pattern/station references resolve against built-in registries only.
- Resource locale fragments are presentation-only additive layers with undo
  handles; they cannot touch machine identity or authoritative state.

## Registry / identity fingerprints

- Base built-in fingerprint: `1b1d7c15` / 374 stable ids — unchanged by this
  campaign (zero-pack boots proven identical in loader + activation suites;
  regression-guarded by tools/check-i18n.js which still passes).
- With fixture pack active: registry fingerprint `f274a2c0`, counts
  158 items / 59 tiles / 33 enemies / 100 recipes (all built-ins intact at
  their historical indices — append-only growth asserted per-index).
- Fixture pack-set digests: gameplay `97f8ff42`, full content `715306e0`.
  Deterministic across realms and repeat activations (asserted).

## Save compatibility matrix

| Save made with | Loaded with | Result |
|---|---|---|
| pre-W25 envelope (no packs field) | base | loads unchanged |
| pre-W25 envelope | fixture active | loads + informational warning |
| fixture save | same set | compatible; continue works |
| fixture save | pack removed (build without it) | refuses on title; names testpack@version; storage bytes identical |
| fixture save | different version of same pack | refuses: incompatible-version diagnostic |
| malformed packs metadata | anything | refuses: malformed-metadata status |
| legacy v1 blob | anything | unaffected path (validated separately) |

Full remove/restart/restore cycle exercised in tests/packs/save-compat.test.js.

## Multiplayer compatibility matrix

| Host | Client | Outcome |
|---|---|---|
| fixture | same digest | joins; welcome echoes identity |
| fixture | wrong fp | reject 'content-mismatch host=… client=…' BEFORE player binding; no entity/snapshot/world mutation; rejoin path gated identically |
| fixture+resource pack | fixture only | JOINS — resource packs excluded from gameplay digest by construction |

Protocol bump justification: pack identity must be proven before ANY world
state flows; v3 had no field to carry it. v1/v2/v3 still reject cleanly
('expected 4'); old-version matrix re-pinned in proto suite.

## Adversarial coverage

Loader suite: malformed JSON/oversize/null, bad ids, unknown schema version,
bad versions/ranges, type violations, self/cyclic deps, missing deps, game
range mismatch, duplicate id (idempotent vs conflicting), prototype pollution
(JSON-smuggled __proto__), function smuggling, NaN/Infinity, depth bombs,
reserved namespaces, traversal/absolute/backslash/dot resource paths, family
size caps, per-field bounds, ghost references (item/tile/enemy/station/ai/
pattern), unknown privileged fields, canonical-digest determinism.
Fuzz harness: seeded generator over the whole surface — 400 rounds default,
0 escapes (only PackErrors leave the API; live tables never mutate without a
successful activation). Activation suite adds rollback coherence, session
permanence, subset-stable ordering, cross-pack references, and the full
gameplay chain through canonical transactions.

## Discovered defects & root causes (this campaign)

1. **Boot-timing race on pack tile indices** — main.js booted (and activated
   packs) before wiring.js executed; wiring appends pump TILES at its own
   script-load time, so a boot-activated pack tile received an index that
   later shifted relative to post-reload expectations. Root cause: activation
   ran inside main's IIFE instead of after ALL classic scripts. Fix:
   DOMContentLoaded-deferred bootRegistry() (immediate fallback headless).
   Symptom caught by journey P asserting the appended tile's localized name.
2. **Intra-pack cyclic family references** — tile.drop → own item while items
   stage after tiles. Fixed with a nominal reservation pass (stable ids +
   legacy keys registered before reference validation) plus deferred
   summon-target policy checks.
3. **Ambiguity false positives** — reservation pushed two map views of one
   entry; resolver now dedupes candidate stable ids.
4. **load-game ignored non-js/ scripts** — headless realms silently skipped
   packs/testpack.js (index.html is the source of truth; loader now honors
   repo-relative entries).
5. **PackError messages hid details** — assert.throws regexes and UI reasons
   matched nothing useful; errors now lead with the first detail line.

## Tests added / run (exact counts)

- tests/packs: loader (8), activation (8), save-compat (4),
  multiplayer (3) = **23 cases**, all green repeatedly.
- tests/net/proto.test.js: +1 case (v4 packs-schema matrix); version-gate
  case updated to pin 'expected 4'. Net suite: 70/70.
- Full node gate (`npm test`, now including tests/packs): **597 pass /
  0 fail** (was 573 pre-campaign +24 net-new cases minus none removed).
  Run twice back-to-back with identical results (deterministic).
- Browser journeys: **30 passed** (A–O + new P) in the final clean full run;
  an earlier full-suite run failed journey M once under concurrent benchmark
  CPU load (root-caused to documented host-load calibration sensitivity —
  benchmarks were running simultaneously; solo rerun green; final clean run
  green with no concurrent processes).
- Fuzz: `node tools/fuzz-packs.js 400 20260826` → accepted 17 / rejected 782
  events / **escapes 0**. Re-run with seed 20260826 twice → identical output.

## Browser journey results

Journey P (new): real clicks open title Content Packs panel → toggle row →
Apply & Restart (genuine reload) → active set + identity proven (base
fingerprint preserved, built-in indices intact) → deterministic world →
craft Tempest Shard via TC.Crafting → PlaceTile/MineTile round-trip on the
appended tile index → UseItem summons Tempest Wisp (boss:true) → kill drops
collected → real save → page reload → Continue from title → content and
world coherent → classification compatible → zero console/page errors.
Runtime 16.6 s.

## Benchmark measurements (tools/bench-packs.js, Node 24, Windows)

- Boot median of 7: 61.1 ms base vs 48.5 ms fixture-active (delta −12.6 ms =
  measurement noise; boot cost dominated by script eval, no regression).
- Full activation transaction: 1.916 ms median of 9 (one-time, boot only).
- Idempotent re-setActive: 0.133 ms.
- Registry.legacyToStable ×200k: 31.2 ms (base) vs 12.8 ms (warm JIT run)
  vs 14.9 ms resolving pack refs — parity within noise; no hot-path cost.
- Save envelope: +96 bytes with fixture metadata (45 013 → 45 109).
- saveNow / continueGame: within noise of base (930/1957 ms vs 729/1331 ms —
  dominated by worldgen baseline rebuild, not packs).
- classifySave ×50k: 56 ms (≈1.1 µs/op, once per load attempt).
- v4 hello encode: 141 bytes including pack identity; decode ×50k unchanged.
- Existing gates: bench-runtime 600 ticks unchanged (queue 0.19 µs/drain);
  bench-scenarios --quick medians consistent with the W25 perf-package
  baselines recorded in docs/PERFORMANCE.md (e.g. projectiles 2.14 ms/tick,
  worldgen 644 ms/op).

## CI runs

Final pushed-head run: GitHub Actions on the last commit of
`git log eda8fdf..HEAD`. Local full gate on the final tree (this exact HEAD)
= `npm run validate` exit 0 with stage evidence re-captured individually:
syntax **57 files / 0 failures**; check:i18n green — catalog 554 fallback
keys, "registry fingerprint matches the W24 baseline: 1b1d7c15", "374 stable
ids match the W24 baseline exactly", "368 pre-W24 stable ids verified
unchanged"; npm test **597 pass / 0 fail**; release build + verify-dist exit
0; browser suite **30 passed**. The campaign is not terminal until the
authoritative pushed head is green; if reading this and unsure, check
Actions for HEAD.

## Remaining limitations

- Pack families: walls, NPCs/shops, standalone loot tables, projectiles,
  buffs, biomes are NOT yet pack-extensible (rationale in ARCHITECTURE §29).
- No mid-session deactivation: changing the active set requires Apply &
  Restart (dense-index stability trade-off, deliberately chosen).
- Pack distribution is build-provided only (no file/import UI in W25;
  provideJSON exists as the future import seam).
- Natural spawning of pack enemies is not wired into zoneTable (fixture enemy
  is summon-reachable; spawn-table extension is a natural W26 candidate).
- mp-server has no --packs flag yet (host uses its Settings/boot path).

## Recommended W26 candidates

1. Extend pack families: walls + loot tables first (lowest risk), then
   NPC/shop stock rows and projectile types.
2. zoneTable extension grammar for pack enemies (spawn integration).
3. Pack import/export UX over provideJSON + localStorage-installed sources.
4. mp-server --packs flag + journey exercising MP with an active fixture pack
   end-to-end over real WebSockets.
5. MOD-004 remains deferred unless a concrete capability gap emerges (ADR).

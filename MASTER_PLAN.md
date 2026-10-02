# MASTER_PLAN.md — clone-terraria Repository Audit & Execution Specification

> **Status:** canonical execution specification for the next implementation agent.
> **Produced by:** a read-only, evidence-driven repository audit (no product code changed).
> **Audit date:** 2026-09-30 · **Audited commit:** `0c5ed45` (branch `main`)
> **Companion artifacts:** nine validated OpenSpec changes under `openspec/changes/`.

This document is the single index. **The per-change specifications are the
authoritative execution detail** — this plan tells you *what order, why, and
what "done" means*; each change's `proposal.md` / `specs/*/spec.md` /
`design.md` / `tasks.md` tells you *exactly what to build*.

---

## 1. Executive Summary

### What the project is

`clone-terraria` is an original-assets, from-scratch Terraria-style 2D sandbox
game: ~40,200 lines of vanilla JavaScript, HTML5 Canvas, no framework, no build
step, no external assets. All graphics are drawn procedurally and all audio is
synthesized with WebAudio. Single global namespace `window.TC`, ~58 IIFE
modules, fixed script load order in `index.html`.

### Overall maturity: **high, and demonstrably verified**

This is not a prototype. It has genuine production engineering:

- **Deterministic simulation authority.** One fixed-step host
  (`TC.Runtime.tick` → `TC.Systems.updateAll`) over a declared 12-phase
  schedule; every discrete world mutation flows through the canonical
  `TC.Commands` transaction layer with a deterministic per-tick FIFO queue;
  rendering dispatches exclusively through `TC.RenderLayers`.
- **A real multiplayer stack.** Authoritative server, clients propose intents
  only, a versioned fail-closed protocol (v4) with bounded schemas, a command
  whitelist, server-side eligibility checks, baselined region replication with
  tombstones and keyframes, and a presentation-only client mirror with
  prediction and reconciliation.
- **A hardened extensibility boundary.** `TC.Packs` treats pack input as
  untrusted: parse → structural validation → semantic validation → dependency
  ordering → staged registration → atomic commit, with no `eval`, no callbacks,
  and prototype-pollution keys rejected.
- **A deterministic RNG authority** (`TC.GameRng`) with named streams,
  `state()/restore()/digest()` for replay proofs.
- **Strong, honest documentation** (`AGENTS.md`, `docs/ARCHITECTURE.md`
  72 KB, `docs/TASK_BOARD.md`) with a per-file ownership contract.

### Baseline verification (all run at audited HEAD)

| Gate | Result |
|---|---|
| `npm run check` (syntax, 58 files) | **pass** — 0 failures |
| `npm run check:i18n` | **pass** — catalog valid, 577 keys, fingerprint `1b1d7c15` matches W24 baseline |
| `npm test` (node:test) | **pass** — **667/667** |
| `npm run build` | **pass** — 58 js files, 60 assets |
| `npm run verify:build` (production Chromium boot) | **pass** — zero browser errors |
| `npm run test:browser` (Playwright) | **pass** — **33/33** |
| `tools/fuzz-packs.js` (security boundary) | **pass** — 0 escapes |
| `tools/bench-packs.js`, `tools/bench-runtime.js` | run clean |

**The green baseline is real but it is not sufficient.** The audit found two
P0 defects that every one of those gates passed, because the gates are
parse-level and smoke-level, not semantic.

### The two P0 findings (both runtime-proven during the audit)

1. **`js/ui.js` calls an undefined function.** `joinedActive()` is called at
   two container-transfer sites and **defined nowhere in the repository**.
   `js/ui.js` is `'use strict'`, so this is a hard `ReferenceError`. Any player
   who opens a chest and Shift-clicks an inventory slot gets a silently dead
   interaction — in single-player too. It survived because (a) nothing checks
   for undefined identifiers, (b) `TC.RenderLayers.drawLayer` swallows drawer
   errors after logging the first three, and (c) **no test in the repository
   presses Shift** (`grep -rn "Shift" tests/` → nothing).

2. **`TC.Players` goes stale across world transitions.** `NetServer.stop()`
   retains the host's local primary, and *no* world-creation path
   (`newGame`, `continueGame`, `Runtime.createWorld`) ever resets the registry.
   `TC.Players.resetForNewWorld()` exists, is documented, is unit-tested — and
   is **never called by production code**. Result: host a session → quit to
   title → start a new single-player game, and the **new player never
   simulates** (no gravity, no movement, no collision) while the discarded
   old player simulates invisibly, and enemy targeting converges on the ghost.
   Reproduced headlessly through the real flow.

### Major strengths to preserve

- The convergence campaign (runtime authority, commands, render layers) is
  genuinely excellent architecture — one authority per concern, no legacy
  parallel paths in the browser host.
- The multiplayer trust boundary is correct in the places that matter:
  client-declared `dt` is overridden server-side, inventories resolve to the
  acting player, shops require an NPC in reach, containers require a
  server-bound session, recipes resolve from a stable id only.
- The save layer is atomic, versioned, migration-chained, and defensive.
- Localization is treated as a first-class contract with a real gate.

### Major weaknesses

- **No static analysis of any kind.** This is the single highest-leverage gap:
  it is the direct cause of both P0s.
- **Semantic blind spots in the test suite.** 700 green tests, no Shift key, no
  keyboard menu navigation, no post-session-teardown lifecycle test.
- **Security/stability harnesses exist but are not gated.** The pack fuzz
  harness and the multiplayer soak are not in `npm run validate` or CI.
- **Document truth lags code truth.** A parallel 2026-08-29 planning doc set
  asserts ratings that are now false.
- **Some project rules are prose-only and therefore violated.**
  The W23 "all replicated randomness via `TC.GameRng`" rule is violated in
  `js/loot.js` and nothing detects it.

### Recommended end state

**Not a rewrite.** This codebase's architecture is sound; it needs
**stabilization and enforcement**, not redesign. The end state is: the two P0
defects fixed, a static-analysis + fuzz + soak gate that makes that class of
defect impossible to ship again, the project's own written rules made
machine-enforced, persistence failures made visible, storage accounting made
exact, menus made keyboard-operable, and the documentation made true.

---

## 2. Repository / System Overview

### Top-level layout

```
index.html            fixed <script> load order — THE single source of truth
css/style.css         page styles
js/            (58)   runtime modules, all IIFEs attaching to window.TC
js/locales/en.js      English fallback catalog (577 keys)
packs/testpack.js     fixture data pack (W25/W26 pipeline proof)
tests/          (86)  node:test suites in 8 groups + Playwright journeys
tools/          (16)  dev server, release build, verifier, benches, fuzz, soak
openspec/             spec-driven change ledger (1 pre-existing + 9 from this audit)
docs/                 ARCHITECTURE.md, TASK_BOARD.md, PERFORMANCE.md, handoffs
.github/workflows/ci.yml   single-job gate: `npm run validate`
package.json          dev dependency: @playwright/test ONLY
```

### Architectural boundaries

| Layer | Modules | Contract |
|---|---|---|
| **Host** | `main.js`, `runtime.js` | Canvas lifecycle, state transitions, system/render registration, the single tick authority. Headless embeds use `Runtime.createWorld`/`advanceTicks`. |
| **Authority** | `systems.js` (scheduler + render layers), `commands.js` (transactions), `registry.js` (stable ids + fingerprint), `events.js` (deferred bus), `worldregions.js` (invalidation) | One authority per concern. Modules register into these; they never bypass them. |
| **World** | `world.js`, `worldgen.js`, `tiles.js`, `liquids.js`, `lighting.js`, `sky.js`, `biomes.js` | Deterministic generation; chunked rendering; volume-based liquids; RGB light field. |
| **Gameplay** | `player.js`, `enemies.js`, `enemyai.js`, `enemydefs.js`, `enemyspawn.js`, `combat.js`, `projectiles.js`, `gear.js`, `magic.js`, `fishing.js`, `grapple.js`, `accessories.js`, `stats.js`, `loot.js`, `lootables.js` | Simulation. All replicated randomness must come from `GameRng`. |
| **Content** | `constants.js` (lead-owned tables), `crafting.js`, `npcs.js`, `economy.js`, `progression.js` | Declarative data + progression gate (`Progression.test`). |
| **Presentation** | `ui.js` (100 KB), `minimap.js`, `particles.js`, `input.js`, `debug.js`, `audio.js`, `music.js` | Immediate-mode canvas UI driven by a per-frame rect layout. |
| **Persistence** | `savecore.js` (envelope/providers/migrations/atomic write), `save.js` (facade), `settings.js` (user prefs, outside saves) | v2 envelope under `tc_save_v2` with `.bak`/`.tmp`; v1 legacy fallback. |
| **Extensibility** | `packs.js` (102 KB), `packstore.js`, `localization.js` | Untrusted-input boundary; session-permanent activation; pack identity rides saves and the v4 handshake. |
| **Multiplayer** | `netproto.js`, `nettransport.js`, `netserver.js` (49 KB), `netclient.js`, `players.js`, `targeting.js` | Protocol v4, authoritative host, presentation mirror client. |

### Primary execution flows

**Frame (browser):** `rAF` → `TC.Runtime.tick(1/60)` (or `NetClient.frame` when
joined) → `Systems.updateAll` across 12 phases → `RenderLayers.drawWorld` under
the camera transform → `RenderLayers.drawScreen` → `Input.endFrame()`.

**Fixed tick:** `input` (UI + player-intent creation) → `commands` (queue drain,
then network commands) → `environment` → `movement` (grapple-pre → player →
grapple-post → loot) → `physics` → `projectiles` → `ai` (fishing → spawn
director → enemies → npcs) → `items` → `combat` → `liquidsWiring` (world chunks
→ wiring → liquids) → `progression` (lighting → music → minimap → autosave) →
`eventsFlush`. Title/paused run only UI + event flush.

**Save:** provider `serialize()` → versioned envelope → atomic write
(tmp → verify → bak → main). Load: main → bak → migrate → validate → provider
`deserialize()`.

**Multiplayer tick:** `processInbound()` → `Runtime.tick()` → `replicate()`
(per-client region interest + entity deltas under a byte budget).

### Build / test / release structure

- **Build:** `tools/release-build.js` assembles `dist/` as *exactly what
  `index.html` references*, runs `node --check` on every shipped file, and
  stamps `build.json` with version + HEAD sha (no wall clock, so rebuilds are
  byte-identical).
- **Verify:** `tools/verify-dist.js` boots the real `dist/` in Chromium and
  fails on any console error, a blank canvas, or a broken save/continue.
- **CI:** one job, `npm run validate` = `check && check:i18n && test && build
  && verify:build && test:browser`, Node 22, Playwright Chromium cached.
- **Linting/type-checking: none.** `node --check` is parse-only.

### Persistence model

localStorage, three concerns:
- `tc_save_v2` (+ `.bak`, `.tmp`) — the world/character/system envelope.
- `tc_settings_v1` — user preferences (locale, lighting quality, active packs),
  deliberately **outside** saves.
- `tc_packs_installed_v1` — installed pack manifests (64 max, 256 KiB each,
  4 MiB total — see the byte-accounting finding).

---

## 3. Current-State Assessment

### Complete and healthy

Little or no additional work needed:

- **Runtime authority convergence** (W18) — genuinely excellent. One tick
  authority, one command path, one render path; headless boundary that runs the
  real game loop with no Canvas/DOM/rAF.
- **Save format and atomicity** — versioned envelope, migration chain, provider
  registry, atomic write, `.bak` fallback, legacy v1 migration, export/import.
  Covered by 7 save suites including `atomicity` and `corruption`.
- **Worldgen determinism** — v3 named passes, per-pass RNG streams, a corpus
  test proving byte-identical output across processes and interleaved
  generation, and structural coverage of every biome across seeds.
- **Network protocol validation** — strict fail-closed envelope, bounded
  per-command ctx schemas, command whitelist, message-type direction checks,
  region full/delta codecs, deterministic digests.
- **Server-side authorization** — cadence, inventory, shop reach, container
  session, and recipe identity are all resolved server-side.
- **Pack security pipeline** — fail-closed at every stage; verified by a fuzz
  harness at 0 escapes.
- **Localization catalog** — 577 keys, full content-name coverage, frozen
  registry identity with a CI-enforced fingerprint.
- **Performance (W27)** — 1,229 → 204 idle canvas ops/frame, night 842 → 17,
  startup 494 → 5 chunk rebuilds, liquid region marks 24,968 → 352, with a
  machine-independent browser perf gate that has a verified negative control.

### Implemented but requiring hardening

- **UI layer** — largest file in the project, on the critical input path, with
  no keyboard access and the confirmed P0 crash.
- **Persistence failure handling** — correct on success, silent on failure.
- **Pack resource accounting** — enforced in UTF-16 units, documented as bytes.
- **Localization presentation discipline** — enforced for catalog *coverage*
  and *identity*, not for presentation *paths*.
- **Multiplayer session lifecycle** — correct within a session, defective
  across world transitions.

### Partial

- **Menu accessibility** — all surfaces are pointer-only (WCAG 2.1.1 failure).
  Screen-reader support is structurally absent (inherent to canvas) and is
  explicitly deferred.
- **Static analysis** — does not exist.
- **Secondary-language catalogs** — the engine, validator, and tests accept
  `js/locales/<id>.js` with zero code changes, but only `en` ships. Correctly
  documented as open work, not a defect.

### Missing

- **A static-analysis gate** (undefined identifiers, duplicate members,
  unused vars) — the highest-leverage missing piece.
- **Keyboard operability** of every menu and panel.
- **Persistence health observability** (`SaveCore` has no counters at all).
- **Multi-byte-correct storage accounting.**
- **Regression coverage for session-teardown → new-world**, and for
  Shift-click container transfer.
- **Executable mod runtime (MOD-004)** — deliberately research-deferred by ADR,
  *not* a gap to close.

### Problematic / defective

| ID | Defect | Severity | Change |
|---|---|---|---|
| D1 | `joinedActive()` undefined → Shift-click chest transfer throws | **P0** | `fix-ui-chest-quick-move-crash` |
| D2 | `TC.Players` stale across worlds → player never simulates | **P0** | `fix-player-registry-world-transition` |
| D3 | Pot loot uses `Math.random()` (W23 rule violation) | P1 | `enforce-gamerng-replicated-loot` |
| D4 | No static analysis; fuzz/soak not gated | P1 | `add-repository-quality-gates` |
| D5 | `js/world.js` has a duplicate dead `canShape()` method | P2 | `add-repository-quality-gates` |
| D6 | Pack/store byte caps measured in UTF-16, reported as bytes | P2 | `harden-pack-utf8-byte-accounting` |
| D7 | Autosave failure is silent; no persistence counters | P2 | `surface-persistence-failures` |
| D8 | Menus are pointer-only (WCAG 2.1.1) | P2 | `menu-keyboard-accessibility` |
| D9 | `def.name` used as display text and as runtime identity | P2 | `localization-presentation-hygiene` |
| D10 | Stale doc set; README fence; TASK_BOARD garble; fixture in `dist/` | P3 | `repository-truth-reconciliation` |

### Uncertain — requires runtime/environment validation

- **localStorage quota exhaustion in real browsers.** The audit proved silent
  failure with a stub. The browser quota unit was not measured and must not be
  assumed to be UTF-8. `surface-persistence-failures` addresses visible
  failure without depending on that unit. `harden-pack-utf8-byte-accounting`
  corrects the documented pack caps only.
- **Player-perceived cost of world transitions** (`continue` ≈ 1.65 s in the
  benchmark). Likely acceptable for the genre, but not user-tested.

`TC.Buffs.SOURCE_STATUS` is resolved: its only current key is `lava`. D9 does
not migrate that table.

---

## 4. Findings Register

Every finding below maps 1:1 to an OpenSpec change whose `specs/*/spec.md`
carries the normative requirements, `design.md` the decisions, and `tasks.md`
the ordered work. Confidence is stated explicitly.

### F-01 — `joinedActive()` is undefined (P0, **confirmed by execution**)

- **Where:** `js/ui.js` — `slotClick()` and the chest-grid branch of the click
  handler.
- **Evidence:** `grep -rn "joinedActive" js/ tests/ tools/` matches only the two
  call sites. Runtime probe driving `TC.UI.draw` with a chest open and Shift
  held on a filled slot produced `ReferenceError: joinedActive is not defined`.
  `js/ui.js` line 11 is `'use strict'`.
- **Why it matters:** a documented, ordinary interaction is dead in every game
  mode, and the W23 authoritative container transaction is unreachable from the
  UI. The error is swallowed by the render-layer counter, so it is invisible.
- **Root cause:** an incomplete refactor; the predicate was never written.
- **Correction:** implement it over `NetClient.active().isActive()`, not
  `drivesTick()`. `drivesTick()` is true during `connecting`, where
  `intent()` returns null and `txSubmit` would write locally. A thrown
  predicate must not fail open into mirror mutation.
- **Change:** `fix-ui-chest-quick-move-crash`.

### F-02 — `TC.Players` outlives its world (P0, **confirmed by execution**)

- **Where:** `js/main.js` (`newGame`, `continueGame`), `js/runtime.js`
  (`createWorld`), `js/netserver.js` (`stop`), `js/players.js`.
- **Evidence:** headless reproduction of the real flow printed
  `after newGame: primaryIsNewPlayer=false`, `new player simulated? false`,
  `Targets.anchor is new player? false`. `Players.resetForNewWorld` has zero
  production callers.
- **Why it matters:** a soft-locked, unplayable world with no error, reachable
  through the product's own title-menu flow. Enemies chase an invisible ghost.
- **Root cause:** world creation bypasses the identity registry; teardown
  retains an identity across a world boundary.
- **Correction:** reset when world construction proceeds, and make
  `Players.create` idempotent for the same player object before the browser
  re-seat. Do not re-seat inside `Runtime.createWorld` (that shifts the first
  dedicated-server remote off `p1`). Do not drop the local primary inside
  `NetServer.stop()`: `quitToTitle` saves after `stop()`, and `Players.remove`
  would null `TC.player` first. `Players.create` does not currently return an
  existing id.
- **Change:** `fix-player-registry-world-transition`.

### F-03 — Replicated-truth randomness bypasses `TC.GameRng` (P1, **confirmed**)

- **Where:** `js/loot.js` `breakPot()` — three `Math.random()` calls, annotated
  `// gameplay roll, not worldgen`.
- **Evidence:** source read; every comparable path (`items.js spawnDrop`,
  `lootables.js`, `combat.js`, enemy AI, spawns) uses a named stream;
  `tests/net/rng-replay.test.js` claims loot-roll coverage but never breaks a
  pot.
- **Why it matters:** breaks the seeded-authority invariant the project states
  for W23 and weakens the replay proof.
- **Change:** `enforce-gamerng-replicated-loot`.

### F-04 — No static analysis; security and soak harnesses ungated (P1, **confirmed**)

- **Where:** `package.json`, `.github/workflows/ci.yml`, `tools/`.
- **Evidence:** `validate` contains no linter. `tools/fuzz-packs.js` and
  `tools/soak-multiplayer.js` are absent from `package.json` and CI. A
  diagnostic `tsc --checkJs` pass surfaced the two real defects in F-01 and
  F-05 among 183 diagnostics, isolating them in 4 of 183 (≈2% true-positive
  rate) — the signal is high and the noise is two well-understood patterns.
- **Why it matters:** this is the systemic cause of F-01 being shippable, and
  it leaves the pack security boundary un-fuzzed on every push.
- **Change:** `add-repository-quality-gates`.

### F-05 — Duplicate `canShape()` class method in `js/world.js` (P2, **confirmed**)

- **Evidence:** two `canShape(x, y)` definitions; the second silently overrides
  the first, whose body is unreachable. A runtime probe confirmed the live
  implementation is the second (it matches `needsSupport === "below"`, matching
  its own comment about platforms passing).
- **Why it matters:** dead divergent code; a future edit to the first has no
  effect and misleads readers.
- **Change:** `add-repository-quality-gates` (task 3.1).

### F-06 — Pack/store byte caps measured in UTF-16 (P2, **confirmed**)

- **Where:** `js/packs.js` (`provideJSON`, `validateJSON`),
  `js/packstore.js` (load degrade, `install`, both quota checks).
- **Evidence:** `text.length > MAX_MANIFEST_BYTES` where the constant and the
  error message both say "bytes". Multi-byte content undercounts by up to 3×,
  so the documented 256 KiB / 4 MiB caps are not the enforced caps. The project
  already recorded this at `docs/HANDOFF-W26-…` line 84 and line 152.
- **Why it matters:** the documented byte cap is not the enforced cap for
  non-ASCII manifests. This does not by itself prove an origin-quota overrun;
  browser quota units were not measured.
- **Change:** `harden-pack-utf8-byte-accounting`.

### F-07 — Autosave failure is silent; no persistence observability (P2, **confirmed**)

- **Evidence:** probe with a byte-ceiling storage stub → `Save.save()` returns
  `false`, storage stays empty, autosave leaves the save unchanged, nothing
  surfaces. `js/savecore.js` contains no counters. `TC.Save.autosave` discards
  the boolean. Contrast `TC.PackStore`, which returns typed errors and keeps
  `lastLoadErrors`.
- **Why it matters:** silent, repeating, destructive progress loss. A player
  with full storage loses up to 30 s of progress every cycle indefinitely.
- **Change:** `surface-persistence-failures`.

### F-08 — All menus are pointer-only (P2, **confirmed**)

- **Evidence:** the only keyboard handling in `js/ui.js` is `Escape`, `KeyE`,
  and modifier reads; no focus, selection, or arrow-key navigation exists. The
  title screen cannot be operated without a mouse.
- **Why it matters:** WCAG 2.1.1 failure; blocks players using keyboards,
  switches, or input-assistive stacks from starting the game.
- **Change:** `menu-keyboard-accessibility`.

### F-09 — Frozen `def.name` used as display text and as runtime identity (P2, **confirmed**)

- **Where:** `js/main.js` (`drawDebug` — raw name + English concatenation),
  `js/enemies.js` (boss-toast fallback sentence; `trackHostileShot` /
  `clearHostileShotsOf` key shots by `shooter.def.name`), `js/fishing.js`
  (catch floater uses `d.name` although an `iName()` helper exists).
- **Evidence:** source read; `check:i18n` covers catalog and identity, not
  presentation paths.
- **Why it matters:** violates the project's own mandatory W20 contract; the
  hostile-shot case is a correctness bug. Both `clearHostileShotsOf` loops,
  including the `magic_bolt` cleanup, compare display names. Do not keep a
  name fallback. `SOURCE_STATUS` is `lava` only and is not migrated.
- **Change:** `localization-presentation-hygiene`.

### F-10 — Document and artifact truth drift (P3, **confirmed**)

- **Evidence:** `docs/terraria-parity/*` (last touched 2026-08-29) rates stable
  content IDs, save/versioning, automated testing, and module integration as
  Partial/Functional — all now done and gate-enforced. `README.md`'s command
  fence closes before its last two lines. `docs/TASK_BOARD.md`'s preamble
  contains a spliced duplicated sentence. `dist/packs/testpack.js` ships
  because `index.html` references it and the build copies every reference.
  `openspec status` reports `0/119` for a change whose own proposal says
  IMPLEMENTED.
- **Change:** `repository-truth-reconciliation`.

---

## 5. Target Architecture / Desired End State

The end state is the current architecture **plus enforcement**, not a different
architecture.

| Dimension | Target |
|---|---|
| **Architecture** | Unchanged in shape. One authority per concern stays; the changes add no new indirection except a focus model in the UI and a byte helper in the pack authority. |
| **Correctness** | The two P0s fixed with regression tests that fail on recurrence. The project prose rules (W23 randomness, W20 localization) become machine-enforced. |
| **Reliability** | Persistence failures classified, counted, and surfaced; storage reclaim attempted before giving up; atomicity preserved. |
| **Security** | Byte limits are the limits they claim to be. The existing fuzz harness runs on every push instead of on demand. |
| **Testing** | Semantic coverage where the gaps are proven: session-lifecycle coherence, container transfer both directions, keyboard operability, non-ASCII limits, same-name identity separation. |
| **Observability** | A consistent `stats()`/`counters()` convention extended to `SaveCore`; errors surfaced in the F3 overlay rather than swallowed. |
| **Performance** | No regression budget change. The gate keeps the W27 browser perf spec, which is already machine-independent with a negative control. |
| **Maintainability** | A static gate that makes undefined identifiers, duplicate members, and unseeded randomness impossible to merge. |
| **Accessibility** | Full keyboard operability of every menu and panel with visible focus. Screen-reader support explicitly out of scope and documented as such. |
| **Docs** | No document asserts something false. The historical audit is preserved but clearly marked superseded. |
| **Release readiness** | `npm run validate` becomes the complete gate: syntax → static analysis → i18n → unit/integration → fuzz → soak → build → production-boot verify → browser journeys → perf. |

**Explicitly not proposed:** a rewrite, a framework migration, a bundler, a
type system (FND-004 was superseded by the project and this audit does not
reopen it beyond the narrow rules above), a renderer replatform, an executable
mod runtime, or multiplayer beyond the current 4-player envelope.

---

## 6. Implementation Roadmap

Phases are ordered by dependency and blast radius, not by effort. Each phase
maps to specific OpenSpec changes.

### Phase 0 — Safety net (do this first; it makes every later phase verifiable)

**Change: `add-repository-quality-gates` (in report-only mode, tasks 1–3)**

- Add the static analysis in **report-only** mode; record the full finding list.
- Add `tools/check-rng.js` report-only with a call-site allowlist. Do not
  exempt whole files that also contain seed selection.
- Fix the one confirmed true positive the audit already found:
  the dead duplicate `canShape()` in `js/world.js`.
- Do **not** enable enforcement yet, and do not wire fuzz/soak yet.

**Why first:** a green baseline is what makes the P0 fixes provable. Flipping
enforcement later (Phase 1 end) is only safe because the true positives are
already fixed.

### Phase 1 — Critical defects

**Changes: `fix-ui-chest-quick-move-crash`, `fix-player-registry-world-transition`**

Both are P0, independent of each other, and independently shippable. Each ships
with its own regression test that fails without the fix.

- F-01 is a one-function fix; F-02 is a reset at a well-defined seam plus a
  lifecycle test.
- **Verify each with a negative control** (re-introduce the defect, see the
  test fail).

### Phase 2 — Make the project's own rules enforceable

**Changes: finish `add-repository-quality-gates` (tasks 4–6),
`enforce-gamerng-replicated-loot`**

- Fix the pot-loot randomness, extend the replay proof to actually break pots
  (and verify the proof fails if the fix is reverted).
- Flip the static and randomness gates to enforcing only after the P0
  undefined-call fix and the pot-randomness fix have landed.
- Make the soak exit non-zero on leftover players, detached identities, or
  connections before wiring it into `validate`. A printed summary is not a
  gate.
- Now that the two P0s are fixed, the gate has a clean true-positive history to
  point at.

### Phase 3 — Reliability and resource integrity

**Changes: `surface-persistence-failures`, `harden-pack-utf8-byte-accounting`**

- Both concern storage. They are independent but complementary: F-07 makes
  storage failure *visible*, F-06 makes the pack store not *cause* it.
- Order within the phase is free.

### Phase 4 — Architecture-adjacent correctness and hygiene

**Change: `localization-presentation-hygiene`**

- Stable hostile-shot identity (a real correctness fix, not just i18n).
- Remaining presentation paths.
- The checker in `check:i18n` prevents regression.

### Phase 5 — UX / accessibility

**Change: `menu-keyboard-accessibility`**

- Ship surface-by-surface (title → pause → packs → shop/craft). Each surface is
  independently valuable and independently revertible.
- Land after the UI is quiet from the P0 fix, because this is the largest and
  riskiest file.

### Phase 6 — Truth reconciliation

**Change: `repository-truth-reconciliation`**

- Independent of everything else; do it first or last, whichever keeps the diff
  readable. It also reconciles the W26 ledger, which should happen last so it
  reflects the final state.

### Phase 7 — Final certification

- Full `npm run validate` at final HEAD, twice, clean.
- Manual confirmation of every P0 user flow.
- Negative controls for each new gate.
- Confirm `dist/` contains no fixture and rebuilds byte-identically.

### Change dependency order

```
Phase 0  add-repository-quality-gates (report-only)
            │
Phase 1  fix-ui-chest-quick-move-crash ─────┐  (independent of each other)
         fix-player-registry-world-transition ┘
            │
Phase 2  add-repository-quality-gates (enforce) + enforce-gamerng-replicated-loot
            │
Phase 3  surface-persistence-failures ─┐ (independent)
         harden-pack-utf8-byte-accounting ┘
            │
Phase 4  localization-presentation-hygiene
            │
Phase 5  menu-keyboard-accessibility
            │
Phase 6  repository-truth-reconciliation
            │
Phase 7  certification
```

**Parallelizable:** Phase 1's two changes; Phase 3's two changes. Everything
else is sequential by dependency or by file-contention on `js/ui.js`.
**File contention warning:** `fix-ui-chest-quick-move-crash` and
`menu-keyboard-accessibility` both edit `js/ui.js`. They must not be delegated
to concurrent agents.

---

## 7. Parallel Workstreams

| Lane | Changes | Files | Safe to parallelize? |
|---|---|---|---|
| **Critical fixes** | F-01, F-02 | `js/ui.js`; `js/main.js`, `js/runtime.js`, `js/players.js` | Yes, with each other (disjoint files). Do not treat `netserver.js` `stop()` as the F-02 release point. |
| **Enforcement** | F-03, F-04 | `js/loot.js`, `tests/net/rng-replay.test.js`; `package.json`, CI, `tools/` | Yes with Phase 1; the gate wiring must follow the P0 fixes |
| **Storage** | F-06, F-07 | `js/packs.js`, `js/packstore.js`; `js/save.js`, `js/savecore.js`, `js/debug.js` | Yes with each other (disjoint) |
| **Presentation/UX** | F-08, F-09 | `js/ui.js`, `js/enemies.js`, `js/enemyai.js`, `js/fishing.js`, `js/main.js` | **No** — both touch `js/ui.js`; sequence them |
| **Docs/artifacts** | F-10 | `docs/`, `README.md`, `tools/release-build.js`, `openspec/` | Yes, but reconcile the W26 ledger last |

**Coordination rules for multiple agents:**

1. One file, one owner at a time. `js/ui.js` is the single highest-contention
   file in the repository.
2. Land Phase 0 before any other lane, or accept re-baselining the findings.
3. Never let two agents touch `package.json` or `.github/workflows/ci.yml`
   concurrently.
4. `js/main.js` is **lead-owned** per `AGENTS.md` — changes to `newGame`,
   `continueGame`, and `quitToTitle` need lead sign-off.

---

## 8. Definition of Done

The project is complete and hardened when **all** of the following are true and
verifiably so.

**Functionality & correctness**
- [ ] The reported F-01 repro does not reproduce: Shift-click with a chest open
      moves the stack in both directions, solo and joined.
- [ ] The reported F-02 repro does not reproduce: host → quit → new world
      yields a simulating player that enemies actually target.
- [ ] No undefined identifier and no duplicate class member exists in `js/` or
      `packs/`, enforced by the gate.
- [ ] No `Math.random` on a replicated-truth path, enforced by the gate.
- [ ] Hostile-shot bookkeeping is keyed by stable identity, with a same-name
      separation test.

**Tests**
- [ ] A regression test exists for every P0 and **fails** when the fix is
      reverted (negative control proven for each).
- [ ] Lifecycle coverage: host → join → leave → quit → new world → continue.
- [ ] At least one test exercises the Shift key.
- [ ] Non-ASCII pack cap coverage exists.
- [ ] `npm test` and `npm run test:browser` pass with no skipped or quarantined
      cases beyond the two documented pre-existing conditional skips
      (`journey-e` accessory leg, `tests/net/transport` WebSocket availability).

**Build, lint, type-check**
- [ ] `npm run check` includes the static gate and passes.
- [ ] `npm run build` produces byte-identical output across two runs.
- [ ] `npm run verify:build` passes with zero browser errors.
- [ ] `dist/` contains no test fixture, and `dist/index.html` does not
      reference `packs/testpack.js`. The repository `index.html` tag stays.

**Security**
- [ ] Pack byte caps are enforced in exact UTF-8 bytes.
- [ ] `tools/fuzz-packs.js` runs in `validate` and reports zero escapes.
- [ ] Prototype-pollution, traversal, and unknown-field rejection remain intact
      (existing pack suites green).

**Reliability**
- [ ] A storage-capacity failure is classified, counted, and shown to the
      player at least once, rate-limited thereafter.
- [ ] Reclaim-before-fail is attempted and atomicity is preserved.
- [ ] `SaveCore` exposes counters; the F3 overlay renders them.

**Accessibility**
- [ ] Title, pause, packs, shop buy rows, and the crafting column are
      keyboard-operable, with a visible focus indicator. Shop and craft do not
      use Arrow or Space. Inventory grids, chest grids, equipment, and shop
      sell remain follow-up.
- [ ] No gameplay keybinding regressed (movement, jump, hotbar, Escape, E).

**Documentation**
- [ ] No document asserts a rating or status that is false.
- [ ] The historical `docs/terraria-parity/` set is clearly marked superseded.
- [ ] `AGENTS.md` and `docs/ARCHITECTURE.md` still match the code (spot check).
- [ ] The OpenSpec ledger reflects true completion state.

**CI/CD**
- [ ] `npm run validate` runs static analysis, i18n, unit/integration, fuzz,
      soak, build, production verify, and browser journeys.
- [ ] CI runs the same single command.
- [ ] CI failure diagnostics are uploaded.

**Repository state**
- [ ] `git status` clean; no stray probe scripts, no `dist/` or `test-results/`
      committed (both are gitignored — confirm).
- [ ] No TODO/FIXME/HACK introduced by this work.

**Unresolved defect threshold**
- [ ] Zero known P0. Zero known P1. Any remaining P2 is either fixed or
      recorded in `docs/TASK_BOARD.md` with an owner and a reason.

---

## 9. Final Implementation-Agent Instructions

1. **Read this entire master plan and the relevant OpenSpec change in full
   before changing code.** The `specs/*/spec.md` files are the requirements;
   `design.md` holds the decisions and the rejected alternatives; `tasks.md` is
   the ordered work. Where an older sentence in this plan disagrees with a
   revised spec, the spec wins. In particular: do not use `drivesTick()` for
   chest quick-move, do not release the host primary inside `NetServer.stop()`,
   do not pre-register a player in `Runtime.createWorld`, do not exempt whole
   files from the randomness gate, do not treat the current soak script as a
   failing gate, and do not remove `packs/testpack.js` from the shipped HTML
   by skipping the file copy alone.
2. **Verify repository state before starting.** Confirm HEAD, run
   `npm run validate` on a clean tree, and record the baseline. The audited
   baseline was `0c5ed45` with 667/667 node tests and 33/33 browser journeys.
3. **Do not blindly trust this plan.** It was produced from the state at
   `0c5ed45`. If the code has changed, reconcile the difference first — the
   findings may already be fixed, or may have moved. Re-run the reproduction
   steps in the proposals before "fixing" anything.
4. **Execute prerequisite work first.** Phase 0 (report-only gates) exists so
   that every later phase is provable. Phase 1's two P0 fixes come before any
   hardening.
5. **Preserve working functionality** unless a change explicitly calls for
   behavior change. Every change here is either a bug fix, an enforcement
   addition, or documentation — none is a redesign.
6. **Add regression coverage alongside every fix**, and prove the test fails
   without the fix.
7. **Validate every significant change** with the narrowest relevant suite
   first, then the full `npm run validate` before considering a phase done.
8. **Keep the repository clean.** No debug logging left behind, no probe
   scripts, no suppressed lint rules without a written justification.
9. **Update the plan as you go.** Tick tasks in `tasks.md`; if you discover that
   a finding is wrong, say so in the change and in this document rather than
   silently proceeding.
10. **Do not mark work complete without meeting its acceptance criteria.** The
    `tasks.md` verification sections and the Definition of Done above are the
    bar.
11. **Surface newly discovered high-impact defects** rather than ignoring them
    because they are not in this roadmap. Add a new OpenSpec change for
    anything P0/P1 you find.
12. **Perform final repository-wide certification** after implementation: the
    full Definition of Done, two clean `npm run validate` runs, and a manual
    pass over every user flow named in Section 8.

### Explicitly out of bounds for the implementing agent

- Rewriting sound subsystems to match a different design preference.
- Introducing a framework, bundler, or full type system (FND-004 remains
  superseded; only the narrow rules in `add-repository-quality-gates` are in
  scope).
- Implementing MOD-004 executable mods (research-deferred by ADR).
- Editing lead-owned files (`constants.js`, `main.js`, `index.html`,
  `css/style.css`, `AGENTS.md`) without lead sign-off — note that
  `fix-player-registry-world-transition` and `menu-keyboard-accessibility` both
  require small `main.js` changes.

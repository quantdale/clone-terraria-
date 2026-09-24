# W27 — Presentation Performance Recovery

**Status:** COMPLETED (2026-09-24; all required acceptance gates pass; WS5 and
WS1.4 remain explicitly deferred with recorded analysis)
**Planned-From:** `ca39da303e34e2eef1f6774dadbafe26df68b3c7`
**Planned-At:** 2026-08-29
**Execution-Started:** 2026-08-29
**Target-Branch:** `main`
**Campaign-Type:** performance investigation + render-path optimization + measurement-gate construction
**Execution entrypoint:** repository-native `goal` continuation (`/goal continue`, `continue`, or equivalent supported by the active harness)
**Full plan:** `docs/W27-PERFORMANCE-PLAN.md` (mission, evidence, findings, workstreams WS0–WS7, acceptance criteria — read this in full before continuing)
**Session handoff:** `docs/HANDOFF-W27-performance.md` (what actually landed, what was deferred and why, recommended next steps — read this too, it has the load-bearing detail)

**Prior campaign:** W26 is implemented and hardened but **not
OpenSpec-complete** — see `docs/HANDOFF-W26-pack-ecosystem-productionization.md`
for mandatory follow-ups. This file previously carried the W26 prompt in full;
that history remains in the handoff and `docs/W26-AUDIT.md`.

## Mission (condensed — full version in the plan doc)

The simulation is healthy (`bench-runtime`/`bench-scenarios` show sub-ms
ticks). Every existing perf tool measures it through a no-op stub Canvas 2D
context, so the presentation layer has never been measured and never been
optimized. On an idle scene the HUD health bar and sky parallax alone
accounted for ~85% of per-frame canvas operations, with the health bar
scaling linearly (and badly) with max HP. Fix the render path — without
changing any gameplay behavior, determinism, save format, protocol identity,
or visual output — behind a real measurement gate so this can't silently
regress again.

## Current truth (2026-09-24)

- WS0–WS4 and WS6–WS7 are landed. HUD is 4/4 ops and flat in max HP; sky is
  16.1 day / 17.0 night; lighting skips unchanged uploads; renderer and liquid
  invalidation targets are measured and documented.
- WS0.2's real-browser frame-time and operation gates pass, including the
  historical injected-regression negative control. The full browser suite is
  33/33 green.
- WS5 entity sprite batching and WS1.4 `UI.layout()` memoization remain
  explicitly deferred for the visual-fidelity/CPU reasons in the handoff.
- Final repository validation at `79786a4`: 667/667 Node, 33/33 browser,
  build + verify-dist, check 58/58, and i18n/fingerprint clean.

## Completion / truth-sync

1. `docs/W27-PERFORMANCE-PLAN.md` and `docs/HANDOFF-W27-performance.md` are the
   authoritative design and outcome records.
2. All accepted workstreams and the real-browser gates are complete; WS5 and
   WS1.4 remain intentionally deferred with recorded analysis.
3. This prompt is historical campaign context. Do not re-implement completed
   work or resume W27; start a new requirements-backed campaign instead.

## Non-negotiable preserved behavior

Unchanged from the plan (§5): zero gameplay change, determinism intact
(`TC.GameRng` stream order/count, world-byte digests), visual parity (any
quantization stated and justified), `TC.RenderLayers` remains the sole draw
authority, `TC.WorldRegions` multi-consumer invariant (no consumer steals
another's invalidation, no re-marking on eviction), `draw()` still repairs
visible holes synchronously (no proactive rebuild queue — documented
treadmill), no second update loop, save/protocol/pack identity untouched,
localization stays presentation-only, boot order is a contract, no failure
masking, no Critical/High regressions, no destructive Git behavior
(no force-push, `main`-only, never rewrite history).

## Git / agent operating rules

Same as prior campaigns: prefer several coherent, well-described commits over
one opaque commit. Commit messages should be reconstructable session
history. Push validated progress; never force-push. Update
`docs/HANDOFF-W27-performance.md` after each material milestone so a killed
session can resume without rediscovery.

## Completion audit (§7, 2026-09-03, HEAD `b4aec0d` → rebased = origin/main)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | bench-render + perf.spec exist, run clean, baselined | PASS | `tools/bench-render.js`, `tests/browser/perf.spec.js` + reference-machine baselines in `docs/PERFORMANCE.md` |
| 2 | Idle 1,229 → ≤250 @100hp | PASS | 204 (bench), ~225 (browser) |
| 3 | HUD flat within 5% | PASS | UI 4.0/4.0, ratio exactly 1.00x |
| 4 | Sky ≤20, UI ≤40 | PASS | Sky 16.1 day / 17.0 night / UI 4.0 |
| 5 | Stationary 300f: evictions ≈0 + viewport ceiling + memory doc | PASS | 9 (startup sweep only, zero churn), cap 30/~30MB, documented |
| 6 | Real-browser p95 meets budget + fails on injected regression | PASS | Quiet-host rerun and full 32/32 browser suite green; historical negative control still breaches every leg |
| 7 | Sim not slower | PASS | bench-runtime/scenarios within noise at every step |
| 8 | Zero behavior change, full validate green | PASS | 653/653 node + 32/32 browser + build/verify/i18n; fingerprint `1b1d7c15`, no GameRng stream touched |
| 9 | enemyspawn drift resolved | PASS | committed `8154001` (prior session) |
| 10 | No Crit/High regressions, PERFORMANCE.md corrected | PASS | scope warning + evidence tables + invariant sections |

Commits (all on `main`, pushed): `6f8019b` (WS0.2 gate), `bf4d844`
(WS2 sky), `ae89a48` (WS3 renderer), `e883eb4` (WS1.3 HUD strips),
`2e32154` (WS6 liquid coalescing), `b4aec0d` (WS7 docs), `7f32b1a`
(final night-sky budget/parity gate), `15bd4cc` (W26 dependency/security
hardening), `a905126` (W26 boot/wall/spawn hardening).
Deferred with analysis (plan §6/§8 updated): WS5 entity batching, WS1.4
layout memoization, night-sky 2-op residual. No force-push, no history
rewrite, no secrets, working tree clean except this file's status flip
(committed below).

# Design — add-repository-quality-gates

## Context

The repository has no static analysis. `npm run check` runs `node --check`
(parse-only) over 58 files; `npm run check:i18n` validates the localization
catalog and the registry fingerprint baseline. CI runs exactly
`npm run validate`. Nothing checks semantics.

The audit ran a diagnostic `tsc --checkJs` pass over `js/` (available globally
via the toolchain, never added to the repo) to size the opportunity. It produced
183 diagnostics that collapse to three useful classes and one noise class:

| Class | Count | Signal |
|---|---|---|
| `TS2339: Property 'TC' does not exist on type 'Window'` | 112 | Noise — the project attaches a `TC` global dynamically; TS cannot model it. |
| `TS2304: Cannot find name 'TC'` | 37 | Noise — `js/constants.js` (lead-owned) assigns the `TC` global. |
| `TS2304: Cannot find name 'joinedActive'` | **2** | **True positive** — the confirmed P0 (`js/ui.js:2182`, `js/ui.js:2322`). |
| `TS2393: Duplicate function implementation` | **2** | **True positive** — `js/world.js:431` and `js/world.js:450` both define `canShape`. |
| Late-property / tuple-arithmetic diagnostics | ~32 | Noise — dynamic API attachment; `loot.js` `POT_LOOT` tuple widening (runtime-correct). |

So the true-positive rate is 4 of 183 — roughly 2%. The signal is high and the
noise is confined to two well-understood patterns (`TC.*` globals, and
properties attached after object-literal creation), both of which a proper
linter configuration handles with a small, explicit allowance list.

Separately, the repository already ships harnesses that protect real properties
but are absent from the gate:

| Harness | Protects | In `validate`? |
|---|---|---|
| `tools/fuzz-packs.js` | pack security boundary (recorded: 400 rounds, 43 accepted, 756 rejected, 0 escapes) | **No** |
| `tools/soak-multiplayer.js` | long-session multiplayer identity/replication/teardown | **No** |
| `tools/bench-packs.js` | pack activation/classify/save-delta cost | **No** |
| `tools/bench-multiplayer.js`, `bench-runtime.js`, `bench-render.js`, `bench-scenarios.js`, `perf-probe-*.js` | performance budgets | **No** (only the browser `perf.spec.js` gate is in CI) |

`tools/bench-*.js` are measurement tools with pass/fail budgets only in some
cases; `fuzz-packs.js` and `soak-multiplayer.js` are pass/fail harnesses and
belong in the gate.

## Goals / Non-Goals

**Goals:**
- Catch undefined identifiers, duplicate members, and unseeded replicated
  randomness automatically.
- Put the existing pack security fuzz and multiplayer soak into the gate.
- Keep the gate fast enough to run on every push, and quiet enough to be
  trusted.

**Non-Goals:**
- Not adopting a full type system. FND-004 (`incremental JS type checking`) was
  explicitly SUPERSEDED by the project with the rationale that `node --check`
  plus registry validation suffices; this change revises that conclusion only
  for the *narrow* rules above, and does not re-open full type checking.
- Not reformatting the codebase or churning style.
- Not gating on the benchmark harnesses that are measurement-only (they stay
  manual/CI-optional); only pass/fail harnesses enter the gate.
- Not duplicating the i18n/fingerprint guard that already exists.

## Decisions

### D1: Use ESLint with a narrow, explicit rule set

Add ESLint as a dev-only dependency with `eslint.config.js` (flat config)
enabling a minimal rule set:

- `no-undef` (catches `joinedActive`)
- `no-dupe-class-members`, `no-dupe-keys` (catches `canShape`)
- `no-unused-vars` (report-only initially; see D3)
- `no-redeclare`, `no-unreachable`, `no-const-assign` (cheap, high value)
- `no-eval`, `no-implied-eval`, `no-new-func` (keeps the W25 "packs never
  execute code" property machine-enforced)

Global declaration: declare `TC` (and only `TC`) as a readonly global in the
config, which removes all 149 `TC`-related noise classes at once.

**Alternative considered — a hand-rolled Node script (no dependency).**
Attractive because the project has one dev dependency today and an explicit
"no external libraries" ethos for *runtime*. Rejected as the primary option
because `no-undef` and `no-dupe-class-members` require real scope analysis, and
hand-rolling that is itself a maintenance liability. **However**: if the
maintainer prefers zero new dependencies, an equivalent outcome is achievable
by running `tsc --checkJs` in a *filtered* mode that ignores the two known noise
codes and fails on `TS2304` (excluding the `TC` global) and `TS2393`. This is
recorded as the sanctioned fallback (D1-alt) and is proven to work by the audit
run that surfaced both defects.

### D2: Add a targeted randomness guard as a small custom check

The W23 randomness rule is not expressible as an ESLint core rule. Implement
`tools/check-rng.js`:

- a maintained allowlist of modules and line-contexts where ambient randomness
  is presentation-only (the audit enumerated them: `particles.js`,
  `accessories.js` burst effects, `magic.js` visual sparkles, `music.js` audio
  noise, `audio.js` noise buffer, `biomes.js` particle spawns, `tiles.js`/
  `sky.js` visual hashes, `main.js`/`ui.js` seed selection);
- the rule: any `Math.random` in a module not on the allowlist fails, unless
  the line is annotated with a recognized presentation marker comment.

Keep the allowlist small and comment-justified so it cannot silently grow into
a blanket exemption.

**Alternative considered — rely on the spec/AGENTS rule and code review.**
Rejected: that rule is exactly what `js/loot.js` violated, invisibly, for the
whole project lifetime.

### D3: Roll out report-only, then enforce

Sequence: add the checks in report-only mode, record the true-positive list,
fix the true positives (the duplicate `canShape` in `js/world.js`; the two
already-owned P0s come from their own changes), then flip to enforcing. Keep a
minimal, documented suppression file for any finding that is a genuine
false positive, with a required justification comment.

Rationale: a gate that fails on 183 pre-existing diagnostics will be disabled
within a day. A gate that starts clean and stays clean survives.

### D4: Wire `fuzz-packs.js` and `soak-multiplayer.js` into `validate` and CI

Add both to the `validate` script. Bound them: the fuzz harness already accepts
`[rounds] [seed]` arguments, so the gate runs a fixed default (the recorded
400-round seed); the soak harness must accept a bounded duration argument.
Neither may read wall-clock time in a way that makes CI flaky — both are
deterministic/virtual-time by design, which is why they are safe to gate.

**Alternative considered — run these on a separate nightly workflow.**
Rejected for now: the pack fuzz is fast (deterministic, in-process) and the
soak is bounded; both belong on the push path. A nightly job can be added later
for longer soak durations without changing the gate.

### D5: Keep `release-build.js` as the single source of asset truth

The build already runs `node --check` on every shipped file and asserts
byte-identical rebuilds. Static analysis runs in the `check` step, before the
build, and must cover the same file set — including `packs/*.js`, which ship in
`dist/`.

## Risks / Trade-offs

- **[New dev dependency in a dependency-light project]** → Dev-only, and
  D1-alt provides a zero-dependency path. The project's "no external
  libraries" rule is explicitly about *runtime/game* code and assets
  (see `AGENTS.md`); a linter does not ship in `dist/`.
- **[Gate noise / false positives]** → D3 rollout; the `TC` global declaration
  removes the dominant noise class; the allowlist is comment-justified.
- **[CI runtime increase]** → Measure the added seconds; the fuzz harness is
  in-process and fast. If `validate` grows materially, move the soak to a
  bounded short duration on push and a longer nightly variant.
- **[Rule churn causing churn in unrelated code]** → Do not enable
  stylistic/formatting rules. Only correctness rules, per the goal.
- **[A future contributor adds ambient randomness legitimately]** → The
  allowlist is reviewed like production config; each entry needs a stated
  reason.

## Migration Plan

1. Add ESLint (or the D1-alt filtered `tsc` harness) in report-only mode; run
   over `js/` and `packs/`.
2. Add `tools/check-rng.js` in report-only mode with the audited allowlist.
3. Fix true positives: the `js/world.js` duplicate `canShape` (dead first
   definition removed; the second is the live one per runtime probe).
4. Flip `no-undef`, `no-dupe-class-members`, `no-repe-keys`, `no-redeclare`,
   `no-eval`-family to enforcing; wire `check:static` into `check` and
   `validate`.
5. Wire `fuzz-packs` and `soak` into `validate` and CI; confirm pass locally.
6. Update `CONTRIBUTING.md` / `AGENTS.md` with the gate commands.
7. Reversible per step; no product behavior change.

## Open Questions

None blocking. D1 vs D1-alt is a maintainer preference on accepting a dev-only
linter dependency; both paths are proven and the implementer may choose.

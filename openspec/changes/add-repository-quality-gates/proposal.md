# Change Proposal: add-repository-quality-gates

- **ID**: add-repository-quality-gates
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P1 (systemic prevention for the two confirmed P0 defects and the duplicate-method defect)

## Why

The repository's automated gate is `npm run validate` =
`check && check:i18n && test && build && verify:build && test:browser`, where
`check` is `node --check` (parse only) and `check:i18n` is a catalog/fingerprint
guard. **There is no static analysis of any kind** — no linter, no undefined-
identifier check, no dead-code detection, no duplicate-member detection.

That absence is the direct reason two confirmed P0 defects shipped in a
release that passes 667 node tests and 33 browser journeys:

1. `js/ui.js` calls an undefined function `joinedActive()` in two container
   branches. Any static analysis with a `no-undef`-class rule catches this
   instantly. It survived because (a) nothing checks for undefined identifiers,
   and (b) the resulting `ReferenceError` is swallowed by the `TC.RenderLayers`
   per-drawer `try/catch` (which logs only the first 3 errors and then goes
   quiet), and (c) no test presses Shift.
2. `js/loot.js` violates the project's own W23 randomness rule with bare
   `Math.random()` in a replicated-truth path — a targeted lint rule or a
   grep-based guard would catch it.
3. `js/world.js` defines `canShape(x, y)` **twice** in the same class body (the
   second silently overrides the first; the first is unreachable dead code).
   A `no-dupe-class-members` rule catches this. (Confirmed: running TypeScript
   in `checkJs` mode over `js/` reported `TS2393: Duplicate function
   implementation` at `js/world.js(431)` and `js/world.js(450)`, plus
   `TS2304: Cannot find name 'joinedActive'` at `js/ui.js(2182)` and
   `js/ui.js(2322)` — both confirmed defects.)

Additionally, several **security and stability harnesses already exist in the
repository but are not wired into `npm run validate` or CI**, so they never
protect a release:

- `tools/fuzz-packs.js` — deterministic adversarial fuzzing of the pack
  security boundary (400 rounds, 0 escapes recorded). This is the primary
  security regression harness and it is **not** in CI.
- `tools/soak-multiplayer.js` — multiplayer soak. Not in CI.
- `tools/bench-packs.js`, `tools/bench-multiplayer.js`, `tools/bench-runtime.js`,
  `tools/bench-render.js`, `tools/bench-scenarios.js`, `tools/perf-probe-*.js` —
  measurement harnesses. Not in CI (the browser perf *gate* is in CI via
  `tests/browser/perf.spec.js`, but the Node harnesses are not).

This change adds a real static-analysis gate to the validation pipeline and
wires the existing security/stability harnesses into it, so the class of defect
above is caught by the gate rather than by a lucky manual review.

## What Changes

- Introduce a static-analysis step in the validation pipeline that reports
  undefined identifiers, duplicate class/object members, and unused/undefined
  variables across `js/` — configured to the noise floor observed today (the
  `TC.*` global-namespace pattern must not be flagged).
- Add a targeted rule (or equivalent check) preventing bare ambient randomness
  in modules that produce replicated world state, aligned with the documented
  W23 rule.
- Wire `tools/fuzz-packs.js` (pack security boundary) and the multiplayer soak
  into `npm run validate` and the CI workflow, with bounded runtime so the gate
  stays practical.
- Ensure the static gate has no false positives that would make it noisy or
  ignorable (a gate that cries wolf is a gate that gets disabled).
- Document how to run each gate and how to interpret failures.

**Not breaking**: the new checks are additive and initially run in a
report-only mode if needed during rollout, but the end state is that they gate.
No product behavior changes.

## Capabilities

### New Capabilities
- `repository-quality-gates`: the static-analysis and security/stability
  harnesses that must pass before a change is considered releasable, and their
  integration into the local validate pipeline and CI.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline)

## Impact

- **Code**: a new lint/static config and (if using ESLint) a dev dependency;
  `package.json` `validate` script; `.github/workflows/ci.yml`.
- **Existing code touched**: possibly small fixes to the newly-flagged real
  defects (the duplicate `canShape`, any unused vars surfaced) — but the
  confirmed P0 fixes themselves are owned by their own changes and this gate
  should not become the place they land.
- **Dependencies**: none at runtime. A linter would be a dev-only dependency;
  if adding a dependency is not acceptable, an equivalent standalone
  check-script using the already-available toolchain is acceptable.
- **Risk**: the main risk is a noisy gate. Mitigation: start report-only,
  land the true-positive fixes, then enforce. The duplicate `canShape` is a
  known true positive to fix as part of enabling enforcement.

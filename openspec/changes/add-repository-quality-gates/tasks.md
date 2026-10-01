# Tasks — add-repository-quality-gates

## 1. Static analysis — report-only rollout

- [ ] 1.1 Add ESLint as a dev-only dependency with a flat `eslint.config.js`
      enabling only correctness rules: `no-undef`, `no-dupe-class-members`,
      `no-dupe-keys`, `no-redeclare`, `no-unreachable`, `no-const-assign`,
      `no-eval`, `no-implied-eval`, `no-new-func`.
- [ ] 1.2 Declare `TC` as a project global in the config so the dynamic
      namespace pattern is not flagged (removes the dominant noise class).
- [ ] 1.3 Scope the config to `js/**/*.js` and `packs/**/*.js` (both ship in
      `dist/`).
- [ ] 1.4 Run the lint in report-only mode over the full file set and record the
      complete finding list.
- [ ] 1.5 Alternative path if a new dependency is unacceptable: implement a
      filtered `tsc --checkJs` harness that fails on the two proven signal
      classes (`TS2304` excluding the `TC` global; `TS2393`) and ignores the
      known noise codes. Document which path was taken and why.
- [ ] 1.6 Add a `check:static` npm script that runs the static gate in
      report-only mode for now.

## 2. Randomness guard

- [ ] 2.1 Add `tools/check-rng.js` that scans `js/` for `Math.random` and fails
      on any usage not covered by an audited allowlist (design D2).
- [ ] 2.2 Build the allowlist from the audit's enumeration of
      presentation-only call sites: `particles.js`, `accessories.js` (burst
      effects), `magic.js` (visual sparkles), `music.js`, `audio.js` (noise
      buffer), `biomes.js` (particle spawns), `tiles.js`, `sky.js` (visual
      hashes), `main.js` and `ui.js` (new-seed selection).
- [ ] 2.3 Require a justification comment on every allowlist entry so the
      allowlist cannot silently become a blanket exemption.
- [ ] 2.4 Add `check:rng` npm script.
- [ ] 2.5 Confirm the guard flags the `js/loot.js` pot-roll violation in
      report-only mode (it is owned by `enforce-gamerng-replicated-loot`;
      confirm the guard goes quiet after that change lands).

## 3. Fix true positives surfaced by the gate

- [ ] 3.1 Remove the dead first `canShape(x, y)` definition in `js/world.js`
      (lines ~431-448); the second definition (line ~450) is the live one,
      confirmed by a runtime probe of `TC.World.prototype.canShape`.
- [ ] 3.2 Triage every remaining report-only finding: fix genuine defects,
      suppress genuine false positives with a documented reason, and record the
      decision.
- [ ] 3.3 Confirm no product-code change was made purely to silence the gate
      without a real justification.

## 4. Wire fuzz and soak harnesses into the gate

- [ ] 4.1 Confirm `tools/fuzz-packs.js` runs deterministically and passes with
      its recorded default (400 rounds, seed 20260924, 0 escapes).
- [ ] 4.2 Confirm `tools/soak-multiplayer.js` accepts a bounded duration
      argument and passes; add one if missing.
- [ ] 4.3 Add both to the `validate` npm script.
- [ ] 4.4 Record the added wall-clock cost of each harness.

## 5. Enforce and integrate

- [ ] 5.1 Flip the static gate and the randomness guard from report-only to
      enforcing once the codebase is clean.
- [ ] 5.2 Wire the static gate and randomness guard into the `check` script so
      `validate` runs them before the test suites.
- [ ] 5.3 Update `.github/workflows/ci.yml` if any step ordering or caching
      needs adjusting; CI should remain a single `npm run validate`.
- [ ] 5.4 Add a CI failure-diagnostics artifact for the new gate output so a
      failure is diagnosable from the CI run.

## 6. Documentation

- [ ] 6.1 Document every gate in `CONTRIBUTING.md` with the exact local command.
- [ ] 6.2 Document the randomness allowlist policy in `AGENTS.md` next to the
      existing W23 randomness rule.
- [ ] 6.3 Document common static-gate failures and their fixes.

## 7. Verification

- [ ] 7.1 Run `npm run check` and confirm it now includes the static and
      randomness gates and passes.
- [ ] 7.2 Temporarily reintroduce an undefined identifier and confirm the gate
      fails; remove it and confirm it passes (negative control).
- [ ] 7.3 Temporarily reintroduce a duplicate class member and confirm the gate
      fails; remove it and confirm it passes (negative control).
- [ ] 7.4 Run `npm run validate` end to end and record total runtime versus the
      pre-change baseline.
- [ ] 7.5 Confirm the production build output (`dist/`) is unchanged in file
      set and still byte-identical across rebuilds.

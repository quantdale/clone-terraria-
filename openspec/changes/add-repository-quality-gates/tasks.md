# Tasks — add-repository-quality-gates

## 1. Static analysis — report-only rollout

- [x] 1.1 Superseded by 1.5 (D1-alt taken; ESLint not installed, no new
      dependency added; `tsc` 7.0.2 is already available globally).
- [x] 1.2 Same TC-global noise class handled by the 1.5 filtered harness
      (`TS2304` name `TC` and `TS2339` Window-TC excluded as noise).
- [x] 1.3 Scope equivalent in `tsconfig.check.json`: `js/**/*.js` +
      `packs/**/*.js`.
- [x] 1.4 Finding list recorded: 183 diagnostics, 4 signals (2× joinedActive
      TS2304, 2× canShape TS2393); full list classified by code in 1.5's
      report output.
- [x] 1.5 D1-alt TAKEN: `tools/check-static.js` + `tsconfig.check.json` run
      filtered `tsc --checkJs`; fails on TS2304 (excluding the `TC` global)
      and TS2393; all other codes are excluded as documented noise.
- [x] 1.6 `check:static` script added; runs report-only by default.

## 2. Randomness guard

- [x] 2.1 `tools/check-rng.js` added (call-site allowlist scan over `js/`).
- [x] 2.2 Call-site allowlist built; each entry names file + site substring
      + justification. `js/loot.js` intentionally unlisted.
- [x] 2.3 Every allowlist entry carries a `why` justification string.
- [x] 2.4 `check:rng` npm script added.
- [x] 2.5 Guard flags `js/loot.js:316/320/325` in report-only mode; will go
      quiet after enforce-gamerng-replicated-loot lands (Phase 2).

## 3. Fix true positives surfaced by the gate

- [x] 3.1 Dead first `canShape(x, y)` removed from `js/world.js`; the live
      second definition retained (world tests pass; TS2393 count 2 → 0).
- [x] 3.2 Triage record: the two remaining report-only signals are
      `joinedActive` TS2304 ×2 (js/ui.js:2182, js/ui.js:2322) — genuine
      P0, owned by fix-ui-chest-quick-move-crash (Phase 1), not suppressed.
      All other codes are the documented noise classes from design D1/D1-alt.
- [x] 3.3 No product-code change was made to silence the gate; the only
      product-code edit removed a dead duplicate method (a real defect).

## 4. Wire fuzz and soak harnesses into the gate

- [x] 4.1 Confirm `tools/fuzz-packs.js` runs deterministically and passes with
      its recorded default (400 rounds, seed 20260924, 0 escapes).
- [x] 4.2 Make `tools/soak-multiplayer.js` or its gate wrapper exit non-zero
      when post-stop player count, detached reconnect records, or connections
      are non-zero, and when the run throws. Bound it with the existing
      `--ticks` argument. A printed summary with exit 0 is not a pass.
- [x] 4.3 Add both to the `validate` npm script.
- [x] 4.4 Record the added wall-clock cost of each harness.

## 5. Enforce and integrate

- [x] 5.1 Flip the static gate and the randomness guard to enforcing only
      after `fix-ui-chest-quick-move-crash` and
      `enforce-gamerng-replicated-loot` have landed and the duplicate
      `canShape` is removed. Report-only may land before those changes.
- [x] 5.2 Wire the static gate and randomness guard into the `check` script so
      `validate` runs them before the test suites.
- [x] 5.3 Update `.github/workflows/ci.yml` if any step ordering or caching
      needs adjusting; CI should remain a single `npm run validate`.
- [x] 5.4 Add a CI failure-diagnostics artifact for the new gate output so a
      failure is diagnosable from the CI run.

## 6. Documentation

- [x] 6.1 Document every gate in `CONTRIBUTING.md` with the exact local command.
- [x] 6.2 Document the randomness allowlist policy in `AGENTS.md` next to the
      existing W23 randomness rule.
- [x] 6.3 Document common static-gate failures and their fixes.

## 7. Verification

- [x] 7.1 Run `npm run check` and confirm it now includes the static and
      randomness gates and passes.
- [x] 7.2 Temporarily reintroduce an undefined identifier and confirm the gate
      fails; remove it and confirm it passes (negative control).
- [x] 7.3 Temporarily reintroduce a duplicate class member and confirm the gate
      fails; remove it and confirm it passes (negative control).
- [x] 7.4 Run `npm run validate` end to end and record total runtime versus the
      pre-change baseline.
- [x] 7.5 Confirm the production build output (`dist/`) is unchanged in file
      set and still byte-identical across rebuilds.

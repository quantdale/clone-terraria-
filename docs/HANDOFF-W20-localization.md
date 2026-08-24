# Campaign Handoff — W20: Localization & Content Presentation (LOC-001..003)

Task ID: W20 (repository reconciliation + full localization epic as one
vertical migration).

Branch / commit: `main` (per owner instruction: all work lands on main,
locally and remotely; no campaign branch created).
Base at session start: `main` = `6cdebae` (W16 planning baseline) with the
completed W17–W19 history sitting on `origin/campaign/runtime-authority-
convergence` = `99d0caf`.
Session commits (all pushed):

- *(fast-forward, not a new commit)* `main` `6cdebae → 99d0caf`: reconciled
  the completed W17 Underworld Frontier + W18 Runtime Authority Convergence +
  W19 Underworld Spawn Truth-Sync campaigns onto main (18 commits, ff-only;
  ancestry verified: both historical branches are ancestors of the campaign
  tip and now of `main`).
- `cb6bc6d` feat(i18n): canonical localization runtime (`TC.Localization`),
  settings store (`TC.Settings`), English fallback catalog (`js/locales/en.js`),
  `LocaleChanged` event.
- `0d834ac` refactor(i18n): UI/content/dialogue/feedback migration without
  identity drift; NPC shop/dialog identity moved to stable types;
  `tools/check-i18n.js` + registry baseline snapshot wired into validate.
- `93c0624` test(i18n): 28 headless tests (service/coverage/identity blocker/
  persistence/determinism/npc-identity) + browser journey K + #test hooks +
  en-XA registration under '#test'.
- *(this commit)* docs(i18n): truth-sync AGENTS/ARCHITECTURE/TASK_BOARD/
  CONTRIBUTING/README + this handoff.

## Reconciliation performed

Verified before touching code: `origin/main` was `6cdebae`;
`feat/underworld-frontier` (91a8393) and
`campaign/runtime-authority-convergence` (99d0caf) were strictly ahead;
frontier ⊂ campaign ancestry held. Fast-forwarded `main` to `99d0caf`
(`git merge --ff-only`), ran the full gate on the result, pushed, proved
`main...origin/main = 0 0` and both containment checks. No local uncommitted
or unmerged work existed (checked branches/stash/status first). Historical
remote branches were left in place; nothing unique remains outside `main`.

## Behavior added or changed

1. **One localization authority.** `TC.Localization`: additive locale
   registration (nested catalogs flatten), English fallback ('en') with a
   visible `[key]` placeholder and warn-once diagnostics, `{name}`
   interpolation (missing variables stay literal and are reported — never
   `'undefined'`), Intl.PluralRules plural selection (deterministic one/other
   fallback), catalog validation incl. cross-locale placeholder parity,
   unique missing-key reporting, stats. Runtime switching needs no reload or
   save migration; emits `LocaleChanged`; syncs `document.documentElement.lang`
   and `document.title` when DOM is present.
2. **Locale preference lives OUTSIDE game saves.** New tiny generic
   `TC.Settings` store (`tc_settings_v1`, corrupt-safe, unknown-field
   tolerant). Deleting/importing/exporting worlds cannot touch locale; a
   stored-but-unavailable locale falls back for the session WITHOUT deleting
   the stored choice.
3. **Presentation migrated end-to-end.** Title/pause menus, HUD, inventory/
   chest/equipment/crafting panels, item+craft tooltips, shop rows and
   buy/sell feedback, death screen, boss bar, progression announcements
   (boss defeated / biome discovered / npc moved in), Blood Moon banners,
   summon-rejection feedback, mana/potion/crystal floaters, fishing quests/
   crates, life-crystal floaters, buff names/glyphs, minimap biome label and
   `[N] map` hint all render through the catalog. No new raw English string
   literals in presentation paths; word-order-assembling concatenation
   replaced by parameterized templates.
4. **Content coverage.** All displayable tiles (56), walls (11), items (151),
   enemies/bosses (32), NPCs, buffs (7), biomes (7 + poetic discovery titles),
   stations (3) and accessory prefixes resolve catalog names; original
   descriptions authored where content has real semantics (~50 items).
   Guide/Merchant dialogue pools (37 lines) moved into the catalog under
   registry-derived keys.
5. **NPC identity bug class closed.** Dialog state carries the stable npc TYPE
   plus the dialogue KEY (`UI.showDialog(npcType, lineKey)`); shop resolution
   matches type, never the localized display name; locale switches mid-dialog
   keep the same NPC, stock, prices and progression gates (proven headless +
   browser).
6. **Layout hardening.** Inventory action buttons size via measureText;
   craft-row and shop-row labels ellipsize before fixed right columns; the
   craftable/all toggle keeps its fixed rect. Verified under the stress
   locale in the browser journey.
7. **Pseudo-locale stress mode.** `en-XA` registers ONLY under '#test':
   deterministic accent mapping + vowel doubling (~+35% length) with wrap
   markers, placeholders preserved; used by tests/journeys, hidden from
   players.

## Public contracts changed

- NEW modules: `TC.Settings` (js/settings.js), `TC.Localization`
  (js/localization.js), `js/locales/en.js` (catalog). Script order in
  index.html: events → **settings** → **localization** → **locales/en** → …
- `TC.Events.EVENT`: + `LocaleChanged` (additive).
- `TC.NPCs`: + `displayName(type)`; dialog pools now hold CATALOG KEYS;
  `TC.UI.showDialog(npcType, lineKey)` signature change (only caller is
  npcs.js; legacy `(displayName, text)` form removed together with it).
- `debug.js __TEST__` (#test only): + `getLocale/setLocale/translate/
  getLocalizationStats/getMissingKeys`.
- package.json: + `check:i18n`; `validate` now runs check → check:i18n →
  tests → build → verify:build → browser suite.

## Save impact

None to world/character formats. `tc_save_v1`/`v2` semantics untouched; no
SaveCore provider changes; existing saves load unchanged. Locale preference
persists in the separate `tc_settings_v1` localStorage envelope. Registry
fingerprint recorded in save envelopes unchanged (`bdad6cfa`).

## Registry compatibility

| Metric | Before W20 | After W20 |
|---|---|---|
| fingerprint | `bdad6cfa` | `bdad6cfa` |
| stable ids | 368 | 368 (identical, index-for-index) |
| legacy aliases | unchanged | unchanged |
| def.name metadata | frozen | frozen (spot-checked) |

Enforced by `tools/check-i18n.js` against
`tests/fixtures/registry-baseline-w20.json` AND by
`tests/core/localization-identity.test.js`.

## Catalog counts

- fallback keys total: **523** (ui/templates/dialogue/content names +
  descriptions);
- registry content names resolved through the catalog: **265**
  (tile/wall/item/enemy/npc/buff/biome/station, minus deliberate nameless
  entries) + 2 npc kinds beyond registry (guide/merchant) with full dialogue;
- plural entries: sorted/stored (+ engine supports zero/one/two/few/many/other).

## Tests added

Headless (node:test): `localization.test.js` (11), `localization-coverage
.test.js` (4), `localization-identity.test.js` (4, BLOCKER),
`localization-persistence.test.js` (3), `localization-determinism.test.js`
(2), `localization-npc.test.js` (3). Browser:
`journey-k-localization.spec.js` — switch, inventory/crafting under stress
locale, dialog identity across switches, progression-toast path, minimap,
frozen-sim pixel-diff proof (locale redraw ≫ ambient noise floor; returning
to en restores within noise), REAL page-reload persistence of BOTH locale
and world, world-deletion keeps locale, fallback return.

Two existing npc suites updated to the new contracts (pool assertions resolve
keys via the fallback; shop dialog opens by stable type + key) — no assertion
weakened.

## Validation evidence (local gate, Windows, Node v24.3.0)

- `npm run check` — 48 files, 0 failures
- `npm run check:i18n` — OK (523 keys, 265 names, fingerprint + ids equal)
- `npm test` — **449 passed / 0 failed** (baseline before W20: 421)
- `npm run build` — dist assembled, 48 js files
- `npm run verify:build` — production boot/render/new-game/continue OK
- `npm run test:browser` — **25 passed** (24 pre-existing + journey K)
- `npx playwright test journey-k --repeat-each=3` — 3/3 passed

## Performance measurements

- `tools/bench-runtime.js`: baseline 1.96 ms/full-sim-tick → post-W20
  **1.74 ms/tick** (scheduler updateAll 181.8 µs; render dispatch 270 µs;
  queue drain ~0.17 µs empty) — no regression; lookups are flat O(1) map
  reads, catalogs pre-indexed at registration.
- `tools/perf-probe-w17-wof.js`: live-encounter probe behavior unchanged
  (wall + servants cap + hostile volley well inside the 16.67 ms budget).

## CI

`.github/workflows/ci.yml` runs `npm run validate` on pushes to main — the
gate now includes `check:i18n`. Final push triggers the workflow; conclusion
recorded below in Push confirmation once the run completes.

## Known limitations

- No real secondary-language catalog authored yet (engine/validator/tests
  accept one as `js/locales/<id>.js` registering + `restore()` with zero code
  changes).
- RTL and complex-script typography deferred; rendering already uses system
  font stacks + measureText and never truncates by byte count, but no bidi/
  shaping work exists.
- Coin purse notation stays compact units (`1g 23s 45c`) rather than a
  word-order template (documented decision).
- Translator workflow/export tooling not built (follow-up candidate).
- `document.title` sync uses `app.title`; per-locale document titles derive
  from each catalog's own `app.title` when present.

## Follow-up candidates (next campaigns)

1. Author a real second-language catalog + translator export/import tooling.
2. Reforge/prefix UI surfacing localized prefix descriptions (prefix NAMES
   already localized).
3. Extend pseudo-locale coverage to any new UI surfaces added later.
4. Optional: localize Economy.format denominations if word-order-sensitive
   currency text is ever wanted.

## Push confirmation

- Reconciled baseline pushed after Wave A (`main` = origin/main = `99d0caf`,
  `0 0` proven).
- Campaign commits pushed progressively; final push + `git fetch` +
  `rev-list --left-right --count main...origin/main` must read `0 0` and both
  containment checks (`campaign/runtime-authority-convergence`,
  `feat/underworld-frontier` ancestors of origin/main) must pass. See the
  session report for the executed proof.

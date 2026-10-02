# Change Proposal: localization-presentation-hygiene

- **ID**: localization-presentation-hygiene
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P2 (confirmed violations of the project's own W20 contract)

## Why

`AGENTS.md` states the W20 localization contract as **mandatory**:

> Legacy `def.name` fields are FROZEN identity metadata — do not reword them;
> **do not read them in presentation paths** (resolve via
> `TC.Localization.contentName(kind, ref)` instead).
>
> All normal player-facing strings … render via `t(key, vars)` /
> `contentName(kind, ref)`. **No new raw string literals, no `'x' + value`
> English concatenation**, no id→TitleCase conversion in UI code.

`npm run check:i18n` enforces *catalog coverage* and *registry identity*, but it
does **not** detect presentation paths that read `def.name` directly or that
assemble English by concatenation. The audit found surviving violations:

| Location | Violation |
|---|---|
| `js/main.js` legacy debug overlay (`drawDebug`) | `lines.push('cursor tile ' + tx + ',' + ty + ' = ' + TC.TILE_DEFS[id].name)` — raw `def.name` **and** English string concatenation with values. |
| `js/enemies.js` boss-defeated toast | Fallback branch builds `e.def.name + " has been defeated!"` — raw name plus a hardcoded English sentence, used whenever `TC.Localization` is absent. |
| `js/fishing.js` catch floater | `'+' + n + ' ' + ((d && d.name) || e.id)` — raw `def.name` in a player-visible floater (it already has an `iName()` helper that resolves through the catalog). |
| `js/accessories.js` `buffName` / `js/fishing.js` `iName` | `return (d && d.name) || String(id)` — acceptable as a last-resort fallback, but these are the sanctioned seam and should be the *only* place a raw name is read. |
| `js/enemies.js` `trackHostileShot` / `clearHostileShotsOf` | **Identity, not presentation:** hostile shots are keyed by `shooter.def.name` as the shooter identity, and cleared by comparing `h.src === boss.def.name`. |

The last row is the more serious one. Using a display-name string as an identity
key on a system that has a canonical stable identity (`TC.Registry` stable ids
like `core:king_slime`, and `e.type`) means two distinct entities that share a
`def.name` cross-clear each other's projectiles, and a pack-provided enemy whose
`name` collides with a built-in one inherits the built-in's shots. `AGENTS.md`
is explicit: "Translated strings are never authoritative identity." `def.name`
is frozen so it is not *translated*, but it is still display metadata being used
as identity — exactly the pattern the rule exists to prevent.

## What Changes

- Route every remaining presentation-path content name through
  `TC.Localization.contentName(kind, ref)`, removing raw `def.name` reads from
  UI and floater code, including the legacy debug overlay.
- Replace the hardcoded English fallback sentence in the boss-defeated toast
  with a catalog-backed path (the module already has a correct
  `progress.boss_defeated` template; the fallback should be an honest
  no-localization path, not a half-translated one).
- Replace `shooter.def.name`-keyed hostile-shot bookkeeping with the shooter
  reference plus a stable type or registry id. Remove both display-name
  comparisons in `clearHostileShotsOf`, including the `magic_bolt` cleanup
  loop. Do not keep a name fallback. `SOURCE_STATUS` is keyed only by `lava`
  and is not part of this migration.
- Add a static check (as part of `add-repository-quality-gates`, or a small
  standalone script if that lands separately) that fails on `def.name` reads
  outside the sanctioned catalog-resolution helpers.
- Add tests for identity separation: two same-named entities must not clear
  each other's hostile shots.

**Not breaking**: no catalog key changes for existing content; the rendered
English text is unchanged for the default locale (it resolves to the same
strings). No registry identity change, so `check:i18n`'s fingerprint guard
stays green.

## Capabilities

### New Capabilities
- `content-name-resolution`: the rule and enforcement that all user-visible
  content names resolve through the localization catalog, that frozen
  identity metadata is never used as display text, and that display metadata is
  never used as runtime identity.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline)

## Impact

- **Code**: `js/main.js` (`drawDebug`), `js/enemies.js` (boss toast fallback,
  `trackHostileShot`, `clearHostileShotsOf`, hostile-shot `src` field),
  `js/fishing.js` (catch floater), `js/accessories.js` (`buffName` comment /
  fallback), possibly `tools/check-i18n.js` or a new checker.
- **Tests**: hostile-shot identity separation test; a check that no
  presentation path reads `def.name`; existing localization identity tests must
  remain green.
- **Dependencies**: benefits from `add-repository-quality-gates` (the static
  rule is the enforcement mechanism), but does not require it.
- **Risk**: low-to-medium. The hostile-shot identity change touches boss combat
  bookkeeping; `tests/unit/wof-frontier.test.js` exercises that path and must
  stay green. Cosmetic paths are trivial.

# Design — localization-presentation-hygiene

## Context

The W20 localization architecture is real and enforced where it counts:
`js/localization.js` provides `contentName(kind, ref)` (resolving through
`TC.Registry` stable ids), `t(key, vars)` with `{var}` interpolation and plural
rules, an English fallback catalog (`js/locales/en.js`, 577 keys), and
`tools/check-i18n.js` which validates catalog coverage, NPC dialogue keys, and
freezes registry identity against a baseline fingerprint
(`tests/fixtures/registry-baseline-w24.json`, fingerprint `1b1d7c15`).

What the checker does **not** do is inspect *presentation paths*. A module can
read `TC.TILE_DEFS[id].name` directly and the gate stays green. The audit
found the surviving cases by grepping every `DEFS[...].name` / `.def.name` read
outside the two data files.

The most consequential case is in `js/enemies.js`. Boss projectiles are tracked
in a module-level `hostileShots` array and the shooter is recorded as a
**display name**:

```js
function trackHostileShot(pr, shooter, dmg) {
  if (Array.isArray(pr.hits)) pr.hits.push(shooter);
  hostileShots.push({ p: pr, type: pr.type, dmg: dmg, src: shooter.def.name });
}

function clearHostileShotsOf(boss) {
  ...
  if (h.src === (boss.def && boss.def.name) || h.p === boss || (h.src && boss.def && h.src === boss.def.name)) {
    hostileShots.splice(i, 1);
```

So identity matching is a `===` on a human-facing string. Two consequences:

1. **Name collision → cross-clearing.** Any two distinct bosses with the same
   `def.name` will clear each other's shots.
2. **Reuse of `src` for damage attribution.** The same string is passed as the
   `src` argument to `TC.Combat.hurtPlayer(...)`, which feeds
   `TC.Buffs.statusForSource(src)` — a *gameplay* lookup keyed by source name.

Note the type guard already in the update loop
(`h.p.type !== h.type` → splice) is exactly the pattern the tracking needs; the
project already recognized pooled-slot recycling as a hazard for the
projectile, but not for the shooter.

## Goals / Non-Goals

**Goals:**
- Every user-visible content name resolves via `contentName`.
- No player-facing message assembled by concatenation in a presentation path.
- No display metadata used as runtime identity.
- A check that prevents the rules from regressing.
- Registry identity byte-identical (fingerprint guard stays green).

**Non-Goals:**
- Not changing the catalog engine or rewording frozen `def.name` fields.
  `buffName` and `iName` must stop reading `def.name`; their fallback is the
  stable id, same as `contentName`.
- Not doing a full i18n sweep of every module — the audit enumerated the
  surviving sites; anything else found later is a follow-up.

## Decisions

### D1: Replace `shooter.def.name` identity with a stable shooter reference

Store the shooter *entity reference* alongside the projectile and match on that,
keeping the existing `h.p.type` guard for pooled-slot recycling:

```js
hostileShots.push({ p: pr, type: pr.type, dmg: dmg, shooter: shooter, srcKey: srcKeyOf(shooter) });
```

where `srcKeyOf` returns a stable string — `e.type` when available, else a
stable registry id — used for the damage-source string. Clear by identity only:

```js
if (h.shooter === boss || (h.shooter == null && h.srcKey === srcKeyOf(boss)))
```

Do not retain `h.src === boss.def.name`. Hostile shots are in-memory only, so
there is no pre-change entry to migrate. Apply the same stable match to the
second `magic_bolt` cleanup loop in `clearHostileShotsOf`; that loop currently
compares `h.src === boss.def.name` and would reintroduce the cross-clear.

**Alternative considered — use `e.type` alone as the key.** Rejected: two
instances of the same enemy type (e.g. two `hungry` servants, or two
`storm_jelly` spawns) would still cross-clear, and the Wall of Flesh's phase
logic distinguishes instances. The entity reference is the correct identity.

### D2: Repair the damage-source string to a stable value

`hurtPlayer(dmg, kb, kby, src)` is called with `h.src` (the shooter name) and
with `e.def.name` in several `js/enemyai.js` / `js/enemies.js` contact-damage
call sites. Introduce a single `enemySourceKey(e)` helper (stable: `e.type` or a
registry id) and use it for all `hurtPlayer` source arguments.

Rationale: `TC.Buffs.SOURCE_STATUS` maps source strings to statuses. Using a
stable key makes that mapping explicit and locale-proof; using a display name
means a status rule silently stops applying if a name ever changes. This is the
"display metadata is never authoritative identity" rule applied to a gameplay
path, not just presentation.

**Resolved:** `TC.Buffs.SOURCE_STATUS` is built only from `fromSource`, and the
only current value is `lava`. Do not rekey that table and do not add enemy
display names to it. `enemySourceKey` replaces display names at `hurtPlayer`
call sites. The existing `lava` key stays untouched.

### D3: Route remaining presentation reads through the catalog

- `js/main.js` `drawDebug`: use `TC.Localization.contentName('tile', id)` and a
  catalog key for the label (or reuse the existing debug label).
- `js/fishing.js` catch floater: use the existing `iName(e.id)` helper and a
  feedback template (`fmsg('feedback.fishing.…', {n, name})`) rather than
  `'+' + n + ' ' + d.name`.
- `js/enemies.js` boss toast: the primary path already uses
  `TC.Localization.t("progress.boss_defeated", {boss: contentName(...)})`; the
  fallback branch (`TC.Localization ? … : e.def.name + " has been defeated!"`)
  should be an explicit no-catalog path — either omit the toast or use the
  stable type key. Choose one and make it consistent.

Rationale: the catalog already has the keys; these are pure wiring fixes.

### D4: Add a checker for presentation-path name reads

Extend `tools/check-i18n.js` with a source scan that flags `def.name` /
`DEFS[..].name` reads used as display text. The allowlist is the frozen
definition tables and the `contentName` stable-id fallback, not `buffName` or
`iName` reading `def.name`. Identity paths must use stable keys and are not an
excuse for a name read.

Rationale: `check:i18n` is already the localization gate; adding the rule there
means zero new scripts and no new dependency, and it fails the existing
`npm run validate`. This is the enforcement the spec requires.

**Alternative considered — a `no-restricted-syntax` ESLint rule.** Rejected as
the primary mechanism: the check must run even if the linter from
`add-repository-quality-gates` is not adopted, and this pattern spans computed
member access (`TC.TILE_DEFS[id].name`) that a syntactic rule handles poorly.

## Risks / Trade-offs

- **[Hostile-shot clearing regressions in boss fights]** → `tests/unit/wof-frontier.test.js`
  and the journey-J browser spec exercise the Wall of Flesh shot path; run both.
  Add a same-name identity-separation test.
- **[`SOURCE_STATUS` key mismatch]** → Resolved: the only key is `lava`.
  Do not migrate that table. `tests/combat/status.test.js` still guards lava.
- **[New catalog keys trip the i18n gate]** → All new keys must land in
  `js/locales/en.js`; `check:i18n` enforces coverage and this change runs it.
- **[Allowlist in the checker grows]** → Keep it to frozen definition tables
  and the catalog resolver's stable-id fallback. Name-reading helpers are not
  allowlisted.

## Migration Plan

1. Add `enemySourceKey(e)` and migrate `hurtPlayer` source arguments + the
   hostile-shot `src`/identity (D1/D2); run the combat, wof, and status tests.
2. Fix the three presentation sites (D3); add any needed catalog keys; run
   `check:i18n`.
3. Add the source-scan rule to `tools/check-i18n.js` (D4); confirm it flags a
   seeded violation (negative control) and is clean after the fixes.
4. No registry identity change — verify the fingerprint guard is still green.
5. Fully reversible.

## Open Questions

None. `SOURCE_STATUS` is keyed only by `lava` and is not migrated.

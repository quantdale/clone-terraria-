# Tasks — localization-presentation-hygiene

## 1. Stable identity for enemy damage sources and hostile shots

- [ ] 1.1 Add an `enemySourceKey(e)` helper that returns a stable key (enemy
      `type`, or the registry stable id) rather than a display name.
- [ ] 1.2 Do not migrate `TC.Buffs.SOURCE_STATUS`. It is keyed only by
      `lava` today. Leave that key unchanged.
- [ ] 1.3 Replace every `hurtPlayer(..., e.def.name, ...)` source argument in
      `js/enemies.js` and `js/enemyai.js` with the stable key.
- [ ] 1.4 Change `trackHostileShot` in `js/enemies.js` to record the shooter
      entity reference (plus the stable key) instead of `shooter.def.name`.
- [ ] 1.5 Change both loops in `clearHostileShotsOf` to match the shooter
      reference or stable key. Delete the `boss.def.name` comparisons,
      including the `magic_bolt` cleanup loop. Do not keep a display-name
      fallback.
- [ ] 1.6 Keep the existing projectile `type` guard so a recycled pool slot is
      still distinguished from the originally tracked shot.
- [ ] 1.7 Assert the Wall of Flesh `magic_bolt` path still clears that boss's
      own shots, and does not clear another entity's shots that share its
      display name.

## 2. Presentation-path name resolution

- [ ] 2.1 `js/main.js` `drawDebug`: resolve the tile name through
      `TC.Localization.contentName('tile', id)` instead of `TC.TILE_DEFS[id].name`,
      and replace the concatenated English label with a catalog-resolved one.
- [ ] 2.2 `js/fishing.js` catch floater: use the existing `iName(e.id)` helper
      and a `feedback.fishing.*` template with named variables instead of
      `'+' + n + ' ' + (d && d.name)`.
- [ ] 2.3 `js/enemies.js` boss-defeat toast: make the no-catalog fallback an
      explicit, consistent degraded path instead of
      `e.def.name + " has been defeated!"`.
- [ ] 2.4 Add any required catalog keys to `js/locales/en.js`.

## 3. Automated enforcement

- [ ] 3.1 Extend `tools/check-i18n.js` with a source scan that fails on direct
      reads of a content definition's name field outside the sanctioned
      resolution helpers and frozen data files (design D4).
- [ ] 3.2 Allow only frozen definition tables and the catalog resolver's
      stable-id fallback. A `buffName` or `iName` read of `def.name` fails the
      check. Require a stated reason for every allowlist entry.
- [ ] 3.3 Negative control: seed a deliberate raw name read, confirm the check
      fails and names the file/location, then remove it and confirm it passes.

## 4. Tests

- [ ] 4.1 Add a test proving two same-named distinct entities do not clear each
      other's tracked hostile shots.
- [ ] 4.2 Add a test proving a projectile attributed to an entity whose display
      name matches a built-in entity is not attributed to the built-in entity.
- [ ] 4.3 Add a test proving a stale tracking entry is discarded when its pool
      slot is recycled.
- [ ] 4.4 Confirm the existing registry fingerprint guard and localization
      identity tests still pass unchanged.

## 5. Verification

- [ ] 5.1 Run `node --check js/enemies.js js/enemyai.js js/main.js js/fishing.js
      js/accessories.js`.
- [ ] 5.2 Run `npm run test:combat` and confirm the status tests pass.
- [ ] 5.3 Run `npm run check:i18n` and confirm catalog validity plus the new
      source-scan rule.
- [ ] 5.4 Run `npm test` and `npm run test:browser` (including the Wall of
      Flesh journey) and confirm all pass.
- [ ] 5.5 Run `npm run validate` end to end and record the result.
- [ ] 5.6 Manually verify under the `en-XA` pseudo locale (under `#test`) that
      the debug overlay and fish floater render translated content.

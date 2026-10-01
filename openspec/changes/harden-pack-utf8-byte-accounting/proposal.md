# Change Proposal: harden-pack-utf8-byte-accounting

- **ID**: harden-pack-utf8-byte-accounting
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P2 (confirmed resource-limit accounting defect on a security boundary)

## Why

`TC.Packs` and `TC.PackStore` enforce byte budgets by comparing a **JavaScript
string length** (UTF-16 code units) against limits that are documented, named,
and error-reported as **bytes**.

`js/packs.js`, two sites:

```js
if (text.length > MAX_MANIFEST_BYTES) {          // MAX_MANIFEST_BYTES = 256 * 1024
  fail("manifest", "pack JSON exceeds " + MAX_MANIFEST_BYTES + " bytes");
}
```

(the same comparison appears in both `provideJSON` and `validateJSON`)

`js/packstore.js`, three sites:

```js
const MAX_MANIFEST_BYTES = 256 * 1024; // single manifest cap (mirrors TC.Packs)
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // whole-store cap
...
if (m.json.length > MAX_MANIFEST_BYTES || totalBytes() + m.json.length > MAX_TOTAL_BYTES) ...
if (text.length > MAX_MANIFEST_BYTES) return { ok: false, error: 'too-large' };
if (totalBytes(candidate) > MAX_TOTAL_BYTES) return { ok: false, error: 'quota' };
```

For ASCII JSON, one code unit is one byte and the caps hold. For any manifest
containing non-ASCII content, `text.length` **undercounts** the real storage
cost. A CJK-heavy pack description is 1 code unit but 3 UTF-8 bytes; an emoji
is 2 code units but 4 bytes; astral-plane characters are 2 code units and 4
bytes. A manifest that passes the "256 KiB" check can therefore occupy up to
~3× that in real bytes.

The consequences compound:

1. **The stated per-manifest cap is not the real cap.** The security boundary's
   documented bound is not the enforced bound.
2. **The store total cap is not the real cap.** `MAX_TOTAL_BYTES = 4 MiB` can
   hold up to ~12 MiB of actual bytes, and the store is written to
   `localStorage` under the `tc_packs_installed_v1` key alongside the save
   envelope (`tc_save_v2`, plus `.bak`/`.tmp`). A store that "passes" its quota
   check can therefore push the origin over the browser's storage quota — at
   which point **saves start failing**, which is the same silent failure mode
   `surface-persistence-failures` addresses from the other direction.
3. **The failure is silent by construction at the boundary.** `persist()`
   returning false is already handled (`{ ok: false, error: 'storage' }`), but
   the quota *check* that was supposed to prevent this passes instead.

The project already knows about this. `docs/HANDOFF-W26-pack-ecosystem-productionization.md`
line 84 records: *"PackStore total bytes counted as string length (UTF-16) not
exact UTF-8 bytes; cap is conservative for ASCII JSON"* — "conservative" is
correct only for ASCII, and JSON manifests legitimately contain non-ASCII
player-authored text (pack names and descriptions are exactly that). The same
handoff lists "UTF-8 store accounting" as a remaining follow-up.

## What Changes

- Measure manifest and store size in **exact UTF-8 bytes** at every accounting
  site in `js/packs.js` and `js/packstore.js`, replacing the string-length
  comparisons.
- Make the error messages and the documented limits state the unit truthfully
  (the current "exceeds N bytes" message is correct only under the new
  accounting).
- Ensure the store's total-bytes accounting, the per-manifest cap, and the
  load-time degrade path all use the same byte measure, so a store that was
  persisted under old accounting is still evaluated consistently.
- Keep the caps numerically unchanged (256 KiB per manifest, 64 manifests,
  4 MiB total) so the change is a correctness fix, not a policy change.
- Add tests using non-ASCII manifests that prove the cap is enforced in bytes.
- Reconcile the W26 handoff note and the README's stated caps with the
  enforced behavior.

**Not breaking**: ASCII manifests behave identically. Non-ASCII manifests that
previously fit under the loose measure may now be correctly rejected — that is
the intended fix, and the rejection is graceful (`too-large` / `quota` with an
existing localized message).

## Capabilities

### New Capabilities
- `pack-resource-accounting`: exact UTF-8 byte accounting for pack manifest and
  installed-store resource limits, and truthful reporting of those limits.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline)

## Impact

- **Code**: `js/packs.js` (`provideJSON`, `validateJSON`),
  `js/packstore.js` (constants, `totalBytes`, `install`, `load` degrade path).
- **Tests**: `tests/packs/w26-packstore.test.js` and the pack loader suite gain
  non-ASCII cap cases; `tools/fuzz-packs.js` gains a non-ASCII size case.
- **Docs**: `README.md` pack section, `docs/HANDOFF-W26-…` line 84/152,
  `docs/TASK_BOARD.md` W26 row.
- **Dependencies**: independent. Sequenced with
  `surface-persistence-failures` since both concern storage capacity, but
  neither requires the other.
- **Risk**: low. Pure accounting change plus message/doc accuracy. The one
  behavioral change is that oversized non-ASCII manifests are now correctly
  rejected at install time instead of at persist time.

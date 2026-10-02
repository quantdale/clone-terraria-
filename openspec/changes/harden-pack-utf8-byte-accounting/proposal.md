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

For ASCII JSON, one code unit is one UTF-8 byte and the documented caps hold.
For non-ASCII content, `text.length` undercounts UTF-8 size. A CJK character
is 1 code unit and 3 UTF-8 bytes; an emoji is 2 code units and 4 UTF-8 bytes.
A manifest can therefore pass the named 256 KiB check while exceeding 256 KiB
of UTF-8.

This change makes the documented caps exact UTF-8. It does not claim that
UTF-8 is the unit a browser uses for origin quota. That unit is
implementation-defined and was not measured here. Origin-quota exhaustion
remains the concern of `surface-persistence-failures`.

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
- Make rejections report both the measured UTF-8 size and the limit, in the
  pack-authority message and in the user-facing localized template. Keep the
  existing machine-readable error codes.
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

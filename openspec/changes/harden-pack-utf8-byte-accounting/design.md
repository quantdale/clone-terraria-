# Design — harden-pack-utf8-byte-accounting

## Context

Two modules enforce resource limits on untrusted pack input:

**`js/packs.js`** (the untrusted-input boundary). Constants:

```js
const MAX_MANIFEST_BYTES = 256 * 1024; // serialized JSON size cap
```

Used at two identical sites — `provideJSON` (register) and `validateJSON`
(PackStore's validation entry point):

```js
if (text.length > MAX_MANIFEST_BYTES) {
  fail("manifest", "pack JSON exceeds " + MAX_MANIFEST_BYTES + " bytes");
}
```

**`js/packstore.js`** (the durable localStorage store):

```js
const MAX_INSTALLED = 64;
const MAX_MANIFEST_BYTES = 256 * 1024; // single manifest cap (mirrors TC.Packs)
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // whole-store cap
```

Used at: the load-degrade path (`m.json.length > MAX_MANIFEST_BYTES ||
totalBytes() + m.json.length > MAX_TOTAL_BYTES`), `install`'s pre-check, and
the two "provided but not installed" / "replace" quota checks
(`totalBytes(candidate) > MAX_TOTAL_BYTES`).

`text.length` is a UTF-16 code-unit count. UTF-8 byte cost differs:

| Content | code units | UTF-8 bytes | ratio |
|---|---|---|---|
| ASCII | 1 | 1 | 1.0 |
| Latin-1 accented, CJK | 1 | 2–3 | 2–3× |
| Emoji / astral plane | 2 | 4 | 2× |

Pack manifests contain player-authored `name` and `description` fields, so
non-ASCII content is a first-class, expected case — not a pathological one.

The store shares the origin's localStorage budget with the save envelope
(`tc_save_v2`, `tc_save_v2.bak`, `tc_save_v2.tmp`) and the settings envelope
(`tc_settings_v1`). Browser quotas are per-origin, so an inflated pack store
competes directly with save capacity — which is exactly why
`surface-persistence-failures` exists on the other side of this boundary.

The repository already recorded this gap:
`docs/HANDOFF-W26-pack-ecosystem-productionization.md` line 84 — *"PackStore
total bytes counted as string length (UTF-16) not exact UTF-8 bytes; cap is
conservative for ASCII JSON"* — and line 152 lists "UTF-8 store accounting" as
a remaining follow-up. The "conservative for ASCII" qualifier is the whole
finding: it is not conservative for the non-ASCII case.

## Goals / Non-Goals

**Goals:**
- One byte measure, used at every accounting site in both modules, that is
  exact UTF-8.
- Messages and docs that state the unit truthfully.
- Preserve the numeric caps (correct the measurement, not the policy).

**Non-Goals:**
- Not changing the caps, the manifest schema, the validation pipeline, or the
  activation/commit model.
- Not moving the store to IndexedDB.
- Not adding a byte-count cache/optimization unless profiling shows it matters.
- Not auditing other size checks in the project (e.g. save envelope size) for
  the same class — recorded as a follow-up in the master plan.

## Decisions

### D1: A single shared byte-measure helper

Add one UTF-8 byte-length function and use it at every accounting site in both
modules:

```js
function utf8Bytes(s) {
  return new TextEncoder().encode(s).length;
}
```

Rationale: `TextEncoder` is the standard UTF-8 measure for the documented
caps. It is not evidence of how a browser denominates origin quota. Use it so
the named byte caps and the enforced caps are the same unit. The headless
sandbox in `tests/helpers/load-game.js` does not currently expose
`TextEncoder`; adding it there is mandatory before the helper is called from
tests.

**Alternative considered — manual UTF-8 byte counting loop** (iterate code
points; ASCII 1, <U+800 2, <U+10000 3, else 4). Rejected: it duplicates a
standard implementation and is a classic source of off-by-one bugs on surrogate
pairs. Use it only if `TextEncoder` proves unavailable in a target environment
(the headless test loader would need a stub).

**Alternative considered — `Blob`/`File.size`.** Rejected: async and heavier
than needed for a synchronous validation gate.

### D2: Compute the byte length once, at the boundary, and pass it down

`provideJSON` / `validateJSON` / `install` each measure the incoming text once
and reuse the result for the check, the digest input, and (in PackStore) the
stored record's accounting. `totalBytes()` should sum cached per-manifest byte
counts rather than re-encoding on every call.

Rationale: `install` currently calls `totalBytes(candidate)` in up to two
branches, and the load path re-measures every manifest; caching the count
alongside each stored record is a small structural improvement that makes the
number in the cap check the same number that was measured at install.

**Note:** cached counts must be recomputed (or treated as absent) when loading
a store persisted under the previous accounting, so the load path stays
consistent with the new measure — captured by the spec scenario "A persisted
store is re-evaluated consistently".

### D3: Report measured size and limit without changing error codes

`provideJSON` / `validateJSON` failures include the measured UTF-8 size and
the limit. `PackStore.install` keeps the codes `too-large` and `quota`, and
also returns `measured` and `limit` so the UI can interpolate them. Add or
extend the localized templates with `{measured}` and `{limit}`. Do not invent
new error codes; `js/ui.js` already maps the existing codes.

**Alternative considered — richer codes (e.g. `too-large-bytes`).** Rejected:
would break the UI mapping and the existing tests for no benefit.

### D4: Keep numeric caps; document the correction

Leave `256 KiB`, `4 MiB`, `64` unchanged. Update:
- `README.md` (pack section states "256 KiB each, 4 MiB total"),
- `docs/HANDOFF-W26-…` (lines 84 and 152),
- `docs/TASK_BOARD.md` (W26 row / follow-ups).

## Risks / Trade-offs

- **[`TextEncoder` unavailable in the headless loader]** → Confirmed absent
  from the sandbox global list. Add it before relying on the helper. Do not
  hand-roll a surrogate-pair counter instead.
- **[Previously-accepted oversized non-ASCII manifests now rejected]** → This
  is the fix. The rejection is graceful and already localized; the user can
  shorten the manifest. No stored data is silently dropped — `load` keeps its
  bounded-diagnostics degrade path.
- **[A store already persisted under loose accounting may now fail its own cap
  on load]** → Handled by the load-degrade path with bounded diagnostics, and
  covered by an explicit spec scenario. Not a data-loss event: the previous
  main save is a different key and unaffected.
- **[Byte measurement cost on large manifests]** → Negligible at a 256 KiB
  cap; the caching in D2 removes the repeated work in the store path.

## Migration Plan

1. Add `TextEncoder` to the headless sandbox, then add the byte helper.
2. Replace the five accounting sites and the message text (D1–D3).
3. Add non-ASCII cap tests + a fuzz size case.
4. Run `npm run check:i18n` (codes unchanged, but confirm), `npm test`,
   `npm run test:packs`, `tools/fuzz-packs.js`.
5. Update README/handoff/task-board (D4).
6. No stored-data migration; fully reversible.

## Open Questions

None. The measure, the caching shape, the code compatibility constraint, and
the doc updates are all resolved.

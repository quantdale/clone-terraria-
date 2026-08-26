# W26 Design — Pack Ecosystem Productionization

## 1. Design principles

W26 extends existing authorities. It does not create alternate runtimes.

- Pack validation/activation authority: `TC.Packs`.
- Stable content identity: `TC.Registry`.
- Installed manifest persistence: one new small authority, tentatively `TC.PackStore`.
- Loot evaluation: `TC.LootTables`.
- Natural spawn authority: `TC.EnemySpawn`.
- Gameplay RNG: `TC.GameRng`.
- Save envelope/restore: `TC.SaveCore` / existing save integration.
- Multiplayer wire identity: `TC.NetProto` + `TC.NetServer`/`TC.NetClient`.
- Gameplay mutations: `TC.Commands`.
- World dirtiness: `TC.WorldRegions`.
- User-facing text: `TC.Localization`.

Any implementation that duplicates one of these responsibilities must justify itself and is presumed wrong.

## 2. Boot sequence

The critical W26 boot invariant is that the active content set is final before registry validation, save classification, world creation or multiplayer admission.

Desired conceptual order:

1. built-in scripts/tables load in `index.html` order;
2. build-provided pack manifests call `TC.Packs.provide(...)`;
3. late built-in table extenders (notably wiring) finish loading;
4. installed-manifest store loads validated stored source and provides manifests through the same `TC.Packs` boundary;
5. persisted active pack ids are resolved;
6. `TC.Packs.setActive(...)` stages + commits atomically;
7. registry sync/validation and boot tasks run against the final content set;
8. title/continue/new-world/dedicated-host operations begin.

The implementation may arrange the mechanics differently, but the externally visible ordering above must hold in browser, tests, release build and dedicated server.

Do not solve this with arbitrary timeouts or a second async loader.

## 3. Installed manifest store

### 3.1 Responsibility

`TC.PackStore` (name may change during reconciliation) owns **source manifests installed by the user**, not active pack state and not world progression.

Suggested versioned envelope:

```js
{
  v: 1,
  manifests: [
    { id: "example", digest: "...", json: "{...canonical or validated JSON...}" }
  ]
}
```

The exact representation can differ. Required properties:

- bounded total serialized bytes;
- bounded manifest count;
- no executable values;
- corrupt storage fails closed/degrades to empty with diagnostics;
- same-id same-digest install is idempotent;
- conflicting same-id update is explicit;
- export can recover the original/canonical valid manifest data;
- provision to `TC.Packs` is performed before activation.

Do not put the full manifest set in `TC.Settings`. Settings may retain only preference-sized fields such as `activePacks`.

### 3.2 Browser import

The title UI may use a transient hidden `<input type="file" accept="application/json,.json">` or a similarly minimal native browser seam. The selected text must be size-checked before/while reading where practical, then sent to the same JSON validation path used elsewhere.

If DOM test stubs need extension, improve them generically enough to model the production seam. Do not add a production branch that detects tests and skips validation.

### 3.3 Resource-file limitation

A JSON manifest imported from the browser cannot magically materialize referenced local resource files. Until a bundled archive/resource system exists, browser-imported manifests with unresolved `resources.files` must be rejected with an actionable reason or constrained to resource forms that are completely embedded in the JSON (for example localization fragments). Never silently accept missing files.

## 4. Wall family

Walls are a low-risk dense content family because world storage, save/replication and commands already understand numeric wall ids.

Implementation rules:

- family is bounded and structurally whitelisted in `TC.Packs`;
- stable id is `<packid>:<key>`;
- runtime wall index appends after existing `TC.WALL_DEFS`;
- supported definition fields are a small explicit subset used by existing wall rendering/mining behavior;
- wall painter/pattern names are enumerated built-in vocabulary only;
- item/drop references resolve at staging time;
- activation commit journals all table/registry/localization mutations and can roll them back;
- no wall-specific save or network format is introduced unless current formats prove insufficient.

## 5. Standalone loot-table family

### 5.1 Identity

Prefer adding a `lootTable` registry kind if code audit confirms that an empty kind contributes no fingerprint lines and therefore preserves the zero-pack fingerprint. If that assumption is false, define a dedicated deterministic stable-id map owned by `TC.LootTables`; document why.

### 5.2 Schema

A pack loot table is pure data:

```js
{
  key: "storm_common",
  entries: [
    { id: "tempest_shard", min: 1, max: 2, chance: 0.75, requires: "..." }
  ]
}
```

Exact names can change, but bounds/reference rules must be explicit. Pack conditions may use the declarative `TC.Progression` grammar only. Function-valued `requires` remains a built-in runtime capability and is **not** exposed through untrusted manifests.

Enemy definitions may reference `lootTable`/equivalent stable refs. Existing inline `drops` remain valid for backwards compatibility.

At runtime, all rolls still delegate to `TC.LootTables`, using the `loot` RNG stream. No duplicate pack-specific evaluator.

## 6. Natural spawn rule grammar

### 6.1 Compile at activation

Do not scan all manifests/registry entries inside `spawnDirector` each tick. During pack staging/commit, normalize valid rules into deterministic compact records indexed by zone (and optionally biome/time buckets).

Conceptual record:

```js
{
  source: "packid",
  enemy: "packid:enemy_key",
  runtimeEnemyKey: "...",
  zone: "day|night|cave|underworld",
  weight: 1.0,
  biome: null | "snow|jungle|desert|corruption|...",
  depthMin: null | number,
  depthMax: null | number,
  time: null | "day|night",
  requires: null | declarativeCondition,
  order: deterministicInteger
}
```

No callbacks.

### 6.2 Runtime merge

`TC.EnemySpawn` remains the owner of ecology classification and weighted selection. It should expose/consume one pack-extension seam that returns already-compiled applicable entries or a snapshot of them.

Preserve:

- underworld depth-first classification;
- Blood Moon replacement semantics;
- biome overrides;
- multi-player anchor selection;
- progression spawn multiplier;
- `TC.GameRng.stream('spawn')` for weighted selection.

The rule merge order must be documented and tested. Recommended: core table first, then active packs in resolved topological order, each in manifest declaration order. If weighted selection semantics make array order mathematically irrelevant but RNG threshold boundaries depend on it, stable order is still mandatory for replay.

## 7. Dedicated host pack loading

### 7.1 CLI

Minimum target:

```text
node tools/mp-server.js --seed 1337 --packs testpack,otherpack --pack-file ./my-pack.json
```

Repeatable `--pack-file` is preferred. Paths are host-local configuration, never client input.

### 7.2 Pre-world activation

All CLI manifests must be read with byte bounds and provided through `TC.Packs` before `NetServer.start()` calls `Runtime.createWorld()`.

The current `tests/helpers/load-game.js` executes real index order in one loop. If a pre-activation injection point is needed, add a narrowly-scoped loader lifecycle option such as a callback executed after scripts capable of creating `TC.Packs` are loaded but before the boot tail/world start. Reconcile this carefully with `main.js` and `wiring.js` ordering; do not create a pack-only hidden loader.

Another valid design is to refactor boot orchestration into a canonical explicit host bootstrap that both browser and headless tools invoke. Do this only if the change is smaller/safer than a loader hook and preserves existing tests.

### 7.3 Handshake

No wire change is required if protocol-v4 metadata already fully identifies gameplay packs. A host CLI feature alone does not justify protocol v5.

Test exact digest match, mismatch, reconnect and malformed host configuration.

## 8. Version semantics

W26 must define the relationship between:

- npm/package release version;
- title/user-visible `TC.VERSION`;
- `TC.Packs.GAME_VERSION` compatibility target;
- SaveCore envelope game version;
- `TC.NetProto.VERSION` wire version.

Recommended semantics:

- one release/application version source for package/UI/save metadata;
- pack compatibility may intentionally compare a normalized major/minor compatibility version derived from release version;
- protocol version remains an independent integer bumped only for wire incompatibility.

If centralizing constants would create load-order/circular issues, document the explicit mapping and test it instead of forcing one literal variable.

## 9. Atomicity and rollback

Every new gameplay family must join the existing pack staging transaction. A failure in any of these must leave the previous live state bit-for-bit coherent:

- wall def append;
- wall/item/recipe registry aliasing;
- loot-table identity/definition;
- spawn-rule compiled index;
- localization extensions;
- existing tile/item/enemy/recipe changes.

Installed-store persistence is a separate transaction: invalid input is never stored. An install that succeeds but activation later fails must remain an installed-but-inactive manifest with an actionable error; do not corrupt the currently active session.

## 10. Testing architecture

Prefer tests at each authority boundary plus one full chain.

- Pack schema/security: `tests/packs/*`.
- Store persistence: new pack-store tests using the shared storage stub.
- Loot: extend world/combat/pack tests without duplicating evaluator fixtures.
- Spawn: extend enemyspawn/core/pack deterministic tests.
- Dedicated host: Node integration using the real `tools/mp-server.js` and RFC6455 shim, plus browser join where practical.
- Browser management: new Journey Q (or next available letter).
- Full gate: repository `npm run validate`.

Every flaky browser failure must be reproduced/diagnosed, not hidden behind sleeps.

## 11. Migration/compatibility

- Existing saves without `packs` metadata remain supported under current W25 classification.
- W25 pack manifests continue to parse exactly as before.
- W25 fixture pack should not be rewritten solely to exercise every W26 field; either minimally extend it with backwards-compatible content or add a second fixture dedicated to W26.
- Installed store is new and independent, so no world-save migration should be necessary merely to install manifests.
- If `SaveCore.gameVersion` text changes, prove old saves remain structurally loadable because format compatibility is controlled by `formatVersion`, not display version text.

## 12. Performance model

Expected costs:

- store parse/provision: boot-only, O(installed bytes) under explicit cap;
- pack staging: activation-only, O(active manifest content);
- spawn rule lookup: per attempt, O(applicable rules), not O(all content/world size);
- wall rendering/save/network: existing dense world paths;
- loot roll: O(entries in selected table) as today.

Record measurements for large valid manifests so security caps are evidence-based rather than arbitrary guesswork.

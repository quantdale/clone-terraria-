# Change Proposal: W26 Pack Ecosystem Productionization

## Status

ACTIVE — planning package only. Implementation begins through `.agent/EXECUTION_PROMPT.md`.

## Planned From

`cbe81492386c027cd7b2b508868f0e93b2fecc7c`

## Problem

W25 established a secure, deterministic, atomic declarative pack foundation, but the production path is incomplete:

- only tiles/items/enemies/recipes are extensible;
- pack enemies cannot participate in natural spawn ecology;
- browser users cannot durably install/import/export JSON packs;
- dedicated headless multiplayer hosts cannot explicitly select/load the same pack set before world creation.

These gaps prevent the W25 foundation from functioning as a normal user-facing ecosystem even though its low-level security/identity model is already strong.

## Proposed Change

Productionize the existing `TC.Packs` ecosystem without adding executable mods.

1. Add safe declarative wall and standalone loot-table content families.
2. Add a versioned persistent installed-manifest store and title-screen JSON import/export/remove UX.
3. Add a deterministic bounded declarative natural-spawn rule grammar for pack enemies.
4. Add dedicated-server pack selection/local JSON manifest loading before authoritative world creation.
5. Preserve save/protocol identity, zero-pack equivalence, deterministic replay, canonical transactions/scheduling and fail-closed validation.
6. Reconcile version semantics and stale campaign/documentation truth.

## Why Now

The W25 handoff explicitly identifies these as the next pack-system gaps. They reuse existing authorities (`TC.Packs`, `TC.Registry`, `TC.LootTables`, `TC.EnemySpawn`, `TC.SaveCore`, `TC.NetProto`) and therefore provide more leverage with less architectural risk than starting executable mods or another runtime rewrite.

## Out of Scope

- executable mods / MOD-004 implementation;
- pack-supplied JavaScript/WASM/Lua/functions/hooks;
- remote marketplace/CDN/package registry;
- automatic server-to-client pack distribution;
- broad NPC/shop/projectile/buff/biome family expansion;
- renderer replatforming, unrelated content expansion, matchmaking/cloud hosting;
- >4-player scaling or broad protocol compression work;
- full secondary-language/RTL project beyond W26 UI localization.

## Capabilities

- `pack-content`: safe wall and standalone loot-table definitions through atomic activation.
- `pack-installation`: persistent validated JSON manifests plus production management UX.
- `pack-spawning`: deterministic natural-spawn rules integrated into the canonical spawn director.
- `multiplayer-pack-hosting`: explicit dedicated-host pack selection and real-transport identity parity.
- `repository-integrity`: zero-pack/version/boot-order/test/documentation invariants.

## Risk Profile

**Primary risks**

- changing dense identity ordering or zero-pack fingerprint;
- reintroducing a boot-order race between provided/installed manifests, wiring table extension, registry sync and activation;
- allowing imported JSON to bypass W25 security validation;
- per-tick spawn rules becoming unbounded or nondeterministic;
- dedicated server starting a world before pack identity is final;
- weakening save or protocol mismatch gating.

**Mitigations**

- stage every new family in existing `TC.Packs` transaction and rollback journal;
- compile spawn rules at activation, not per tick;
- keep imported source data separate from settings/world saves and validate before persistence/provision;
- provide/activate all dedicated-host packs before `NetServer.start()` / `Runtime.createWorld()`;
- pin zero-pack fingerprint and replay/save/network tests;
- run adversarial fuzzing and real browser/WebSocket journeys.

## Success Signal

A clean user flow must work with no test-only shortcuts:

1. user imports a valid JSON data pack in the title UI;
2. pack persists across reload and activates on a fresh boot;
3. its wall/loot/spawn content is usable in a world;
4. a pack enemy naturally spawns deterministically and drops validated loot;
5. save/export/import remains compatible;
6. a dedicated server started with the same pack accepts the client;
7. a mismatched client is rejected before snapshot/world mutation;
8. full CI-equivalent validation remains green.

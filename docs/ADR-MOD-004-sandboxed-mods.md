# ADR-MOD-004 — Sandboxed / Capability-Based Executable Mods

Status: RESEARCH (W25 WS13). **Recommendation: DEFER** — do not implement in
W26; revisit only after a concrete content need proves the declarative packs
of W25 insufficient. No runtime code accompanies this document, by design.

## Context

W25 shipped safe extensibility for *data*: manifests, fail-closed validation,
atomic activation, save/multiplayer identity (MOD-001..003). MOD-004 is the
open question of executable mod logic — behaviors beyond what the declarative
schemas express (custom AI, custom use-handlers, worldgen hooks). This ADR
records the repository-specific investigation so the decision is grounded,
not vibes.

## Threat model (why direct access is unacceptable)

The game runs on `window.TC`, a single mutable global. Any script with page
scope can rewrite `TC.Registry.define`, patch `TC.Commands.submit`, replace
`TC.Save.saveNow`, or silently exfiltrate localStorage (saves contain no
secrets today, but imported-save griefing and identity forgery are trivial).
An "executable mod" that is just third-party script in the page is therefore
arbitrary code execution with the authority of the lead module: it can forge
multiplayer truth, corrupt saves, and break determinism invisibly.

Non-goals that follow: loading `<script>` mods from disk/URL, exposing
`window.TC` as "the mod API", wrapping systems at runtime (banned by
architecture since W18), and any `eval`/`new Function` path regardless of
wrapper polish.

## Platform constraints (static vanilla JS, browser-first)

- **Same-origin page scripts are not sandboxable.** There is no mechanism to
  give same-realm code limited powers. Object freezing/sealing of `TC` raises
  effort, not barriers (`Object.freeze` is bypassable via iframes' primordials;
  proxies are detectable; realms can be crossed).
- **Web Workers**: real isolation boundary (no DOM, structured-clone messaging,
  separate global). Feasible host side. Costs: no synchronous access to world
  state (all reads become request/response snapshots), ~100–300 ms startup per
  worker, and the simulation contract problem below.
- **iframes**: same-origin iframes share nothing by default but are trivially
  escaped by same-origin policy (`parent.TC`). Cross-origin sandboxes
  (`sandbox="allow-scripts"`) cannot be given typed data without postMessage
  serialization everywhere. Net result: complexity of Workers with weaker
  guarantees.
- **Determinism**: the simulation is fixed-step, seeded via `TC.GameRng`, and
  replay-proof (soak digests). Any mod hook that mutates authoritative state
  outside canonical transactions breaks replay equality AND multiplayer
  lockstep — two hosts running the same mod version but different JS engines
  (V8 vs SpiderMonkey) diverge on floating point/scheduling edge cases unless
  all logic routes through serialized command intents executed identically.
- **Multiplayer authority**: the server owns truth (W22–W24). Client-side mod
  behavior can only ever be presentation; server-side mods must run on every
  authoritative host and their effects must ride the existing protocol
  (command whitelist + region replication). Anything else desyncs.

## Capability-based model sketch (if ever built)

The only architecture consistent with the above:

1. Mod logic lives in a Worker; it receives **snapshots** (structured clones
   of bounded state slices) and emits **intents** (the existing networked
   command vocabulary + a small event subscription set).
2. The main thread validates every intent through the SAME canonical
   transaction layer used by local input (`TC.Commands.submit`) — mods gain no
   authority players don't have.
3. Determinism preserved because worker outputs are intents applied at tick
   boundaries; replay requires recording intent streams (extend SaveCore
   metadata; digests extend naturally).
4. Quotas: per-tick message budget + worker termination on overrun (CPU/time),
   memory capped by snapshot size limits. DoS containment is structural.
5. Versioning: mod identity rides the W25 pack-set fingerprint; gameplay mods
   participate exactly like data packs in save classification and handshake.
6. Lifecycle: install → enable → restart (same as data packs; no mid-session
   mutation), crash = disable + diagnostic, never half-applied.

Cost estimate: protocol additions, snapshot schema per system touched,
recording infrastructure, plus an FFI-shaped maintenance surface. This is a
campaign-sized effort (comparable to W22+W23 combined) whose demand has not
been demonstrated: every requested feature so far (content chains, blocks,
enemies, recipes, locales) fit W25's declarative schemas.

## Decision

**Defer.** Revisit when a concrete, named capability gap appears that (a)
cannot be expressed as data, (b) survives being expressed as a new BUILT-IN
declarative family instead, and (c) justifies the worker/intent/recording
infrastructure. Until then, the honest extensibility story is: more families
in the declarative schema (walls, NPCs/shops, loot tables, projectiles are the
natural next candidates), not executable logic.

If revisited, the non-negotiables recorded here apply: Worker isolation,
intent-only writes through canonical commands, tick-boundary application,
recorded intent streams for replay, pack-set identity integration, quotas +
termination, and never exposing `window.TC` as the API surface.

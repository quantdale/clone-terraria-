/* registry.js — TC.Registry: stable namespaced content registry.
//
// Implements ARCHITECTURE.md §3 (TASK_BOARD ARC-001): every persistable
// definition gets a stable 'namespace:name' string id (core:dirt,
// core:iron_bar, core:green_slime). Dense numeric indexes are derived per
// kind for hot paths, but persistent identity is ALWAYS the stable string.
//
// AUTO-MIRROR: at load, and again on every syncFromTables() call, the shared
// constants tables are walked READ-ONLY and each definition is registered
// under 'core:<snake_case(def.name)>' (fallback 'core:tile<N>' / table key
// when the name is missing or unusable). Legacy identities survive as alias
// mappings so old saves keep meaning:
//   tile / wall / recipe -> numeric aliases (array positions in TILE_DEFS /
//                           WALL_DEFS / RECIPES)
//   item / enemy         -> string-key aliases (ITEM_DEFS / ENEMY_DEFS keys;
//                           those tables have no numeric ids)
//   projectileType / buff -> mirrored opportunistically from
//                           TC.Projectiles.TYPES / TC.Buffs.DEFS when present
// Fixed core vocabulary (biomes, guide NPC, crafting stations) is seeded
// directly. Recipe-referenced stations are NOT auto-derived, so a typo'd
// station in a recipe fails validate() loudly.
// The mirrored tables are never mutated; defs are stored by reference.
//
// Owns exactly this file. Loads after js/constants.js (utils.js not needed).
// Sibling modules land in parallel and extend the shared tables at their own
// load time, so the lead MUST re-sync + validate once everything is loaded:
//   if (TC.Registry) TC.Registry.syncFromTables();  // absorb late content
//   if (TC.Registry) TC.Registry.validate();        // throws on problems
//
// Exposed API: TC.Registry.{KINDS, define, alias, stableToIndex, byIndex,
//   stableOfIndex, legacyToStable, get, has, all, count, validate,
//   fingerprint, syncFromTables}. */

(() => {
  const TC = (window.TC = window.TC || {});
  if (TC.Registry) return; // load-once guard

  // ======================================================================
  // Kinds, id format, storage
  // ======================================================================

  const KINDS = Object.freeze([
    "tile",
    "wall",
    "item",
    "recipe",
    "enemy",
    "npc",
    "buff",
    "projectileType",
    "biome",
    "station",
  ]);
  const CORE = "core";
  const ID_RE = /^[a-z0-9_]+:[a-z0-9_]+$/; // 'namespace:name'

  const buckets = Object.create(null); // kind -> storage
  const syncErrors = []; // mirror problems, surfaced by validate()

  function bucket(kind) {
    let b = buckets[kind];
    if (!b) {
      b = buckets[kind] = {
        byStable: Object.create(null), // 'ns:name' -> entry
        list: [], // dense index -> entry
        byNum: Object.create(null), // legacy numeric id -> stable id
        byKey: Object.create(null), // legacy string key -> stable id
      };
    }
    return b;
  }

  function fail(msg) {
    throw new Error("TC.Registry: " + msg);
  }

  function checkKind(kind) {
    if (KINDS.indexOf(kind) < 0) fail("unknown kind " + JSON.stringify(kind));
  }

  function snakeCase(s) {
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  // Stable id derived from a def: snake_case of def.name, else the fallback.
  function stableName(def, fallback) {
    const n = def && typeof def.name === "string" ? snakeCase(def.name) : "";
    return n || fallback;
  }

  function makeEntry(kind, id, def, index) {
    const c = id.indexOf(":");
    return {
      kind: kind,
      id: id,
      ns: id.slice(0, c), // content source/namespace
      name: id.slice(c + 1),
      index: index,
      def: def,
      legacy: [], // numeric ids aliased here
      legacyKeys: [], // string keys aliased here
    };
  }

  function totalCount() {
    let n = 0;
    for (let k = 0; k < KINDS.length; k++) n += bucket(KINDS[k]).list.length;
    return n;
  }

  // ======================================================================
  // Registration
  // ======================================================================

  // Register a definition under a namespaced stable id. Duplicate ids throw.
  // Returns the registry entry ({kind, id, ns, name, index, def, legacy}).
  function define(kind, id, def) {
    checkKind(kind);
    if (typeof id !== "string" || !ID_RE.test(id)) {
      fail(
        "bad stable id " +
          JSON.stringify(id) +
          " for " +
          kind +
          " (want lowercase 'ns:name')",
      );
    }
    if (!def || typeof def !== "object")
      fail(kind + " '" + id + "': def must be an object");
    const b = bucket(kind);
    if (b.byStable[id]) fail("duplicate " + kind + " id '" + id + "'");
    const entry = makeEntry(kind, id, def, b.list.length);
    b.byStable[id] = entry;
    b.list.push(entry);
    return entry;
  }

  // Map a legacy numeric id onto a registered stable id (old saves keep
  // meaning). Same mapping twice is a no-op; conflicting remaps throw.
  function alias(kind, stableId, legacyNumericId) {
    checkKind(kind);
    const b = bucket(kind);
    const e = typeof stableId === "string" ? b.byStable[stableId] : null;
    if (!e) fail("cannot alias: unknown " + kind + " '" + stableId + "'");
    if (
      typeof legacyNumericId !== "number" ||
      !Number.isInteger(legacyNumericId) ||
      legacyNumericId < 0
    ) {
      fail(
        "alias for " +
          kind +
          " '" +
          stableId +
          "': legacy id must be an integer >= 0",
      );
    }
    const prev = b.byNum[legacyNumericId];
    if (prev === stableId) return e;
    if (prev) {
      fail(
        "conflict: legacy " +
          kind +
          " #" +
          legacyNumericId +
          " already maps to '" +
          prev +
          "', cannot remap to '" +
          stableId +
          "'",
      );
    }
    b.byNum[legacyNumericId] = stableId;
    e.legacy.push(legacyNumericId);
    return e;
  }

  // String-key variant used by the mirror (ITEM_DEFS/ENEMY_DEFS save keys).
  function aliasKey(kind, stableId, legacyKeyStr) {
    const b = bucket(kind);
    const e = typeof stableId === "string" ? b.byStable[stableId] : null;
    if (!e) fail("cannot alias: unknown " + kind + " '" + stableId + "'");
    if (typeof legacyKeyStr !== "string" || !legacyKeyStr) {
      fail(
        "aliasKey for " +
          kind +
          " '" +
          stableId +
          "': legacy key must be a non-empty string",
      );
    }
    const prev = b.byKey[legacyKeyStr];
    if (prev === stableId) return e;
    if (prev) {
      fail(
        "conflict: legacy " +
          kind +
          " key '" +
          legacyKeyStr +
          "' already maps to '" +
          prev +
          "', cannot remap to '" +
          stableId +
          "'",
      );
    }
    b.byKey[legacyKeyStr] = stableId;
    e.legacyKeys.push(legacyKeyStr);
    return e;
  }

  // ======================================================================
  // Lookup
  // ======================================================================

  // Resolve any reference form to its stable id: full 'ns:name' wins, then
  // the legacy string key, then a 'core:'-prefixed shorthand; integers go
  // through the legacy numeric map. Returns null when unresolvable.
  function legacyToStable(kind, ref) {
    const b = bucket(kind);
    if (ref == null) return null;
    if (typeof ref === "number") {
      return (Number.isInteger(ref) && b.byNum[ref]) || null;
    }
    if (typeof ref !== "string") return null;
    if (ref.indexOf(":") >= 0) return b.byStable[ref] ? ref : null;
    if (b.byKey[ref]) return b.byKey[ref];
    const sh = CORE + ":" + ref;
    return b.byStable[sh] ? sh : null;
  }

  // Stable id -> dense numeric index (-1 when unknown). Accepts any
  // reference form legacyToStable understands (old saves pass raw numbers).
  function stableToIndex(kind, id) {
    const s = legacyToStable(kind, id);
    if (s == null) return -1;
    const e = bucket(kind).byStable[s];
    return e ? e.index : -1;
  }

  // Dense numeric index -> registry entry (null when out of range).
  function byIndex(kind, idx) {
    const b = bucket(kind);
    const i = typeof idx === "number" && Number.isInteger(idx) ? idx : -1;
    return i >= 0 && i < b.list.length ? b.list[i] : null;
  }

  // Dense numeric index -> stable id (null when out of range).
  function stableOfIndex(kind, idx) {
    const e = byIndex(kind, idx);
    return e ? e.id : null;
  }

  // Def lookup by stable id or any legacy reference form.
  function get(kind, id) {
    const s = legacyToStable(kind, id);
    const e = s ? bucket(kind).byStable[s] : null;
    return e ? e.def : null;
  }

  function has(kind, id) {
    return legacyToStable(kind, id) != null;
  }

  // Snapshot array of all entries for a kind (index == entry.index).
  function all(kind) {
    return bucket(kind).list.slice();
  }

  function count(kind) {
    return bucket(kind).list.length;
  }

  // ======================================================================
  // Fingerprint — FNV-1a over sorted content lines
  // ======================================================================

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // Deterministic 8-hex-char digest of registered content: sorted 'kind:id'
  // lines plus '#<num>' / '~<key>' alias lines. Depends only on WHAT is
  // registered, never on registration order. Record in saves (ARCHITECTURE
  // §11 registryFingerprint) and future network handshakes.
  function fingerprint() {
    const lines = [];
    for (let k = 0; k < KINDS.length; k++) {
      const b = bucket(KINDS[k]);
      for (const id in b.byStable) {
        const e = b.byStable[id];
        lines.push(e.kind + ":" + e.id);
        for (let i = 0; i < e.legacy.length; i++)
          lines.push(e.kind + ":" + e.id + "#" + e.legacy[i]);
        for (let i = 0; i < e.legacyKeys.length; i++)
          lines.push(e.kind + ":" + e.id + "~" + e.legacyKeys[i]);
      }
    }
    lines.sort();
    return ("00000000" + fnv1a(lines.join("\n")).toString(16)).slice(-8);
  }

  // ======================================================================
  // Auto-mirror of the shared constants tables (read-only)
  // ======================================================================

  // Mirror-side register: skips known ids and records problems for
  // validate() instead of throwing, so a data bug in a mirrored table can
  // never break script loading. Explicit define() stays strict.
  function mirrorDefine(kind, id, def) {
    const b = bucket(kind);
    if (b.byStable[id]) return b.byStable[id];
    try {
      return define(kind, id, def);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (syncErrors.indexOf(msg) < 0) syncErrors.push(msg);
      return null;
    }
  }

  function safeAlias(fn, kind, stableId, legacyRef) {
    try {
      return fn(kind, stableId, legacyRef);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (syncErrors.indexOf(msg) < 0) syncErrors.push(msg);
      return null;
    }
  }

  function mirrorArray(kind, defs, fallbackPrefix) {
    if (!Array.isArray(defs)) return;
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (!def || typeof def !== "object") continue;
      // A module may have already registered this exact def object under its
      // own namespace (wiring.js does). Prefer that entry: alias the numeric
      // index to it instead of minting a parallel core:* duplicate.
      const owned = findByDef(kind, def);
      if (owned) {
        safeAlias(alias, kind, owned.id, i);
        continue;
      }
      const id = CORE + ":" + stableName(def, fallbackPrefix + i);
      if (mirrorDefine(kind, id, def)) safeAlias(alias, kind, id, i);
    }
  }

  function mirrorObject(kind, defs) {
    if (!defs) return;
    for (const key in defs) {
      const def = defs[key];
      if (!def || typeof def !== "object") continue;
      const owned = findByDef(kind, def);
      if (owned) {
        safeAlias(aliasKey, kind, owned.id, key);
        continue;
      }
      const id = CORE + ":" + stableName(def, snakeCase(key));
      if (mirrorDefine(kind, id, def)) safeAlias(aliasKey, kind, id, key);
    }
  }

  // Identity lookup: the entry whose registered def IS this object. O(n) per
  // miss but mirror walks are rare (load/boot/explicit sync only).
  function findByDef(kind, def) {
    const list = bucket(kind).list;
    for (let i = 0; i < list.length; i++) {
      if (list[i].def === def) return list[i];
    }
    return null;
  }

  // Recipes have no natural name: derive from the output item, disambiguating
  // repeat outputs within one scan ('core:r_torch', 'core:r_torch_2', ...).
  // Stations referenced here resolve against the seeded core stations (or
  // explicit defines); unknown ones are flagged by validate().
  function mirrorRecipes() {
    const recs = TC.RECIPES;
    if (!Array.isArray(recs)) return;
    const seenOut = Object.create(null);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!r || typeof r !== "object") continue;
      const outSnake = snakeCase(r.out == null ? "unknown" : String(r.out));
      seenOut[outSnake] = (seenOut[outSnake] || 0) + 1;
      const id =
        CORE +
        ":r_" +
        outSnake +
        (seenOut[outSnake] > 1 ? "_" + seenOut[outSnake] : "");
      if (mirrorDefine("recipe", id, r)) safeAlias(alias, "recipe", id, i);
    }
  }

  const CORE_BIOMES = [
    "forest",
    "desert",
    "snow",
    "jungle",
    "ocean",
    "cave",
    "underworld",
  ];
  const CORE_STATIONS = ["workbench", "furnace", "anvil"];

  function seedFixedContent() {
    for (let i = 0; i < CORE_BIOMES.length; i++) {
      mirrorDefine("biome", CORE + ":" + CORE_BIOMES[i], {
        name: CORE_BIOMES[i],
      });
    }
    for (let i = 0; i < CORE_STATIONS.length; i++) {
      mirrorDefine("station", CORE + ":" + CORE_STATIONS[i], {
        name: CORE_STATIONS[i],
      });
    }
    mirrorDefine("npc", CORE + ":guide", { name: "Guide" });
  }

  // Re-walk every known source table; idempotent, so call freely after all
  // modules have loaded (and any time new content is appended at runtime).
  function syncFromTables() {
    const before = totalCount();
    seedFixedContent();
    mirrorArray("tile", TC.TILE_DEFS, "tile");
    mirrorArray("wall", TC.WALL_DEFS, "wall");
    mirrorObject("item", TC.ITEM_DEFS);
    mirrorRecipes();
    mirrorObject("enemy", TC.ENEMY_DEFS);
    if (TC.Projectiles && TC.Projectiles.TYPES)
      mirrorObject("projectileType", TC.Projectiles.TYPES);
    if (TC.Buffs && TC.Buffs.DEFS) mirrorObject("buff", TC.Buffs.DEFS);
    return { added: totalCount() - before, errors: syncErrors.slice() };
  }

  // ======================================================================
  // Validation — duplicates throw at define(); here we check references
  // ======================================================================

  function validate() {
    const errs = syncErrors.slice();
    const bad = (msg) => errs.push(msg);

    const need = (who, field, ref, targetKind) => {
      if (ref == null) return;
      if (!has(targetKind, ref)) {
        bad(
          who +
            ": " +
            field +
            " " +
            JSON.stringify(ref) +
            " does not resolve to a registered " +
            targetKind,
        );
      }
    };

    // Missing numerics follow the consumer convention '(field || 0)' —
    // e.g. worldgen.js tile extensions omit minPower entirely.
    const numOr = (v, def) => (v == null ? def : v);

    for (const e of bucket("tile").list) {
      const who = e.kind + " '" + e.id + "'";
      const d = e.def;
      const hardness = numOr(d.hardness, 0);
      if (typeof hardness !== "number" || !isFinite(hardness) || hardness < 0) {
        bad(who + ": hardness must be a finite number >= 0");
      }
      const minPower = numOr(d.minPower, 0);
      if (typeof minPower !== "number" || !isFinite(minPower) || minPower < 0) {
        bad(who + ": minPower must be a finite number >= 0");
      }
      const light = numOr(d.light, 0);
      if (
        typeof light !== "number" ||
        !isFinite(light) ||
        light < 0 ||
        light > 1
      ) {
        bad(who + ": light must be a finite number within 0..1");
      }
      if (d.tool != null && typeof d.tool !== "string")
        bad(who + ": tool must be null or a string");
      need(who, "drop", d.drop, "item");
    }

    for (const e of bucket("wall").list) {
      const d = e.def;
      const hardness = numOr(d.hardness, 0);
      if (typeof hardness !== "number" || !isFinite(hardness) || hardness < 0) {
        bad(e.kind + " '" + e.id + "': hardness must be a finite number >= 0");
      }
    }

    for (const e of bucket("item").list) {
      const who = e.kind + " '" + e.id + "'";
      const d = e.def;
      need(who, "tile", d.tile, "tile");
      // '__'-prefixed boss values are reserved sentinels (e.g.
      // '__blood_moon__' starts an event), not content references.
      if (d.boss != null && String(d.boss).slice(0, 2) !== "__") {
        need(who, "boss", d.boss, "enemy");
      }
      if (
        d.projectile != null &&
        !has("projectileType", d.projectile) &&
        !has("item", d.projectile)
      ) {
        bad(
          who +
            ": projectile " +
            JSON.stringify(d.projectile) +
            " resolves to neither a projectileType nor an item",
        );
      }
    }

    for (const e of bucket("recipe").list) {
      const who = e.kind + " '" + e.id + "'";
      const r = e.def;
      need(who, "output", r.out, "item");
      const n = r.n == null ? 1 : r.n;
      if (!Number.isInteger(n) || n < 1)
        bad(who + ": yield must be an integer >= 1");
      if (r.station != null) need(who, "station", r.station, "station");
      if (r.cost) {
        for (const k in r.cost) {
          need(who, "ingredient", k, "item");
          const amt = r.cost[k];
          if (typeof amt !== "number" || !isFinite(amt) || amt <= 0) {
            bad(
              who + ": cost amount for '" + k + "' must be a finite number > 0",
            );
          }
        }
      }
    }

    for (const e of bucket("enemy").list) {
      const who = e.kind + " '" + e.id + "'";
      const d = e.def;
      if (typeof d.hp !== "number" || !(d.hp > 0))
        bad(who + ": hp must be a number > 0");
      if (typeof d.dmg !== "number" || !isFinite(d.dmg) || d.dmg < 0) {
        bad(who + ": dmg must be a finite number >= 0");
      }
      if (d.drops != null) {
        if (Array.isArray(d.drops)) {
          for (const dr of d.drops) {
            if (!dr || typeof dr !== "object") {
              bad(who + ": drops entries must be objects");
              continue;
            }
            need(who, "drops[].id", dr.id, "item");
            if (
              typeof dr.chance !== "number" ||
              dr.chance <= 0 ||
              dr.chance > 1
            ) {
              bad(who + ": drops[].chance must be a number within (0, 1]");
            }
          }
        } else {
          bad(who + ": drops must be an array");
        }
      }
    }

    if (errs.length) {
      throw new Error(
        "TC.Registry validation failed (" +
          errs.length +
          " problem" +
          (errs.length === 1 ? "" : "s") +
          "):\n - " +
          errs.join("\n - "),
      );
    }
    return { ok: true, checked: totalCount() };
  }

  // ======================================================================
  // Boot: mirror whatever exists now, attach API
  // ======================================================================

  // Tables present at load are absorbed immediately; sibling modules that
  // land later are picked up by the next syncFromTables() call.
  try {
    syncFromTables();
  } catch (err) {
    syncErrors.push(String((err && err.message) || err));
  }

  TC.Registry = {
    KINDS: KINDS,
    define: define,
    alias: alias,
    aliasKey: aliasKey,
    stableToIndex: stableToIndex,
    byIndex: byIndex,
    stableOfIndex: stableOfIndex,
    legacyToStable: legacyToStable,
    get: get,
    has: has,
    all: all,
    count: count,
    validate: validate,
    fingerprint: fingerprint,
    syncFromTables: syncFromTables,
  };
})();

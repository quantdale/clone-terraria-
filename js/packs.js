/* packs.js — TC.Packs: THE canonical pack authority (W25 MOD-001/002/003).
//
// Safe extensibility foundation: declarative resource packs (presentation
// localization fragments) and declarative data packs (tiles/items/enemies/
// recipes) with a fail-closed security boundary. Pack input is UNTRUSTED:
//
//   parse -> structural validation -> semantic/reference validation ->
//   dependency/version resolution -> deterministic identity ->
//   staged registration -> ATOMIC commit
//
// No partially-applied pack state ever exists: every manifest is fully
// validated and staged before the first byte of live state is touched, and
// the commit phase journals every mutation so an unexpected failure rolls
// back to the previous coherent configuration.
//
// SECURITY POLICY (fail closed — anything not explicitly allowed is rejected):
// - no eval/new Function/script injection anywhere in this pipeline; packs
//   are pure data and can never supply callbacks, handlers or hooks;
// - prototype-pollution keys ('__proto__', 'prototype', 'constructor') are
//   rejected wherever they appear;
// - non-finite numbers, functions/symbols, oversized strings/arrays/depths,
//   unknown manifest fields, unknown schema versions: rejected;
// - content namespaces are always '<packid>:...' — the built-in 'core'
//   namespace cannot be hijacked and pack content cannot masquerade as
//   built-in content;
// - enemy ai/look and tile patterns must reference BUILT-IN vocabulary
//   resolved against the live registries at stage time;
// - resource paths (future file-backed resources) are validated as relative,
//   traversal-free segments inside the pack's own namespace root.
//
// IDENTITY MODEL (WS4):
//   A. built-in stable identity is untouched — loading zero packs preserves
//      the historical registry fingerprint exactly;
//   B. TC.Packs.digest() fingerprints the active GAMEPLAY pack set (resource
//      packs excluded), TC.Packs.contentDigest() covers every active pack;
//   C. pack-owned stable ids are '<packid>:<key>';
//   D. dense runtime indices append after the built-ins in topological
//      dependency order with ascending-pack-id tie-breaks, so subsets keep
//      their indices stable across sessions.
//
// Deactivation mid-session is deliberately unsupported (dense tile indices
// would shift); changing the active set requires a fresh world/session and
// save compatibility is classified BEFORE any world state mutates (MOD-003).
//
// Owns exactly this file. Loads after settings/localization; activation runs
// from main boot (after all modules load) via TC.Packs.setActive().
// Exposed API: TC.Packs.{MANIFEST_VERSION, GAME_VERSION, Error, provide,
//   provideJSON, getManifest, available, setActive, deactivateAll, active,
//   isActive, digest, contentDigest, saveMetadata, classifySave, stats}. */

(() => {
  const TC = (window.TC = window.TC || {});
  if (TC.Packs) return; // load-once guard

  // ======================================================================
  // Constants and limits (every bound is a security bound, not style)
  // ======================================================================

  const MANIFEST_VERSION = 1;
  const GAME_VERSION = "0.9"; // compat target for requires.game ranges

  const MAX_MANIFEST_BYTES = 256 * 1024; // serialized JSON size cap
  const MAX_DEPTH = 12; // nested object/array depth cap
  const MAX_NAME = 48;
  const MAX_DESC = 200;

  const PACK_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
  const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
  const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const RESERVED_NS = { core: 1, tc: 1, system: 1 };
  const FORBIDDEN_KEYS = {
    __proto__: 1,
    prototype: 1,
    constructor: 1,
  };

  const FAMILY_LIMITS = {
    tiles: 128,
    items: 256,
    enemies: 128,
    recipes: 256,
    walls: 64,
    lootTables: 64,
    spawnRules: 64,
  };
  const MAX_DEPS = 16;
  const MAX_PACKS_ACTIVE = 16;

  // Tile patterns a data pack may use: inert painters only. Mechanism /
  // behaviour-carrying patterns (torches, plants, platforms, liquids,
  // stations, ropes, chains) require runtime registration and stay
  // built-in-only in W25.
  const SAFE_TILE_PATTERNS = {
    speckle: 1,
    grass: 1,
    plank: 1,
    trunk: 1,
    leafy: 1,
    ore: 1,
    glass: 1,
  };

  // Enemy AI archetypes that pull in boss/encounter machinery — packs get
  // regular enemies only in W25 (bosses need encounter lifecycle ownership).
  const BOSS_AI = {
    king_slime: 1,
    eye_boss: 1,
    skeletron: 1,
    skele_hand: 1,
    wof: 1,
    storm_jelly: 1,
    moss_mother: 1,
    hungry: 1,
  };

  const ITEM_KINDS = { material: 1, block: 1, weapon: 1, summon: 1 };
  const TOOL_KINDS = { pick: 1, axe: 1, any: 1 };
  const SUMMON_TIMES = { any: 1, day: 1, night: 1 };

  // ======================================================================
  // Errors
  // ======================================================================

  function PackError(code, message, details) {
    const e = new Error(
      details && details.length
        ? message + ": " + String(details[0]) +
          (details.length > 1 ? " (+" + (details.length - 1) + " more)" : "")
        : message,
    );
    e.name = "PackError";
    e.code = code; // machine-readable class ('manifest', 'schema', 'reference',
    // 'dependency', 'version', 'duplicate', 'security', 'commit')
    e.details = details || []; // per-problem strings for UI/diagnostics
    return e;
  }

  // ======================================================================
  // Small helpers
  // ======================================================================

  function fail(code, msg, details) {
    throw PackError(code, msg, details);
  }

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // Deterministic canonical serialization: sorted object keys, arrays in
  // order, no whitespace. Equivalent manifests produce identical digests
  // regardless of key insertion order (WS5 normalization rule).
  function canonical(v, out) {
    out = out || [];
    if (v === null) out.push("null");
    else if (Array.isArray(v)) {
      out.push("[");
      for (let i = 0; i < v.length; i++) {
        if (i) out.push(",");
        canonical(v[i], out);
      }
      out.push("]");
    } else if (typeof v === "object") {
      const keys = Object.keys(v).sort();
      out.push("{");
      for (let i = 0; i < keys.length; i++) {
        if (i) out.push(",");
        out.push(JSON.stringify(keys[i]));
        out.push(":");
        canonical(v[keys[i]], out);
      }
      out.push("}");
    } else if (typeof v === "number") out.push(String(v));
    else out.push(JSON.stringify(String(v)));
    return out.join("");
  }

  function digestOf(v) {
    const s = canonical(v);
    // Mix length into the line so collisions across sizes stay unlikely.
    return ("00000000" + fnv1a(s.length + ":" + s).toString(16)).slice(-8);
  }

  function snakeCase(s) {
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  // ---- global safety scan ------------------------------------------------
  // Walks ANY provided structure before schema validation enforces the
  // global invariants that must hold everywhere (types, finiteness, depth,
  // prototype-pollution keys). Schema checks then constrain placement.
  function safeScan(v, path, depth, errs) {
    if (depth > MAX_DEPTH) {
      errs.push(path + ": nesting deeper than " + MAX_DEPTH);
      return;
    }
    if (v === null || typeof v === "boolean") return;
    const t = typeof v;
    if (t === "number") {
      if (!isFinite(v)) errs.push(path + ": non-finite number");
      return;
    }
    if (t === "string") {
      if (v.length > 4096) errs.push(path + ": string longer than 4096 chars");
      return;
    }
    if (t !== "object") {
      errs.push(path + ": unsupported value type '" + t + "'");
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > 4096) errs.push(path + ": array longer than 4096");
      for (let i = 0; i < v.length; i++)
        safeScan(v[i], path + "[" + i + "]", depth + 1, errs);
      return;
    }
    for (const k in v) {
      if (FORBIDDEN_KEYS[k]) {
        errs.push(path + "." + k + ": forbidden key (prototype pollution)");
        continue;
      }
      safeScan(v[k], path + "." + k, depth + 1, errs);
    }
  }

  // ---- versions -----------------------------------------------------------
  // Versions are dotted integers 'X[.Y[.Z]]' (each 0..999). Ranges:
  //   '1.2.3'    exact
  //   '^1.2.3'   same major, >= version
  //   '>=1.2'    at least
  function parseVersion(s) {
    if (typeof s !== "string") return null;
    const parts = s.split(".");
    if (parts.length < 1 || parts.length > 3) return null;
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (!/^[0-9]{1,3}$/.test(parts[i])) return null;
      out.push(parseInt(parts[i], 10));
    }
    while (out.length < 3) out.push(0);
    return out;
  }

  function cmpVersion(a, b) {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  function rangeError(range) {
    if (typeof range !== "string" || range.length > 24) return "bad range";
    let mode = "exact";
    let body = range;
    if (range.slice(0, 2) === ">=") {
      mode = "min";
      body = range.slice(2);
    } else if (range.slice(0, 1) === "^") {
      mode = "caret";
      body = range.slice(1);
    }
    const v = parseVersion(body);
    if (!v) return "unparseable version in range";
    return null;
  }

  function versionSatisfies(verStr, range) {
    if (rangeError(range)) return false;
    const v = parseVersion(verStr);
    if (!v) return false;
    let mode = "exact";
    let body = range;
    if (range.slice(0, 2) === ">=") {
      mode = "min";
      body = range.slice(2);
    } else if (range.slice(0, 1) === "^") {
      mode = "caret";
      body = range.slice(1);
    }
    const r = parseVersion(body);
    const c = cmpVersion(v, r);
    if (mode === "min") return c >= 0;
    if (mode === "caret") return v[0] === r[0] && c >= 0;
    return c === 0;
  }

  // ======================================================================
  // Manifest structural validation
  // ======================================================================

  function strBounded(v, max) {
    return typeof v === "string" && v.length >= 1 && v.length <= max;
  }

  function optString(m, field, max, errs) {
    if (m[field] === undefined) return undefined;
    if (!strBounded(m[field], max))
      errs.push(field + " must be a string of 1.." + max + " chars");
    return m[field];
  }

  function validateManifestShape(m) {
    const errs = [];
    if (!isObj(m)) {
      fail("manifest", "manifest must be an object", ["got " + typeof m]);
    }
    // Fail closed on unknown top-level fields: a typo'd or future-unknown
    // key must never be silently ignored by the security boundary.
    const KNOWN_TOP = {
      manifest: 1, id: 1, name: 1, version: 1, type: 1, description: 1,
      requires: 1, optional: 1, content: 1, resources: 1,
    };
    for (const k in m) {
      if (!KNOWN_TOP[k]) errs.push("unknown manifest field '" + k + "'");
    }
    if (m.manifest !== MANIFEST_VERSION) {
      fail(
        "manifest",
        "unsupported manifest schema version",
        ["expected manifest:" + MANIFEST_VERSION + ", got " +
          JSON.stringify(m.manifest)],
      );
    }
    if (typeof m.id !== "string" || !PACK_ID_RE.test(m.id)) {
      errs.push("id must match [a-z][a-z0-9_]{1,31}");
    } else if (RESERVED_NS[m.id]) {
      errs.push("id '" + m.id + "' is a reserved namespace");
    }
    optString(m, "name", MAX_NAME, errs);
    if (m.version !== undefined && parseVersion(m.version) == null) {
      errs.push("version must be dotted integers like '1.2.3'");
    }
    if (m.type !== undefined && m.type !== "data" && m.type !== "resource") {
      errs.push("type must be 'data' or 'resource'");
    }
    optString(m, "description", MAX_DESC, errs);

    // Dependencies / optional dependencies / game compat.
    let deps = null;
    let optionalDeps = null;
    if (m.requires !== undefined) {
      if (!isObj(m.requires)) errs.push("requires must be an object");
      else {
        const seen = { game: 1, packs: 1 };
        for (const k in m.requires) {
          if (!seen[k]) errs.push("unknown requires field '" + k + "'");
        }
        if (m.requires.game !== undefined) {
          const e = rangeError(m.requires.game);
          if (e) errs.push("requires.game: " + e);
        }
        if (m.requires.packs !== undefined) {
          if (!isObj(m.requires.packs)) errs.push("requires.packs must be an object");
          else {
            const n = Object.keys(m.requires.packs).length;
            if (n > MAX_DEPS) errs.push("too many required packs (max " + MAX_DEPS + ")");
            deps = {};
            for (const id in m.requires.packs) {
              if (!PACK_ID_RE.test(id)) {
                errs.push("requires.packs.'" + id + "': bad pack id");
                continue;
              }
              if (id === m.id) {
                errs.push("pack cannot depend on itself");
                continue;
              }
              const e = rangeError(m.requires.packs[id]);
              if (e) {
                errs.push("requires.packs.'" + id + "': " + e);
                continue;
              }
              deps[id] = m.requires.packs[id];
            }
          }
        }
      }
    }
    if (m.optional !== undefined) {
      if (!isObj(m.optional)) errs.push("optional must be an object");
      else if (m.optional.packs !== undefined) {
        if (!isObj(m.optional.packs)) errs.push("optional.packs must be an object");
        else {
          optionalDeps = {};
          for (const id in m.optional.packs) {
            const e = rangeError(m.optional.packs[id]);
            if (e) errs.push("optional.packs.'" + id + "': " + e);
            else optionalDeps[id] = m.optional.packs[id];
          }
        }
      }
    }

    // Resources (resource packs): locale catalog fragments keyed by locale id.
    if (m.resources !== undefined) {
      if (!isObj(m.resources)) errs.push("resources must be an object");
      else {
        for (const k in m.resources) {
          if (k === "locale") {
            const loc = m.resources.locale;
            if (!isObj(loc)) errs.push("resources.locale must be an object");
            else {
              for (const lid in loc) {
                if (!LOCALE_RE.test(lid)) {
                  errs.push("resources.locale.'" + lid + "': bad locale id");
                } else if (!isObj(loc[lid])) {
                  errs.push("resources.locale.'" + lid + "' must be an object");
                }
              }
            }
          } else if (k === "files") {
            // Future-ready declarative resource descriptors: paths must be
            // relative, traversal-free segments inside THIS pack's namespace.
            const files = m.resources.files;
            if (!Array.isArray(files)) errs.push("resources.files must be an array");
            else {
              if (files.length > 256) errs.push("resources.files too long (max 256)");
              for (let i = 0; i < files.length; i++) {
                const f = files[i];
                if (typeof f !== "string" || !f.length || f.length > 200) {
                  errs.push("resources.files[" + i + "]: must be a short path string");
                  continue;
                }
                if (
                  f.indexOf("\\") >= 0 ||
                  f.slice(0, 1) === "/" ||
                  f.indexOf("//") >= 0 ||
                  f.split("/").indexOf("..") >= 0 ||
                  f.split("/").indexOf(".") >= 0 ||
                  !/^[a-z0-9][a-z0-9_.\/-]*$/.test(f)
                ) {
                  errs.push(
                    "resources.files[" + i + "]: path escapes pack resource root",
                  );
                }
              }
            }
          } else {
            errs.push("unknown resources section '" + k + "'");
          }
        }
      }
    }

    // Content families (data packs).
    if (m.content !== undefined) {
      if (!isObj(m.content)) errs.push("content must be an object");
      else {
        const knownFam = { tiles: 1, items: 1, enemies: 1, recipes: 1, walls: 1, lootTables: 1, spawnRules: 1 };
        for (const k in m.content) {
          if (!knownFam[k]) {
            errs.push("unknown content family '" + k + "'");
            continue;
          }
          if (!Array.isArray(m.content[k])) {
            errs.push("content." + k + " must be an array");
            continue;
          }
          if (m.content[k].length > FAMILY_LIMITS[k]) {
            errs.push(
              "content." + k + " exceeds " + FAMILY_LIMITS[k] + " entries",
            );
          }
        }
        if (
          m.type === "resource" &&
          Object.keys(m.content).length > 0
        ) {
          errs.push("resource packs cannot declare gameplay content");
        }
      }
    }
    if (
      m.type !== "resource" &&
      m.content === undefined &&
      (m.resources === undefined)
    ) {
      errs.push("pack declares neither content nor resources");
    }

    if (errs.length) {
      fail(
        "manifest",
        "pack '" + String(m.id == null ? "?" : m.id) + "': invalid manifest",
        errs,
      );
    }
    return { deps: deps || {}, optionalDeps: optionalDeps || {} };
  }

  // ======================================================================
  // Provided-pack store
  // ======================================================================

  const provided = new Map(); // id -> frozen normalized record
  let activeList = []; // activated pack ids in deterministic order
  let activeRecords = []; // parallel records
  const committed = new Map(); // id -> rawDigest of the LIVE committed content
  let spawnRules = []; // compiled global spawn rules in committed pack order
  let spawnRuleCounter = 0; // deterministic order tick
  let statsCounters = {
    provided: 0,
    attempts: 0,
    ok: 0,
    failed: 0,
    committedEntries: 0,
    rollbacks: 0,
    rejectedJson: 0,
  };
  let lastError = null;

  function normalizeRecord(m, parsed) {
    const type = m.type === "resource" ? "resource" : "data";
    const version = m.version == null ? "1.0.0" : m.version;
    return Object.freeze({
      id: m.id,
      name: m.name || m.id,
      version: version,
      type: type,
      description: m.description || "",
      gameRange: (m.requires && m.requires.game) || null,
      deps: Object.freeze(Object.assign({}, parsed.deps)),
      optionalDeps: Object.freeze(Object.assign({}, parsed.optionalDeps)),
      content: m.content || null,
      resources: m.resources || null,
      rawDigest: digestOf(m),
    });
  }

  // Provide a manifest for later activation. The manifest object is cloned
  // through canonicalization-safe deep copy AFTER scanning, so later caller
  // mutations of the original object cannot mutate registered truth.
  function provide(manifest) {
    const scanErrs = [];
    try {
      safeScan(manifest, "manifest", 0, scanErrs);
    } catch (e) {
      scanErrs.push("scan failed: " + (e && e.message));
    }
    if (scanErrs.length) {
      lastError = PackError("security", "manifest rejected by safety scan", scanErrs);
      throw lastError;
    }
    const parsed = validateManifestShape(manifest);
    if (provided.has(manifest.id)) {
      const prev = provided.get(manifest.id);
      if (prev.rawDigest === digestOf(manifest)) return prev; // idempotent
      fail(
        "duplicate",
        "pack id '" + manifest.id + "' already provided with different content",
      );
    }
    const rec = normalizeRecord(manifest, parsed);
    provided.set(rec.id, rec);
    statsCounters.provided++;
    return rec;
  }

  function provideJSON(text) {
    try {
      if (typeof text !== "string" || !text.length) {
        fail("manifest", "pack JSON must be a non-empty string");
      }
      if (text.length > MAX_MANIFEST_BYTES) {
        fail("manifest", "pack JSON exceeds " + MAX_MANIFEST_BYTES + " bytes");
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        fail("manifest", "malformed pack JSON: " + (e && e.message));
      }
      return provide(data);
    } catch (e) {
      statsCounters.rejectedJson++; // every rejected payload counts once
      throw e;
    }
  }

  // Validate JSON through the same fail-closed boundary as provideJSON, but
  // do not register it. PackStore uses this for an explicit replacement: the
  // old record may already be provided in this session, so calling provideJSON
  // would either mutate nothing or report a duplicate after store state had
  // already changed. The returned digest is the exact manifest identity used
  // by provide()/normalizeRecord().
  function validateJSON(text) {
    try {
      if (typeof text !== "string" || !text.length) {
        fail("manifest", "pack JSON must be a non-empty string");
      }
      if (text.length > MAX_MANIFEST_BYTES) {
        fail("manifest", "pack JSON exceeds " + MAX_MANIFEST_BYTES + " bytes");
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        fail("manifest", "malformed pack JSON: " + (e && e.message));
      }
      const scanErrs = [];
      try {
        safeScan(data, "manifest", 0, scanErrs);
      } catch (e) {
        scanErrs.push("scan failed: " + (e && e.message));
      }
      if (scanErrs.length) {
        fail("security", "manifest rejected by safety scan", scanErrs);
      }
      validateManifestShape(data);
      return { id: data.id, rawDigest: digestOf(data) };
    } catch (e) {
      statsCounters.rejectedJson++;
      throw e;
    }
  }

  function getManifest(id) {
    return provided.get(id) || null;
  }

  function available() {
    const out = [];
    for (const id of Array.from(provided.keys()).sort()) {
      const r = provided.get(id);
      out.push({
        id: r.id,
        name: r.name,
        version: r.version,
        type: r.type,
        active: activeList.indexOf(r.id) >= 0,
      });
    }
    return out;
  }

  // ======================================================================
  // Dependency resolution (deterministic topo order, ascending-id ties)
  // ======================================================================

  function resolveOrder(requested) {
    const problems = [];
    const chosen = new Set();
    const visit = (id, chain, viaRange) => {
      if (chain.indexOf(id) >= 0) {
        problems.push(
          "cyclic dependency involving '" + id + "' (" + chain.join(" -> ") + " -> " + id + ")",
        );
        return;
      }
      if (chosen.has(id)) return;
      const rec = provided.get(id);
      if (!rec) {
        problems.push(
          "missing dependency: pack '" + id + "'" +
            (viaRange ? " (required as " + viaRange + ")" : "") +
            " is not available",
        );
        return;
      }
      chosen.add(id);
      const nextChain = chain.concat(id);
      const depIds = Object.keys(rec.deps).sort();
      for (const d of depIds) {
        visit(d, nextChain, rec.id + " requires " + d + "@" + rec.deps[d]);
      }
    };
    for (const id of requested) {
      if (!PACK_ID_RE.test(id)) {
        problems.push("'" + id + "' is not a valid pack id");
        continue;
      }
      visit(id, [], null);
    }
    if (problems.length) fail("dependency", "dependency resolution failed", problems);

    // Version satisfaction among the chosen set (both directions checked).
    for (const id of chosen) {
      const rec = provided.get(id);
      for (const d of Object.keys(rec.deps)) {
        const dep = provided.get(d);
        if (!dep) continue; // already reported above
        if (!versionSatisfies(dep.version, rec.deps[d])) {
          fail(
            "version",
            "incompatible dependency version",
            [
              "'" + id + "' requires " + d + "@" + rec.deps[d] +
                ", available version is " + dep.version,
            ],
          );
        }
      }
    }

    // Game compat range.
    for (const id of chosen) {
      const gr = provided.get(id).gameRange;
      if (gr != null && !versionSatisfies(GAME_VERSION, gr)) {
        fail(
          "version",
          "pack '" + id + "' requires game " + gr + ", this build is " + GAME_VERSION,
        );
      }
    }

    // Kahn's algorithm over required edges only; tie-break ascending id so
    // the order depends ONLY on the graph shape, never on provide/request
    // order (WS4 determinism).
    const ids = Array.from(chosen).sort();
    const remaining = new Map();
    const dependents = new Map();
    for (const id of ids) {
      const rec = provided.get(id);
      const reqs = Object.keys(rec.deps).filter((d) => chosen.has(d)).sort();
      remaining.set(id, reqs);
      for (const r of reqs) {
        if (!dependents.has(r)) dependents.set(r, []);
        dependents.get(r).push(id);
      }
    }
    const ordered = [];
    const done = new Set();
    while (ordered.length < ids.length) {
      let picked = null;
      for (const id of ids) {
        if (done.has(id)) continue;
        const reqs = remaining.get(id);
        let ready = true;
        for (const r of reqs) {
          if (!done.has(r)) {
            ready = false;
            break;
          }
        }
        if (ready) {
          picked = id;
          break;
        }
      }
      if (picked == null) {
        // Cycle missed by DFS (should not happen) — fail closed anyway.
        fail("dependency", "dependency cycle detected among: " + ids.join(", "));
      }
      done.add(picked);
      ordered.push(picked);
    }
    return ordered;
  }

  // ======================================================================
  // Content family staging (pure: builds normalized entries, mutates nothing)
  // ======================================================================

  // Reference resolution against the UNION of built-in registry content and
  // already-staged pack content. Bare keys resolve only when unambiguous.
  function makeResolver(kind, stagedMaps) {
    // stagedMaps: [{key -> stableId}] in staging order.
    return function resolve(ref, what) {
      if (ref == null) return null;
      if (typeof ref === "number") {
        // Numeric refs mean legacy built-in ids — resolve through registry.
        return TC.Registry ? TC.Registry.legacyToStable(kind, ref) : null;
      }
      if (typeof ref !== "string" || !ref.length) return null;
      if (ref.indexOf(":") >= 0) {
        // Explicitly namespaced: built-in registry knows core:*; staged
        // entries know their own ns:name.
        if (TC.Registry && TC.Registry.has(kind, ref)) return ref;
        for (const sm of stagedMaps) {
          if (sm && hasOwn(sm, ref)) return sm[ref];
        }
        return null;
      }
      const candidates = [];
      const core = TC.Registry ? TC.Registry.legacyToStable(kind, ref) : null;
      if (core) candidates.push(core);
      for (const sm of stagedMaps) {
        if (sm && hasOwn(sm, ref)) {
          if (candidates.indexOf(sm[ref]) < 0) candidates.push(sm[ref]);
        }
      }
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        return { ambiguous: candidates }; // caller reports
      }
      return null;
    };
  }

  function needRef(resolve, kind, ref, who, field, problems) {
    const r = resolve(ref, kind);
    if (r == null) {
      problems.push(who + ": " + field + " '" + ref + "' does not resolve to a registered " + kind);
      return null;
    }
    if (r && r.ambiguous) {
      problems.push(
        who + ": " + field + " '" + ref + "' is ambiguous (" + r.ambiguous.join(", ") + ")",
      );
      return null;
    }
    return r;
  }

  function boundedInt(v, lo, hi) {
    return (
      typeof v === "number" && isFinite(v) && (v | 0) === v && v >= lo && v <= hi
    );
  }

  function boundedNum(v, lo, hi) {
    return typeof v === "number" && isFinite(v) && v >= lo && v <= hi;
  }

  // Pass 1: reserve every entry's identity (stable ids + legacy keys) so
  // INTRA-PACK cross-family references resolve during pass 2 despite the
  // natural cycles (tile.drop -> own item, item.boss -> own enemy,
  // enemy.drops -> own items). Purely nominal: no def fields validated here.
  function reserveNames(rec, ctx, P) {
    const content = rec.content;
    if (!content) return;
    const ns = rec.id;
    const fams = [
      ["tiles", "tile", "stagedTiles", "stagedTileKeys"],
      ["items", "item", "stagedItems", "stagedItemKeys"],
      ["enemies", "enemy", "stagedEnemies", "stagedEnemyKeys"],
      ["walls", "wall", "stagedWalls", "stagedWallKeys"],
      ["lootTables", "lootTable", "stagedLootTables", "stagedLootTableKeys"],
    ];
    for (const [fam, , sidMapName, keyMapName] of fams) {
      const arr = content[fam];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        const who = ns + "." + fam + "[" + i + "]";
        if (!isObj(e)) {
          P.push(who + ": entry must be an object");
          continue;
        }
        let key = typeof e.key === "string" ? e.key : snakeCase(e.name);
        if (!KEY_RE.test(key || "")) {
          P.push(who + ": key must match [a-z][a-z0-9_]{0,31}");
          continue;
        }
        const sid = ns + ":" + key;
        if (ctx[sidMapName][sid]) {
          P.push(who + ": duplicate stable id '" + sid + "'");
          continue;
        }
        ctx[sidMapName][sid] = sid;
        const m = {};
        m[sid] = sid;
        m[key] = sid;
        if (fam === "tiles") ctx.stagedMapsTiles.push(m);
        else if (fam === "items") ctx.stagedMapsItems.push(m);
        else if (fam === "enemies") ctx.stagedMapsEnemies.push(m);
        else if (fam === "walls") ctx.stagedMapsWalls.push(m);
        else ctx.stagedMapsLootTables.push(m);
        if (hasOwn(ctx[keyMapName], key)) {
          P.push(who + ": duplicate key '" + key + "'");
          continue;
        }
        ctx[keyMapName][key] = sid;
      }
    }
  }

  // Stage one pack's content families. Returns normalized entries per
  // family plus updated staged maps. PURE — throws PackError on problems.
  function stageContent(rec, ctx) {
    const content = rec.content;
    const out = { tiles: [], items: [], enemies: [], recipes: [], walls: [], lootTables: [], spawnRules: [] };
    if (!content) return out;
    const ns = rec.id;
    const P = [];

    // Reserve identities first so intra-pack references resolve below.
    reserveNames(rec, ctx, P);

    // ---- tiles ---------------------------------------------------------
    if (Array.isArray(content.tiles)) {
      for (let i = 0; i < content.tiles.length; i++) {
        const t = content.tiles[i];
        const who = ns + ".tiles[" + i + "]";
        if (!isObj(t)) {
          P.push(who + ": entry must be an object");
          continue;
        }
        for (const k in t) {
          if (
            !{
              key: 1, name: 1, solid: 1, opaque: 1, hardness: 1, tool: 1,
              minPower: 1, drop: 1, light: 1, pattern: 1, colors: 1,
            }[k]
          ) {
            P.push(who + ": unknown field '" + k + "'");
          }
        }
        const key = typeof t.key === "string" ? t.key : snakeCase(t.name);
        const sid = ctx.stagedTileKeys[key]; // reservation owns dup detection
        if (!KEY_RE.test(key || "") || sid == null) {
          continue; // problem already recorded by reserveNames
        }
        const def = {
          name: strBounded(t.name, 64) ? t.name : key,
        };
        def.solid = t.solid === undefined ? true : !!t.solid;
        def.opaque = t.opaque === undefined ? def.solid : !!t.opaque;
        if (!boundedNum(t.hardness == null ? 0.5 : t.hardness, 0, 10)) {
          P.push(who + ": hardness must be a number within 0..10");
          continue;
        }
        def.hardness = t.hardness == null ? 0.5 : t.hardness;
        if (t.tool != null) {
          if (typeof t.tool !== "string" || !TOOL_KINDS[t.tool]) {
            P.push(who + ": tool must be one of pick|axe|any");
            continue;
          }
          def.tool = t.tool;
        } else def.tool = "pick";
        if (!boundedNum(t.minPower == null ? 0 : t.minPower, 0, 1000)) {
          P.push(who + ": minPower must be a number within 0..1000");
          continue;
        }
        def.minPower = t.minPower || 0;
        if (!boundedNum(t.light == null ? 0 : t.light, 0, 1)) {
          P.push(who + ": light must be a number within 0..1");
          continue;
        }
        def.light = t.light || 0;
        if (t.drop != null) {
          const dropId = needRef(ctx.resolveItem, "item", t.drop, who, "drop", P);
          if (dropId == null) continue;
          def.drop = t.drop; // consumers resolve through the same union
        }
        const pattern = t.pattern == null ? "speckle" : t.pattern;
        if (typeof pattern !== "string" || !SAFE_TILE_PATTERNS[pattern]) {
          P.push(who + ": pattern must be an inert built-in painter (" +
            Object.keys(SAFE_TILE_PATTERNS).join("|") + ")");
          continue;
        }
        def.pattern = pattern;
        const colors = t.colors;
        if (
          !Array.isArray(colors) ||
          colors.length < 1 ||
          colors.length > 4 ||
          colors.some((c) => typeof c !== "string" || !COLOR_RE.test(c))
        ) {
          P.push(who + ": colors must be 1..4 '#rrggbb' strings");
          continue;
        }
        def.colors = colors.slice();
        out.tiles.push({ key: key, sid: sid, def: def });
        ctx.stagedTiles[sid] = sid;
        ctx.stagedTileKeys[key] = sid;
      }
      // Make this pack's tiles visible to its OWN later families and to
      // later packs (resolvers read these maps live).
      for (const e of out.tiles) ctx.stagedMapsTiles.push({ [e.sid]: e.sid });
    }

    // ---- items ----------------------------------------------------------
    if (Array.isArray(content.items)) {
      for (let i = 0; i < content.items.length; i++) {
        const it = content.items[i];
        const who = ns + ".items[" + i + "]";
        if (!isObj(it)) {
          P.push(who + ": entry must be an object");
          continue;
        }
        for (const k in it) {
          if (
            !{
              key: 1, name: 1, kind: 1, tile: 1, wall: 1, damage: 1, knockback: 1,
              useTime: 1, value: 1, maxStack: 1, boss: 1, summon: 1,
              pickPower: 1,
            }[k]
          ) {
            P.push(who + ": unknown field '" + k + "'");
          }
        }
        const key = it.key;
        const sid = ctx.stagedItemKeys[key]; // reservation owns dup detection
        if (typeof key !== "string" || !KEY_RE.test(key) || sid == null) {
          continue; // problem already recorded by reserveNames
        }
        const kind = it.kind;
        if (kind !== "material" && kind !== "block" && kind !== "weapon" && kind !== "summon") {
          P.push(who + ": kind must be material|block|weapon|summon");
          continue;
        }
        const def = {
          name: strBounded(it.name, 64) ? it.name : key,
          kind: kind,
        };
        def.maxStack = kind === "material" || kind === "block" ? 999 : 1;
        if (it.maxStack !== undefined) {
          if (!boundedInt(it.maxStack, 1, 999)) {
            P.push(who + ": maxStack must be an integer within 1..999");
            continue;
          }
          if (kind === "weapon" || kind === "summon") {
            P.push(who + ": " + kind + " items are single-stack");
            continue;
          }
          def.maxStack = it.maxStack;
        }
        if (it.value !== undefined) {
          if (!boundedInt(it.value, 0, 1000000)) {
            P.push(who + ": value must be an integer within 0..1000000");
            continue;
          }
          def.value = it.value;
        }
        const hasTileRef = it.tile != null;
        const hasWallRef = it.wall != null;
        if (kind === "block") {
          if (!hasTileRef && !hasWallRef) {
            P.push(who + ": block items must reference a tile or wall");
            continue;
          }
          // Numeric world id is attached at COMMIT time (pack tile/wall
          // indices exist only once the dense tables grow); keep the
          // validated ref until then.
          if (hasTileRef) {
            const tsid = needRef(ctx.resolveTile, "tile", it.tile, who, "tile", P);
            if (tsid == null) continue;
            def._tileRef = it.tile;
          }
          if (hasWallRef) {
            const wsid = needRef(ctx.resolveWall, "wall", it.wall, who, "wall", P);
            if (wsid == null) continue;
            def._wallRef = it.wall;
          }
        } else if (hasWallRef) {
          P.push(who + ": 'wall' reference requires kind 'block'");
          continue;
        }
        if (kind === "weapon") {
          if (!boundedNum(it.damage == null ? 0 : it.damage, 1, 500)) {
            P.push(who + ": weapon damage must be a number within 1..500");
            continue;
          }
          def.damage = it.damage;
          if (it.knockback !== undefined) {
            if (!boundedNum(it.knockback, 0, 20)) {
              P.push(who + ": knockback must be a number within 0..20");
              continue;
            }
            def.knockback = it.knockback;
          }
          if (it.useTime !== undefined) {
            if (!boundedNum(it.useTime, 0.05, 2)) {
              P.push(who + ": useTime must be a number within 0.05..2 seconds");
              continue;
            }
            def.useTime = it.useTime;
          }
        }
        if (kind === "summon") {
          if (it.boss == null) {
            P.push(who + ": summon items must reference a boss/enemy");
            continue;
          }
          const eid = needRef(ctx.resolveEnemy, "enemy", it.boss, who, "boss", P);
          if (eid == null) continue;
          // Target-def policy checks are DEFERRED until every family of
          // every pack is staged (intra-pack forward references are legal:
          // a summon may target an enemy declared later in the same file).
          ctx.pendingSummonChecks.push({ sid: eid, who: who });
          def.boss = it.boss;
          const sm = it.summon;
          if (sm !== undefined && !isObj(sm)) {
            P.push(who + ": summon must be an object");
            continue;
          }
          if (sm) {
            for (const k in sm) {
              if (!{ time: 1, biome: 1, requires: 1, placement: 1 }[k]) {
                P.push(who + ": unknown summon field '" + k + "'");
              }
            }
            if (sm.time !== undefined) {
              if (!SUMMON_TIMES[sm.time]) {
                P.push(who + ": summon.time must be any|day|night");
                continue;
              }
            }
            def.summon = {
              time: sm.time || "any",
              biome: sm.biome == null ? null : sm.biome,
              requires: sm.requires == null ? null : sm.requires,
              placement: sm.placement == null ? null : sm.placement,
            };
          } else {
            def.summon = { time: "any", biome: null, requires: null, placement: null };
          }
        }
        out.items.push({ key: key, sid: sid, def: def });
        ctx.stagedItems[sid] = sid;
        ctx.stagedItemKeys[key] = sid;
      }
      for (const e of out.items) {
        const m = {};
        m[e.sid] = e.sid;
        m[e.key] = e.sid;
        ctx.stagedMapsItems.push(m);
      }
    }

    // ---- enemies ---------------------------------------------------------
    if (Array.isArray(content.enemies)) {
      for (let i = 0; i < content.enemies.length; i++) {
        const en = content.enemies[i];
        const who = ns + ".enemies[" + i + "]";
        if (!isObj(en)) {
          P.push(who + ": entry must be an object");
          continue;
        }
        for (const k in en) {
          if (
            !{
              key: 1, name: 1, hp: 1, dmg: 1, kbResist: 1, ai: 1, w: 1, h: 1,
              color: 1, speed: 1, jumpVel: 1, look: 1, defense: 1, drops: 1,
              coins: 1, boss: 1, lootTable: 1,
            }[k]
          ) {
            P.push(who + ": unknown field '" + k + "'");
          }
        }
        const key = en.key;
        const sid = ctx.stagedEnemyKeys[key]; // reservation owns dup detection
        if (typeof key !== "string" || !KEY_RE.test(key) || sid == null) {
          continue; // problem already recorded by reserveNames
        }
        if (!boundedNum(en.hp == null ? 0 : en.hp, 1, 1000000)) {
          P.push(who + ": hp must be a number within 1..1000000");
          continue;
        }
        if (!boundedNum(en.dmg == null ? 0 : en.dmg, 0, 10000)) {
          P.push(who + ": dmg must be a number within 0..10000");
          continue;
        }
        const aiName = en.ai;
        if (typeof aiName !== "string" || !aiName.length || aiName.length > 32) {
          P.push(who + ": ai must name a built-in behavior");
          continue;
        }
        if (BOSS_AI[aiName]) {
          P.push(who + ": ai '" + aiName + "' is boss machinery (not pack-extensible)");
          continue;
        }
        if (!TC.EnemyAI || typeof TC.EnemyAI.get !== "function" || !TC.EnemyAI.get(aiName)) {
          P.push(who + ": ai '" + aiName + "' is not a registered built-in behavior");
          continue;
        }
        if (en.look != null) {
          const KNOWN_LOOKS = {
            skeleton: 1, golem: 1, charger: 1, wolf: 1, stalker: 1, sporeling: 1,
          };
          if (typeof en.look !== "string" || !KNOWN_LOOKS[en.look]) {
            P.push(who + ": look '" + en.look + "' is not a built-in renderer look");
            continue;
          }
        }
        if (
          en.color != null &&
          (typeof en.color !== "string" || !COLOR_RE.test(en.color))
        ) {
          P.push(who + ": color must be '#rrggbb'");
          continue;
        }
        const def = {
          name: strBounded(en.name, 64) ? en.name : key,
          hp: en.hp,
          dmg: en.dmg,
          ai: aiName,
          w: boundedInt(en.w == null ? 24 : en.w, 8, 256) ? (en.w == null ? 24 : en.w) : null,
          h: boundedInt(en.h == null ? 24 : en.h, 8, 256) ? (en.h == null ? 24 : en.h) : null,
        };
        if (def.w == null || def.h == null) {
          P.push(who + ": w/h must be integers within 8..256");
          continue;
        }
        if (en.kbResist !== undefined) {
          if (!boundedNum(en.kbResist, 0, 1)) {
            P.push(who + ": kbResist must be a number within 0..1");
            continue;
          }
          def.kbResist = en.kbResist;
        }
        if (en.speed !== undefined) {
          if (!boundedNum(en.speed, 0, 1000)) {
            P.push(who + ": speed must be a number within 0..1000");
            continue;
          }
          def.speed = en.speed;
        }
        if (en.jumpVel !== undefined) {
          if (!boundedNum(en.jumpVel, 0, 1500)) {
            P.push(who + ": jumpVel must be a number within 0..1500");
            continue;
          }
          def.jumpVel = en.jumpVel;
        }
        if (en.defense !== undefined) {
          if (!boundedInt(en.defense, 0, 100)) {
            P.push(who + ": defense must be an integer within 0..100");
            continue;
          }
          def.defense = en.defense;
        }
        if (en.color != null) def.color = en.color;
        if (en.look != null) def.look = en.look;
        // Optional mini-boss declaration: routes the enemy through the
        // EXISTING boss encounter machinery (health bar, MAX_BOSSES cap,
        // summon path) without exposing any encounter lifecycle control.
        if (en.boss !== undefined) {
          if (typeof en.boss !== "boolean") {
            P.push(who + ": boss must be a boolean");
            continue;
          }
          def.boss = en.boss;
        }
        if (en.lootTable != null) {
          const lsid = needRef(ctx.resolveLootTable, "lootTable", en.lootTable, who, "lootTable", P);
          if (lsid == null) continue;
          def.lootTable = en.lootTable;
        }
        if (en.drops !== undefined) {
          if (!Array.isArray(en.drops) || en.drops.length > 16) {
            P.push(who + ": drops must be an array of at most 16 entries");
            continue;
          }
          let ok = true;
          const drops = [];
          for (let d = 0; d < en.drops.length; d++) {
            const dr = en.drops[d];
            const dwho = who + ".drops[" + d + "]";
            if (!isObj(dr)) {
              P.push(dwho + ": must be an object");
              ok = false;
              break;
            }
            for (const k in dr) {
              if (!{ id: 1, min: 1, max: 1, chance: 1 }[k]) {
                P.push(dwho + ": unknown field '" + k + "'");
              }
            }
            const iid = needRef(ctx.resolveItem, "item", dr.id, dwho, "id", P);
            if (iid == null) {
              ok = false;
              break;
            }
            const mn = dr.min == null ? 1 : dr.min;
            const mx = dr.max == null ? mn : dr.max;
            if (!boundedInt(mn, 0, 999) || !boundedInt(mx, 0, 999) || mx < mn) {
              P.push(dwho + ": min/max must be integers 0..999 with max >= min");
              ok = false;
              break;
            }
            const ch = dr.chance == null ? 1 : dr.chance;
            if (!boundedNum(ch, 0.0001, 1)) {
              P.push(dwho + ": chance must be a number within (0, 1]");
              ok = false;
              break;
            }
            drops.push({ id: dr.id, min: mn, max: mx, chance: ch });
          }
          if (!ok) continue;
          def.drops = drops;
        }
        if (en.coins !== undefined) {
          if (
            !Array.isArray(en.coins) ||
            en.coins.length !== 2 ||
            !boundedInt(en.coins[0], 0, 1000000) ||
            !boundedInt(en.coins[1], 0, 1000000) ||
            en.coins[0] > en.coins[1]
          ) {
            P.push(who + ": coins must be [min, max] integers 0..1000000, min <= max");
            continue;
          }
          def.coins = en.coins.slice();
        }
        out.enemies.push({ key: key, sid: sid, def: def });
        ctx.stagedEnemies[sid] = sid;
        ctx.stagedEnemyKeys[key] = sid;
        if (!ctx.stagedEnemyDefs) ctx.stagedEnemyDefs = {};
        ctx.stagedEnemyDefs[sid] = def;
      }
      for (const e of out.enemies) {
        const m = {};
        m[e.sid] = e.sid;
        m[e.key] = e.sid;
        ctx.stagedMapsEnemies.push(m);
      }
    }

    // ---- walls (append-only dense background defs) -------------------
    if (Array.isArray(content.walls)) {
      for (let i = 0; i < content.walls.length; i++) {
        const wl = content.walls[i];
        const who = ns + ".walls[" + i + "]";
        if (!isObj(wl)) {
          P.push(who + ": entry must be an object");
          continue;
        }
        for (const k in wl) {
          if (!{ key: 1, name: 1, color: 1, hardness: 1, drop: 1 }[k]) {
            P.push(who + ": unknown field '" + k + "'");
          }
        }
        const key = typeof wl.key === "string" ? wl.key : snakeCase(wl.name);
        const sid = ctx.stagedWallKeys[key];
        if (!KEY_RE.test(key || "") || sid == null) {
          continue;
        }
        const def = {};
        if (!strBounded(wl.name, 64)) {
          P.push(who + ": name must be a string of 1..64 chars");
          continue;
        }
        def.name = wl.name;
        if (typeof wl.color !== "string" || !COLOR_RE.test(wl.color)) {
          P.push(who + ": color must be a '#rrggbb' string");
          continue;
        }
        def.color = wl.color;
        if (!boundedNum(wl.hardness == null ? 0.5 : wl.hardness, 0, 10)) {
          P.push(who + ": hardness must be a number within 0..10");
          continue;
        }
        def.hardness = wl.hardness == null ? 0.5 : wl.hardness;
        if (wl.drop != null) {
          const dropId = needRef(ctx.resolveItem, "item", wl.drop, who, "drop", P);
          if (dropId == null) continue;
          def.drop = wl.drop;
        }
        out.walls.push({ key: key, sid: sid, def: def });
        ctx.stagedWalls[sid] = sid;
        ctx.stagedWallKeys[key] = sid;
      }
    }

    // ---- standalone loot tables ----------------------------------------
    if (Array.isArray(content.lootTables)) {
      for (let i = 0; i < content.lootTables.length; i++) {
        const lt = content.lootTables[i];
        const who = ns + ".lootTables[" + i + "]";
        if (!isObj(lt)) {
          P.push(who + ": entry must be an object");
          continue;
        }
        for (const k in lt) {
          if (!{ key: 1, name: 1, entries: 1 }[k]) {
            P.push(who + ": unknown field '" + k + "'");
          }
        }
        const key = typeof lt.key === "string" ? lt.key : snakeCase(lt.name);
        const sid = ctx.stagedLootTableKeys[key];
        if (!KEY_RE.test(key || "") || sid == null) {
          continue;
        }
        if (!strBounded(lt.name || "", 64)) {
          P.push(who + ": name must be a string of 1..64 chars");
          continue;
        }
        if (!Array.isArray(lt.entries) || lt.entries.length > 64) {
          P.push(who + ": entries must be an array of at most 64");
          continue;
        }
        const entries = [];
        let ok = true;
        for (let e = 0; e < lt.entries.length; e++) {
          const en = lt.entries[e];
          const ewho = who + ".entries[" + e + "]";
          if (!isObj(en)) {
            P.push(ewho + ": must be an object");
            ok = false;
            break;
          }
          for (const k in en) {
            if (!{ id: 1, min: 1, max: 1, chance: 1, requires: 1 }[k]) {
              P.push(ewho + ": unknown field '" + k + "'");
            }
          }
          const iid = needRef(ctx.resolveItem, "item", en.id, ewho, "id", P);
          if (iid == null) { ok = false; break; }
          const mn = en.min == null ? 1 : en.min;
          const mx = en.max == null ? mn : en.max;
          if (!boundedInt(mn, 0, 999) || !boundedInt(mx, 0, 999) || mx < mn) {
            P.push(ewho + ": min/max must be integers 0..999 with max >= min");
            ok = false;
            break;
          }
          const ch = en.chance == null ? 1 : en.chance;
          if (!boundedNum(ch, 0.0001, 1)) {
            P.push(ewho + ": chance must be a number within (0, 1]");
            ok = false;
            break;
          }
          if (en.requires != null && !validConditionShape(en.requires, ewho + ".requires", P)) {
            ok = false;
            break;
          }
          entries.push({
            id: en.id,
            min: mn,
            max: mx,
            chance: ch,
            requires: en.requires == null ? null : en.requires,
          });
        }
        if (!ok) continue;
        out.lootTables.push({
          key: key,
          sid: sid,
          def: { name: lt.name || key, entries: entries },
        });
        ctx.stagedLootTables[sid] = sid;
        ctx.stagedLootTableKeys[key] = sid;
        ctx.stagedMapsLootTables.push({ [sid]: sid, [key]: sid });
      }
    }

    // ---- spawn rules (pack natural spawn) -----------------------------
    if (Array.isArray(content.spawnRules)) {
      const ALLOWED_ZONES = { day: 1, night: 1, cave: 1, underworld: 1 };
      const ALLOWED_BIOMES = { forest: 1, desert: 1, snow: 1, jungle: 1, ocean: 1, corruption: 1 };
      const ALLOWED_TIMES = { day: 1, night: 1 };
      if (content.spawnRules.length > 64) P.push(ns + ".spawnRules: exceeds 64 entries");
      else for (let i = 0; i < content.spawnRules.length; i++) {
        const sr = content.spawnRules[i];
        const who = ns + ".spawnRules[" + i + "]";
        if (!isObj(sr)) { P.push(who + ": entry must be an object"); continue; }
        for (const k in sr) {
          if (!{ enemy: 1, zone: 1, weight: 1, biome: 1, depthMin: 1, depthMax: 1, time: 1, requires: 1 }[k]) {
            P.push(who + ": unknown field '" + k + "'");
          }
        }
        if (sr.enemy == null) { P.push(who + ": enemy required"); continue; }
        const eid = needRef(ctx.resolveEnemy, "enemy", sr.enemy, who, "enemy", P);
        if (eid == null) continue;
        // Boss check: must not reference boss machinery
        let edef = null;
        if (TC.Registry && TC.Registry.get) edef = TC.Registry.get("enemy", eid);
        if (!edef && ctx.stagedEnemyDefs) edef = ctx.stagedEnemyDefs[eid] || null;
        if (edef && edef.boss === true) { P.push(who + ": enemy '" + eid + "' is boss machinery (not spawnable)"); continue; }
        if (edef && edef.ai && BOSS_AI[edef.ai]) { P.push(who + ": enemy '" + eid + "' uses boss AI '" + edef.ai + "'"); continue; }
        const enemyPack = eid.indexOf(':') >= 0 ? eid.split(':')[0] : 'core';
        if (enemyPack !== ns && enemyPack !== 'core' && !rec.deps[enemyPack] && !(rec.optionalDeps && rec.optionalDeps[enemyPack])) {
          P.push(who + ": enemy '" + eid + "' cross-pack reference requires declared dependency");
          continue;
        }
        if (typeof sr.zone !== "string" || !ALLOWED_ZONES[sr.zone]) { P.push(who + ": zone must be one of day|night|cave|underworld"); continue; }
        if (!boundedNum(sr.weight, 0.01, 10)) { P.push(who + ": weight must be a number within 0.01..10"); continue; }
        if (sr.biome != null && (typeof sr.biome !== "string" || !ALLOWED_BIOMES[sr.biome])) { P.push(who + ": biome must be one of forest|desert|snow|jungle|ocean|corruption"); continue; }
        if (sr.depthMin != null && !boundedNum(sr.depthMin, 0, 500)) { P.push(who + ": depthMin must be a number within 0..500"); continue; }
        if (sr.depthMax != null && !boundedNum(sr.depthMax, 0, 500)) { P.push(who + ": depthMax must be a number within 0..500"); continue; }
        if (sr.depthMin != null && sr.depthMax != null && sr.depthMin > sr.depthMax) { P.push(who + ": depthMin > depthMax"); continue; }
        if (sr.time != null && (typeof sr.time !== "string" || !ALLOWED_TIMES[sr.time])) { P.push(who + ": time must be day|night"); continue; }
        if (sr.requires != null && !validConditionShape(sr.requires, who + ".requires", P)) continue;
        out.spawnRules.push({
          enemy: sr.enemy,
          zone: sr.zone,
          weight: sr.weight,
          biome: sr.biome == null ? null : sr.biome,
          depthMin: sr.depthMin == null ? null : sr.depthMin,
          depthMax: sr.depthMax == null ? null : sr.depthMax,
          time: sr.time == null ? null : sr.time,
          requires: sr.requires == null ? null : sr.requires,
        });
      }
    }

    // ---- recipes (last: may reference everything staged above) ----------
    if (Array.isArray(content.recipes)) {
      for (let i = 0; i < content.recipes.length; i++) {
        const rc = content.recipes[i];
        const who = ns + ".recipes[" + i + "]";
        if (!isObj(rc)) {
          P.push(who + ": entry must be an object");
          continue;
        }
        for (const k in rc) {
          if (!{ rid: 1, out: 1, n: 1, cost: 1, station: 1, requires: 1 }[k]) {
            P.push(who + ": unknown field '" + k + "'");
          }
        }
        const rid = rc.rid;
        if (typeof rid !== "string" || !KEY_RE.test(rid)) {
          P.push(who + ": rid must match [a-z][a-z0-9_]{0,31}");
          continue;
        }
        const sid = ns + ":r_" + rid;
        if (ctx.stagedRecipes[sid]) {
          P.push(who + ": duplicate recipe id '" + sid + "'");
          continue;
        }
        const outRef = rc.out;
        if (outRef == null) {
          P.push(who + ": output item required");
          continue;
        }
        if (needRef(ctx.resolveItem, "item", outRef, who, "out", P) == null) continue;
        const n = rc.n == null ? 1 : rc.n;
        if (!boundedInt(n, 1, 999)) {
          P.push(who + ": yield must be an integer within 1..999");
          continue;
        }
        if (rc.cost == null || !isObj(rc.cost)) {
          P.push(who + ": cost map required");
          continue;
        }
        const costKeys = Object.keys(rc.cost);
        if (costKeys.length < 1 || costKeys.length > 8) {
          P.push(who + ": cost must list 1..8 ingredients");
          continue;
        }
        let ok = true;
        for (const ck of costKeys) {
          if (needRef(ctx.resolveItem, "item", ck, who, "cost ingredient", P) == null) {
            ok = false;
            break;
          }
          if (!boundedInt(rc.cost[ck], 1, 999)) {
            P.push(who + ": cost amount for '" + ck + "' must be an integer within 1..999");
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (rc.station != null) {
          if (
            !TC.Registry ||
            !TC.Registry.has("station", rc.station)
          ) {
            P.push(who + ": station '" + rc.station + "' does not resolve to a registered station");
            continue;
          }
        }
        if (rc.requires != null && !validConditionShape(rc.requires, who + ".requires", P)) continue;
        const def = { out: outRef, n: n, cost: Object.assign({}, rc.cost) };
        if (rc.station != null) def.station = rc.station;
        if (rc.requires != null) def.requires = rc.requires;
        out.recipes.push({ rid: rid, sid: sid, def: def });
        ctx.stagedRecipes[sid] = sid;
      }
    }

    if (P.length) {
      fail(
        "schema",
        "pack '" + rec.id + "': content failed validation",
        P,
      );
    }
    return out;
  }

  // Deferred summon-policy pass: runs once after ALL packs are staged.
  function checkSummons(ctx) {
    const P = [];
    for (const chk of ctx.pendingSummonChecks) {
      let targetDef = TC.Registry ? TC.Registry.get("enemy", chk.sid) : null;
      if (!targetDef && ctx.stagedEnemyDefs) targetDef = ctx.stagedEnemyDefs[chk.sid] || null;
      if (!targetDef) {
        P.push(chk.who + ": summoned enemy '" + chk.sid + "' not resolvable");
        continue;
      }
      if (targetDef.ai && BOSS_AI[targetDef.ai]) {
        P.push(chk.who + ": '" + chk.sid + "' is boss machinery (not pack-summable)");
        continue;
      }
      if (targetDef.boss !== true) {
        P.push(chk.who + ": summoned enemy '" + chk.sid + "' must declare boss: true");
      }
    }
    if (P.length) fail("schema", "summon targets failed validation", P);
  }

  // Structural check of the Progression condition grammar (strings /
  // {all|any|not} compounds). Semantic evaluation stays inside
  // TC.Progression.test which is fail-closed at craft time.
  function validConditionShape(c, who, P) {
    let ok = true;
    function walk(node, depth) {
      if (depth > 6) {
        P.push(who + ": condition nesting deeper than 6");
        ok = false;
        return;
      }
      if (typeof node === "string") {
        if (!node.length || node.length > 96) {
          P.push(who + ": condition flag strings must be 1..96 chars");
          ok = false;
        }
        return;
      }
      if (!isObj(node)) {
        P.push(who + ": condition must be a string or {all|any|not} compound");
        ok = false;
        return;
      }
      const keys = Object.keys(node);
      if (keys.length !== 1) {
        P.push(who + ": condition compound must have exactly one of all/any/not");
        ok = false;
        return;
      }
      const k = keys[0];
      if (k === "not") {
        walk(node[k], depth + 1);
      } else if (k === "all" || k === "any") {
        if (!Array.isArray(node[k]) || node[k].length < 1 || node[k].length > 16) {
          P.push(who + ": " + k + " must list 1..16 sub-conditions");
          ok = false;
          return;
        }
        for (const sub of node[k]) walk(sub, depth + 1);
      } else {
        P.push(who + ": unknown condition operator '" + k + "'");
        ok = false;
      }
    }
    walk(c, 0);
    return ok;
  }

  // ======================================================================
  // Resource-pack staging (locale fragments)
  // ======================================================================

  function stageResources(rec, handles, problems) {
    const res = rec.resources;
    if (!res) return;
    if (res.locale) {
      for (const lid of Object.keys(res.locale).sort()) {
        const frag = res.locale[lid];
        if (!TC.Localization || typeof TC.Localization.extend !== "function") {
          problems.push("localization module unavailable for pack '" + rec.id + "'");
          continue;
        }
        const r = TC.Localization.extend(lid, frag, { source: "pack:" + rec.id });
        if (!r.ok) {
          problems.push(
            "pack '" + rec.id + "': locale fragment '" + lid + "' rejected: " + r.error,
          );
          continue;
        }
        handles.push(r);
      }
    }
  }

  // ======================================================================
  // Activation transaction
  // ======================================================================

  function journalRollback(j) {
    try {
      if (TC.TILE_DEFS && TC.TILE_DEFS.length > j.tileLen) {
        TC.TILE_DEFS.length = j.tileLen;
      }
      if (TC.RECIPES && TC.RECIPES.length > j.recipesLen) {
        TC.RECIPES.length = j.recipesLen;
      }
      if (TC.WALL_DEFS && TC.WALL_DEFS.length > j.wallLen) {
        TC.WALL_DEFS.length = j.wallLen;
      }
      if (j.spawnLen != null) {
        spawnRules.length = j.spawnLen;
        spawnRuleCounter = j.spawnCounter;
      }
      for (const k of j.itemKeys) delete TC.ITEM_DEFS[k];
      for (const k of j.enemyKeys) delete TC.ENEMY_DEFS[k];
      if (TC.Registry && typeof TC.Registry.forgetLast === "function") {
        // Undo defines in reverse; each must currently be the tail entry.
        for (let i = j.regDefs.length - 1; i >= 0; i--) {
          TC.Registry.forgetLast(j.regDefs[i].kind, j.regDefs[i].id);
        }
      }
      for (const h of j.locHandles) {
        if (h && typeof h.undo === "function") h.undo();
      }
      statsCounters.rollbacks++;
    } catch (e) {
      // Rollback itself failed: leave nothing half-done silently.
      lastError = PackError("commit", "rollback after commit failure also failed: " + (e && e.message));
      throw lastError;
    }
  }

  function defineInRegistry(kind, id, def, j) {
    TC.Registry.define(kind, id, def);
    j.regDefs.push({ kind: kind, id: id });
  }

  function commitPack(rec, staged, j, ctx) {
    const ns = rec.id;
    // Tiles: append to the dense table; numeric alias = appended index.
    const tileIndexBySid = {};
    for (const e of staged.tiles) {
      const idx = TC.TILE_DEFS.length;
      TC.TILE_DEFS.push(e.def);
      tileIndexBySid[e.sid] = idx;
      defineInRegistry("tile", e.sid, e.def, j);
      TC.Registry.alias("tile", e.sid, idx);
    }
    // Items: string-keyed table + aliasKey so bare keys resolve to the pack id.
    for (const e of staged.items) {
      TC.ITEM_DEFS[e.key] = e.def;
      j.itemKeys.push(e.key);
      defineInRegistry("item", e.sid, e.def, j);
      TC.Registry.aliasKey("item", e.sid, e.key);
    }
    // Enemies: same treatment as items.
    for (const e of staged.enemies) {
      TC.ENEMY_DEFS[e.key] = e.def;
      j.enemyKeys.push(e.key);
      defineInRegistry("enemy", e.sid, e.def, j);
      TC.Registry.aliasKey("enemy", e.sid, e.key);
    }
    // Recipes: appended to the shared array; explicit stable ids (never the
    // auto-mirror's core-derived ones) + numeric alias for the new index.
    for (const e of staged.recipes) {
      const idx = TC.RECIPES.length;
      TC.RECIPES.push(e.def);
      defineInRegistry("recipe", e.sid, e.def, j);
      TC.Registry.alias("recipe", e.sid, idx);
    }
    // Walls: append to the dense WALL_DEFS table; numeric alias = appended
    // index. No <kind>:enum extension is needed — the runtime reads the bare
    // numeric index exactly like built-in walls.
    const wallIndexBySid = {};
    for (const e of staged.walls) {
      if (!TC.WALL_DEFS) fail("commit", "WALL_DEFS unavailable for wall commit");
      const idx = TC.WALL_DEFS.length;
      TC.WALL_DEFS.push(e.def);
      wallIndexBySid[e.sid] = idx;
      defineInRegistry("wall", e.sid, e.def, j);
      TC.Registry.alias("wall", e.sid, idx);
    }
    // Loot tables: registered as stable identities only (no dense world id).
    for (const e of staged.lootTables) {
      defineInRegistry("lootTable", e.sid, e.def, j);
    }
    // Spawn rules: compiled into global deterministic index (no registry).
    for (const r of staged.spawnRules) {
      const sid = resolveStable("enemy", r.enemy, ctx);
      const canon = sid != null ? canonicalRef("enemy", sid, ctx) : r.enemy;
      const compiled = {
        pack: ns,
        enemy: canon,
        stableEnemy: sid || r.enemy,
        zone: r.zone,
        weight: r.weight,
        biome: r.biome,
        depthMin: r.depthMin,
        depthMax: r.depthMax,
        time: r.time,
        requires: r.requires,
        order: spawnRuleCounter++,
      };
      spawnRules.push(compiled);
    }

    // ---- reference normalization (canonical RUNTIME forms) ------------
    // Hot paths index tables by BARE key and worlds by NUMERIC tile ids, so
    // every stored reference is rewritten from whatever form the manifest
    // used to exactly those forms. Validation already proved resolvability.
    for (const e of staged.tiles) {
      if (e.def.drop != null) {
        const sid = resolveStable("item", e.def.drop, ctx);
        if (sid != null) e.def.drop = canonicalRef("item", sid, ctx);
      }
    }
    for (const e of staged.items) {
      if (e.def._tileRef != null) {
        const sid = resolveStable("tile", e.def._tileRef, ctx);
        let num = sid != null ? tileIndexBySid[sid] : undefined;
        if (num == null && sid != null && TC.Registry) {
          num = TC.Registry.stableToIndex("tile", sid);
        }
        if (num == null || num < 0) {
          throw PackError("commit", "tile index vanished during commit for '" + e.sid + "'");
        }
        e.def.tile = num;
        delete e.def._tileRef;
      }
      if (e.def._wallRef != null) {
        const sid = resolveStable("wall", e.def._wallRef, ctx);
        let num = sid != null ? wallIndexBySid[sid] : undefined;
        if (num == null && sid != null && TC.Registry) {
          num = TC.Registry.stableToIndex("wall", sid);
        }
        if (num == null || num < 0) {
          throw PackError("commit", "wall index vanished during commit for '" + e.sid + "'");
        }
        e.def.wall = num;
        delete e.def._wallRef;
      }
      if (e.def.boss != null) {
        const sid = resolveStable("enemy", e.def.boss, ctx);
        if (sid != null) e.def.boss = canonicalRef("enemy", sid, ctx);
      }
    }
    for (const e of staged.enemies) {
      if (e.def.drops) {
        for (const d of e.def.drops) {
          const sid = resolveStable("item", d.id, ctx);
          if (sid != null) d.id = canonicalRef("item", sid, ctx);
        }
      }
      if (e.def.lootTable != null) {
        const sid = resolveStable("lootTable", e.def.lootTable, ctx);
        if (sid != null) e.def.lootTable = canonicalRef("lootTable", sid, ctx);
      }
    }
    for (const e of staged.walls) {
      if (e.def.drop != null) {
        const sid = resolveStable("item", e.def.drop, ctx);
        if (sid != null) e.def.drop = canonicalRef("item", sid, ctx);
      }
    }
    for (const e of staged.lootTables) {
      for (const d of e.def.entries) {
        const sid = resolveStable("item", d.id, ctx);
        if (sid != null) d.id = canonicalRef("item", sid, ctx);
      }
    }
    for (const e of staged.recipes) {
      const outSid = resolveStable("item", e.def.out, ctx);
      if (outSid != null) e.def.out = canonicalRef("item", outSid, ctx);
      if (e.def.cost) {
        const cost = {};
        for (const k of Object.keys(e.def.cost)) {
          const sid = resolveStable("item", k, ctx);
          const key = sid != null ? canonicalRef("item", sid, ctx) : k;
          cost[key] = e.def.cost[k];
        }
        e.def.cost = cost;
      }
    }
    statsCounters.committedEntries +=
      staged.tiles.length + staged.items.length + staged.enemies.length +
      staged.recipes.length + staged.walls.length + staged.lootTables.length +
      staged.spawnRules.length;
  }

  // Resolve any validated ref form to its stable id using the SAME union
  // (registry + staged maps) the staging validator used.
  function resolveStable(kind, ref, ctx) {
    if (ref == null) return null;
    const maps = kind === "item" ? ctx.stagedMapsItems
      : kind === "enemy" ? ctx.stagedMapsEnemies
      : kind === "tile" ? ctx.stagedMapsTiles
      : kind === "wall" ? ctx.stagedMapsWalls
      : kind === "lootTable" ? ctx.stagedMapsLootTables : [];
    const r = makeResolver(kind, maps)(ref, kind);
    return r && !r.ambiguous ? r : null;
  }

  // Canonical runtime form of a stable id: the registry's first legacy key
  // when one exists (bare table keys are what hot paths read), else the id.
  function canonicalRef(kind, sid, ctx) {
    if (TC.Registry && typeof TC.Registry.keyOf === "function") {
      const k = TC.Registry.keyOf(kind, sid);
      if (k != null) return k;
    }
    return sid;
  }

  // Full transaction: requested ids -> resolved order -> staged & validated
  // content -> single atomic commit. Throws PackError leaving ZERO mutation.
  function setActive(requested, opts) {
    opts = opts || {};
    const req = Array.isArray(requested) ? requested.slice() : [];
    const seen = new Set();
    for (const id of req) {
      if (seen.has(id)) {
        lastError = PackError("duplicate", "duplicate pack id in activation request: '" + id + "'");
        throw lastError;
      }
      seen.add(id);
    }
    if (req.length > MAX_PACKS_ACTIVE) {
      lastError = PackError("schema", "too many active packs (max " + MAX_PACKS_ACTIVE + ")");
      throw lastError;
    }

    statsCounters.attempts++;
    let ordered;
    try {
      ordered = resolveOrder(req);
    } catch (e) {
      statsCounters.failed++;
      lastError = e;
      throw e;
    }
    if (ordered.length > MAX_PACKS_ACTIVE) {
      statsCounters.failed++;
      lastError = PackError("schema", "dependency closure exceeds " + MAX_PACKS_ACTIVE + " active packs");
      throw lastError;
    }

    // Session permanence: committed pack content extends dense tables that
    // saves and hot paths index into — it cannot be withdrawn without
    // shifting identities. A request therefore must KEEP every committed
    // pack (same content digest), and may only ADD new ones.
    for (const id of Array.from(committed.keys()).sort()) {
      if (ordered.indexOf(id) < 0) {
        statsCounters.failed++;
        lastError = PackError(
          "commit",
          "pack '" + id + "' is already live this session and cannot be dropped; " +
            "changing the set requires a fresh session",
        );
        throw lastError;
      }
    }

    // Fast path: identical active set -> no-op.
    if (
      opts.force !== true &&
      ordered.length === activeList.length &&
      ordered.every((id, i) => activeList[i] === id)
    ) {
      return { activated: activeList.slice(), changed: false };
    }

    // ---- STAGE ONLY THE NOT-YET-COMMITTED PACKS -------------------------
    const ctx = {
      stagedTiles: {},
      stagedTileKeys: {},
      stagedItems: {},
      stagedItemKeys: {},
      stagedEnemies: {},
      stagedEnemyKeys: {},
      stagedRecipes: {},
      stagedWalls: {},
      stagedWallKeys: {},
      stagedLootTables: {},
      stagedLootTableKeys: {},
      stagedMapsItems: [],
      stagedMapsEnemies: [],
      stagedMapsTiles: [],
      stagedMapsWalls: [],
      stagedMapsLootTables: [],
      stagedEnemyDefs: {},
      pendingSummonChecks: [],
    };
    ctx.resolveItem = makeResolver("item", ctx.stagedMapsItems);
    ctx.resolveEnemy = makeResolver("enemy", ctx.stagedMapsEnemies);
    ctx.resolveTile = makeResolver("tile", ctx.stagedMapsTiles);
    ctx.resolveWall = makeResolver("wall", ctx.stagedMapsWalls);
    ctx.resolveLootTable = makeResolver("lootTable", ctx.stagedMapsLootTables);

    const stagedByPack = [];
    try {
      for (const id of ordered) {
        const rec = provided.get(id);
        const prevDigest = committed.get(id);
        if (prevDigest != null) {
          if (prevDigest !== rec.rawDigest) {
            fail(
              "duplicate",
              "pack '" + id + "' is already live with different content; " +
                "re-providing changed data requires a fresh session",
            );
          }
          continue; // idempotent: identical content already committed
        }
        const st = stageContent(rec, ctx);
        stagedByPack.push({ rec: rec, staged: st });
      }
    } catch (e) {
      statsCounters.failed++;
      lastError = e;
      throw e;
    }

    // Cross-family/cross-pack policy checks now that every def exists.
    try {
      checkSummons(ctx);
    } catch (e) {
      statsCounters.failed++;
      lastError = e;
      throw e;
    }

    // Duplicate keys against the LIVE tables too (a pack key colliding with
    // a built-in ITEM_DEFS key would shadow built-in content).
    const dupProblems = [];
    for (const { rec, staged } of stagedByPack) {
      for (const e of staged.items) {
        if (hasOwn(TC.ITEM_DEFS, e.key)) {
          dupProblems.push("item key '" + e.key + "' collides with built-in content");
        }
      }
      for (const e of staged.enemies) {
        if (hasOwn(TC.ENEMY_DEFS, e.key)) {
          dupProblems.push("enemy key '" + e.key + "' collides with built-in content");
        }
      }
    }
    if (dupProblems.length) {
      statsCounters.failed++;
      lastError = PackError("duplicate", "pack content collides with built-in tables", dupProblems);
      throw lastError;
    }

    // ---- COMMIT (journaled, atomic by construction + compensable) --------
    const j = {
      tileLen: TC.TILE_DEFS ? TC.TILE_DEFS.length : 0,
      recipesLen: TC.RECIPES ? TC.RECIPES.length : 0,
      wallLen: TC.WALL_DEFS ? TC.WALL_DEFS.length : 0,
      spawnLen: spawnRules.length,
      spawnCounter: spawnRuleCounter,
      itemKeys: [],
      enemyKeys: [],
      regDefs: [],
      locHandles: [],
    };
    try {
      for (const { rec, staged } of stagedByPack) {
        commitPack(rec, staged, j, ctx);
        committed.set(rec.id, rec.rawDigest);
      }
      // Resource fragments apply after content so display data never gates
      // gameplay registration. Idempotent packs re-layer harmlessly (undo
      // handles only exist for THIS transaction).
      const resProblems = [];
      for (const { rec } of stagedByPack) stageResources(rec, j.locHandles, resProblems);
      if (resProblems.length) {
        fail("schema", "resource fragment application failed", resProblems);
      }
      // Final coherence gate: the full registry (built-ins + packs) must
      // validate together, exactly like production boot does.
      if (TC.Registry && typeof TC.Registry.validate === "function") {
        try {
          TC.Registry.validate();
        } catch (e) {
          fail("commit", "registry validation failed after commit: " + (e && e.message));
        }
      }
    } catch (e) {
      journalRollback(j);
      for (const { rec } of stagedByPack) committed.delete(rec.id);
      statsCounters.failed++;
      lastError = e;
      throw e;
    }

    activeList = ordered;
    activeRecords = ordered.map((id) => provided.get(id));
    statsCounters.ok++;

    if (opts.persist !== false && TC.Settings) {
      try {
        TC.Settings.set("activePacks", activeList.slice());
      } catch (e) { /* persistence is best-effort */ }
    }
    if (TC.Events && TC.Events.EVENT && TC.Events.EVENT.PacksChanged) {
      try {
        TC.Events.emit(TC.Events.EVENT.PacksChanged, {
          activated: activeList.slice(),
          digest: digest(),
        });
      } catch (e) { /* observability only */ }
    }
    lastError = null;
    return { activated: activeList.slice(), changed: true };
  }

  function deactivateAll(opts) {
    return setActive([], opts);
  }

  function active() {
    return activeList.slice();
  }

  function isActive(id) {
    return activeList.indexOf(id) >= 0;
  }

  // ======================================================================
  // Identity digests + save metadata (MOD-003)
  // ======================================================================

  // Gameplay-affecting pack-set fingerprint: sorted 'id@version@digest'
  // lines over DATA packs only. Resource packs NEVER change it, so two
  // peers differing only in presentation packs stay multiplayer-compatible.
  function digest() {
    const lines = [];
    for (const r of activeRecords) {
      if (r.type !== "data") continue;
      lines.push(r.id + "@" + r.version + "@" + r.rawDigest);
    }
    if (!lines.length) return "";
    lines.sort();
    return fnv1a(lines.join("\n")).toString(16);
  }

  function contentDigest() {
    const lines = [];
    for (const r of activeRecords) {
      lines.push(r.id + "@" + r.version + "@" + r.type + "@" + r.rawDigest);
    }
    if (!lines.length) return "";
    lines.sort();
    return fnv1a(lines.join("\n")).toString(16);
  }

  // Envelope metadata payload; null when no packs are active (pre-W25
  // saves carry no such field and remain trivially compatible).
  function saveMetadata() {
    if (!activeRecords.length) return null;
    return {
      v: 1,
      fp: contentDigest(),
      gfp: digest(),
      packs: activeRecords.map((r) => ({
        id: r.id,
        version: r.version,
        type: r.type,
      })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
  }

  // Classify a saved pack metadata blob against the CURRENTLY ACTIVE set.
  // Runs BEFORE any world state is touched on load. Never throws.
  function classifySave(meta) {
    const problems = [];
    const warnings = [];
    if (meta == null) {
      // Pre-W25 / packless save.
      const extras = activeRecords.filter((r) => r.type === "data");
      if (extras.length) {
        warnings.push(
          "save was created without packs; active data packs: " +
            extras.map((r) => r.id).join(", "),
        );
      }
      return { ok: true, status: "legacy-no-packs", problems, warnings };
    }
    if (
      !isObj(meta) ||
      meta.v !== 1 ||
      typeof meta.fp !== "string" ||
      typeof meta.gfp !== "string" ||
      !Array.isArray(meta.packs)
    ) {
      return {
        ok: false,
        status: "malformed-metadata",
        problems: ["save pack metadata is malformed"],
        warnings,
      };
    }
    if (meta.packs.length > MAX_PACKS_ACTIVE) {
      return {
        ok: false,
        status: "malformed-metadata",
        problems: ["save pack metadata lists too many packs"],
        warnings,
      };
    }
    const activeById = new Map();
    for (const r of activeRecords) activeById.set(r.id, r);
    const seenIds = new Set();
    for (const p of meta.packs) {
      if (!isObj(p) || typeof p.id !== "string" || typeof p.version !== "string") {
        return {
          ok: false,
          status: "malformed-metadata",
          problems: ["save pack metadata contains a malformed entry"],
          warnings,
        };
      }
      if (seenIds.has(p.id)) {
        problems.push("duplicate pack id in save metadata: " + p.id);
        continue;
      }
      seenIds.add(p.id);
      const cur = activeById.get(p.id);
      if (!cur) {
        problems.push(
          "missing pack: save requires '" + p.id + "'@" + p.version + ", which is not active",
        );
      } else if (cur.version !== p.version) {
        problems.push(
          "incompatible version: save has '" + p.id + "'@" + p.version +
            " but active version is " + cur.version,
        );
      }
    }
    for (const r of activeRecords) {
      if (!seenIds.has(r.id)) {
        warnings.push("active pack not present in save: " + r.id);
      }
    }
    if (problems.length) {
      return { ok: false, status: "incompatible", problems, warnings };
    }
    return { ok: true, status: "compatible", problems, warnings };
  }

  function stats() {
    return Object.assign({}, statsCounters, {
      providedCount: provided.size,
      activeCount: activeList.length,
      digest: digest(),
      contentDigest: contentDigest(),
    });
  }

  // ======================================================================
  // Boot-time restore helper used by main.js
  // ======================================================================
  // Applies the persisted Settings choice WITHOUT persisting again and
  // converts failures into a recoverable diagnostic instead of a broken boot.
  function bootActivate() {
    let want = null;
    try {
      if (TC.Settings) want = TC.Settings.get("activePacks", null);
    } catch (e) { /* settings unavailable headless */ }
    if (!Array.isArray(want) || !want.length) return { activated: [], error: null };
    try {
      const r = setActive(want, { persist: false });
      return { activated: r.activated, error: null };
    } catch (e) {
      // Fail closed to the base set; remember why for the title screen.
      try { setActive([], { persist: false }); } catch (e2) { /* stay base */ }
      return { activated: [], error: e };
    }
  }

  function getSpawnRules() {
    return spawnRules.slice();
  }
  TC.Packs = {
    MANIFEST_VERSION: MANIFEST_VERSION,
    GAME_VERSION: GAME_VERSION,
    Error: PackError,
    provide: provide,
    provideJSON: provideJSON,
    validateJSON: validateJSON,
    getManifest: getManifest,
    available: available,
    setActive: setActive,
    deactivateAll: deactivateAll,
    active: active,
    isActive: isActive,
    digest: digest,
    contentDigest: contentDigest,
    saveMetadata: saveMetadata,
    classifySave: classifySave,
    bootActivate: bootActivate,
    stats: stats,
    getSpawnRules: getSpawnRules,
    // Test/debug seam: last activation failure (null when none).
    lastError: () => lastError,
  };
})();

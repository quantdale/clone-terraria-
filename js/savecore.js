/* savecore.js — versioned persistence core (ARCHITECTURE.md §11).
   Providers register serializers under namespaced keys; this module builds a
   versioned envelope, chains migrations, validates structure, writes atomically
   (tmp -> bak -> main), falls back to backups and legacy v1 blobs on load, and
   supports export/import strings. save.js stays untouched; systems participate
   by registering here instead of wrapping Save.save. */
'use strict';
(function () {
  const TC = window.TC;
  if (!TC.SaveCore) TC.SaveCore = {};

  const FORMAT_VERSION = 2;
  const GAME_VERSION = '0.9.0-campaign';
  // Generation version is owned by js/worldgen.js; resolve it lazily so the
  // save envelope can never drift from the generator that produced the world.
  function currentGenerationVersion() {
    try {
      const v = TC.WorldGen && TC.WorldGen.GENERATION_VERSION;
      if (typeof v === 'number' && v >= 1) return v;
    } catch (e) {}
    return 1;
  }
  const DEFAULT_KEY = 'tc_save_v2'; // distinct from save.js 'tc_save_v1'
  const SECTIONS = ['world', 'character', 'systems'];
  const TOP_LEVEL_KEYS = ['formatVersion', 'gameVersion', 'generationVersion',
    'registryFingerprint', 'packs', 'metadata', 'world', 'character', 'systems'];
  const MAX_MIGRATION_STEPS = 32;

  // ---- small helpers ----
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isInt(v) { return isNum(v) && (v | 0) === v; }
  function msg(e) { return (e && e.message) ? e.message : String(e); }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, val) {
    try { window.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) {}
  }
  function parseRaw(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const data = JSON.parse(raw);
      return isObj(data) ? data : null;
    } catch (e) { return null; }
  }

  // ---- providers ----
  // Key layout: '<section>.<subkey>' with section in SECTIONS, e.g.
  // 'world.core.tiles', 'character.core.player', 'systems.core.wiring'.
  const providers = new Map();

  function splitKey(key) {
    if (typeof key !== 'string') return null;
    const dot = key.indexOf('.');
    if (dot <= 0 || dot === key.length - 1) return null;
    const section = key.slice(0, dot);
    const sub = key.slice(dot + 1);
    if (SECTIONS.indexOf(section) < 0) return null;
    if (!sub || sub[0] === '.' || sub[sub.length - 1] === '.' || sub.indexOf('..') >= 0) return null;
    return { section: section, sub: sub };
  }

  // def: { serialize(ctx) -> data, deserialize(data, ctx), version? }
  function register(key, def) {
    const loc = splitKey(key);
    if (!loc) {
      throw new Error('SaveCore: provider key must be "<world|character|systems>.<name>", got "' + key + '"');
    }
    if (!isObj(def) || typeof def.serialize !== 'function' || typeof def.deserialize !== 'function') {
      throw new Error('SaveCore: provider "' + key + '" needs serialize(ctx) and deserialize(data, ctx)');
    }
    const version = def.version == null ? 1 : def.version;
    if (!isInt(version) || version < 1) {
      throw new Error('SaveCore: provider "' + key + '" version must be an integer >= 1');
    }
    if (providers.has(key)) throw new Error('SaveCore: duplicate provider key "' + key + '"');
    providers.set(key, {
      key: key, section: loc.section, sub: loc.sub, version: version,
      serialize: def.serialize, deserialize: def.deserialize
    });
  }

  function unregister(key) { return providers.delete(key); }
  function providerKeys() { return Array.from(providers.keys()); }

  // ---- context ----
  // Live game state handed to every provider. All fields optional at runtime.
  function buildCtx() {
    return {
      world: TC.world || null,
      player: TC.player || null,
      seed: isNum(TC.worldSeed) ? TC.worldSeed : null,
      time: (TC.Sky && isNum(TC.Sky.time)) ? TC.Sky.time : 0
    };
  }

  function fingerprint() {
    try {
      if (TC.Registry && typeof TC.Registry.fingerprint === 'function') {
        const f = TC.Registry.fingerprint();
        if (f == null) return null;
        return (typeof f === 'string') ? f : String(f);
      }
    } catch (e) { /* registry lands in parallel; absence is fine */ }
    return null;
  }

  function emptyEnvelope() {
    return {
      formatVersion: FORMAT_VERSION,
      gameVersion: GAME_VERSION,
      generationVersion: currentGenerationVersion(),
      registryFingerprint: null,
      packs: null,
      metadata: { savedAt: new Date().toISOString(), seed: null },
      world: {},
      character: {},
      systems: {}
    };
  }

  // Serialize every registered provider into a fresh envelope.
  // Throws if any provider fails so callers never write partial saves.
  function buildEnvelope(ctx) {
    ctx = ctx || buildCtx();
    const env = emptyEnvelope();
    env.registryFingerprint = fingerprint();
    // W25 MOD-003: active pack-set identity rides the envelope so loads can
    // be classified (exact / missing / incompatible) BEFORE world state
    // mutates. Null when no packs are active (pre-W25 shape).
    try {
      env.packs = (TC.Packs && typeof TC.Packs.saveMetadata === 'function')
        ? TC.Packs.saveMetadata() : null;
    } catch (e) { env.packs = null; }
    if (isObj(ctx) && isNum(ctx.seed)) env.metadata.seed = ctx.seed;
    providers.forEach(function (p) {
      let data;
      try { data = p.serialize(ctx); } catch (e) {
        throw new Error('SaveCore: provider "' + p.key + '" serialize failed: ' + msg(e));
      }
      env[p.section][p.sub] = { v: p.version, data: data == null ? null : data };
    });
    return env;
  }

  // ---- migrations ----
  // Chain of N -> N+1 steps; fn(env) mutates content in place (or returns a
  // replacement envelope). SaveCore bumps formatVersion itself.
  const migrations = new Map(); // fromV -> { toV, fn }

  function registerMigration(fromV, toV, fn) {
    if (!isInt(fromV) || !isInt(toV) || toV !== fromV + 1) {
      throw new Error('SaveCore: migrations must step N -> N+1 (got ' + fromV + ' -> ' + toV + ')');
    }
    if (typeof fn !== 'function') throw new Error('SaveCore: migration fn required');
    migrations.set(fromV, { toV: toV, fn: fn });
  }

  // Walk env up to FORMAT_VERSION. Throws on a missing step or a save from a
  // newer build; the input envelope is never mutated.
  function applyMigrations(env) {
    if (!isObj(env)) throw new Error('SaveCore: cannot migrate a non-object envelope');
    let out = Object.assign({}, env);
    let v = out.formatVersion;
    if (!isInt(v)) throw new Error('SaveCore: envelope has no numeric formatVersion');
    if (v > FORMAT_VERSION) {
      throw new Error('SaveCore: save format ' + v + ' is newer than this build (' + FORMAT_VERSION + ')');
    }
    let steps = 0;
    while (v < FORMAT_VERSION) {
      const m = migrations.get(v);
      if (!m) throw new Error('SaveCore: no migration from formatVersion ' + v);
      const res = m.fn(out);
      if (res !== undefined) {
        if (!isObj(res)) throw new Error('SaveCore: migration ' + v + '->' + m.toV + ' returned a non-object');
        out = res;
      }
      out.formatVersion = m.toV;
      v = m.toV;
      if (++steps > MAX_MIGRATION_STEPS) throw new Error('SaveCore: migration chain did not converge');
    }
    return out;
  }

  // ---- validation ----
  // Structural checks only; section payloads belong to their providers.
  // Entries starting with 'warning:' do not affect ok.
  function validate(env) {
    const errors = [];
    let ok = true;
    function fail(text) { errors.push(text); ok = false; }
    function warn(text) { errors.push('warning: ' + text); }

    if (!isObj(env)) {
      fail('envelope is not an object');
      return { ok: ok, errors: errors };
    }
    const fv = env.formatVersion;
    if (!isInt(fv) || fv < 1) fail('formatVersion must be an integer >= 1');
    else if (fv > FORMAT_VERSION) fail('formatVersion ' + fv + ' is newer than supported ' + FORMAT_VERSION);
    if (typeof env.gameVersion !== 'string' || !env.gameVersion) fail('gameVersion must be a non-empty string');
    if (!isInt(env.generationVersion) || env.generationVersion < 1) fail('generationVersion must be an integer >= 1');
    if (env.registryFingerprint != null && typeof env.registryFingerprint !== 'string') {
      fail('registryFingerprint must be a string or null');
    }
    if (env.packs != null) {
      if (!isObj(env.packs) || env.packs.v !== 1 ||
          typeof env.packs.fp !== 'string' || typeof env.packs.gfp !== 'string' ||
          !Array.isArray(env.packs.packs)) {
        fail('packs metadata must be { v:1, fp, gfp, packs: [...] } or null');
      } else if (env.packs.packs.length > 16) {
        fail('packs metadata lists too many entries');
      } else {
        for (const p of env.packs.packs) {
          if (!isObj(p) || typeof p.id !== 'string' || !p.id ||
              typeof p.version !== 'string' || !p.version ||
              (p.type !== 'data' && p.type !== 'resource')) {
            fail('packs metadata entries must be { id, version, type }');
            break;
          }
        }
      }
    }
    if (!isObj(env.metadata)) fail('metadata must be an object');
    else {
      if (typeof env.metadata.savedAt !== 'string' || !env.metadata.savedAt) fail('metadata.savedAt must be a non-empty string');
      if (env.metadata.seed != null && !isNum(env.metadata.seed)) fail('metadata.seed must be a number or null');
    }
    for (let s = 0; s < SECTIONS.length; s++) {
      const name = SECTIONS[s];
      const sec = env[name];
      if (!isObj(sec)) { fail('section "' + name + '" must be an object'); continue; }
      const keys = Object.keys(sec);
      for (let i = 0; i < keys.length; i++) {
        const entry = sec[keys[i]];
        if (!isObj(entry) || !isInt(entry.v) || entry.v < 1 || !('data' in entry)) {
          fail('section "' + name + '" entry "' + keys[i] + '" must be { v: int >= 1, data }');
        }
      }
    }
    const top = Object.keys(env);
    for (let i = 0; i < top.length; i++) {
      if (TOP_LEVEL_KEYS.indexOf(top[i]) < 0) warn('unknown top-level key "' + top[i] + '"');
    }
    return { ok: ok, errors: errors };
  }

  // ---- atomic write ----
  // Serialize -> stringify -> write '<key>.tmp' -> verify persisted bytes parse
  // back -> copy last good main to '<key>.bak' -> write main -> remove tmp.
  // Any failure leaves the previous main/bak untouched.
  function saveNow(storageKey) {
    const key = storageKey || DEFAULT_KEY;
    let json;
    try { json = JSON.stringify(buildEnvelope(buildCtx())); } catch (e) { return false; }

    const prev = storageGet(key);
    const prevGood = (prev && parseRaw(prev)) ? prev : null;

    if (!storageSet(key + '.tmp', json)) return false;
    const written = parseRaw(storageGet(key + '.tmp'));
    if (!written || written.formatVersion !== FORMAT_VERSION) {
      storageRemove(key + '.tmp');
      return false;
    }
    if (prevGood) storageSet(key + '.bak', prevGood); // best-effort backup
    if (!storageSet(key, json)) {
      storageRemove(key + '.tmp');
      return false;
    }
    storageRemove(key + '.tmp');
    return true;
  }

  // ---- legacy v1 adapter ----
  // save.js v1 blobs: numeric .v, no .formatVersion. Every original key is
  // preserved verbatim under systems.legacy.data so nothing is dropped; known
  // keys can be lifted into proper sections by later migrations/providers.
  function isLegacyBlob(data) {
    return isObj(data) && isInt(data.v) && data.formatVersion === undefined;
  }

  function legacyToEnvelope(data) {
    const env = emptyEnvelope();
    env.gameVersion = 'legacy';
    env.metadata.seed = isNum(data.seed) ? data.seed : null;
    env.metadata.convertedFrom = data.v;
    env.systems.legacy = { v: 1, data: Object.assign({}, data) };
    return env;
  }

  // ---- load ----
  // main -> bak -> null. Each candidate is parsed, legacy-converted if needed,
  // migrated and validated; the first candidate that survives wins.
  function loadFrom(storageKey) {
    const key = storageKey || DEFAULT_KEY;
    const candidates = [storageGet(key), storageGet(key + '.bak')];
    for (let i = 0; i < candidates.length; i++) {
      const data = parseRaw(candidates[i]);
      if (!data) continue;
      const env = isLegacyBlob(data) ? legacyToEnvelope(data) : data;
      let migrated;
      try { migrated = applyMigrations(env); } catch (e) { continue; }
      if (!validate(migrated).ok) continue;
      return migrated;
    }
    return null;
  }

  // ---- restore ----
  // Dispatch envelope sections back to registered providers. Never throws per
  // provider; results report restored/failed/missing keys. A deserialize that
  // throws OR returns false (payload rejected) lands in failed[].
  function restore(env, ctx) {
    const res = { restored: [], failed: [], missing: [] };
    if (!isObj(env)) return res;
    ctx = ctx || buildCtx();
    providers.forEach(function (p) {
      const sec = env[p.section];
      const entry = sec ? sec[p.sub] : null;
      if (!entry) { res.missing.push(p.key); return; }
      if (isInt(entry.v) && entry.v > p.version) {
        res.failed.push({ key: p.key, error: 'data version ' + entry.v + ' is newer than provider version ' + p.version });
        return;
      }
      let out;
      try { out = p.deserialize(entry.data, ctx); } catch (e) {
        res.failed.push({ key: p.key, error: msg(e) });
        return;
      }
      // Providers signal "saved payload rejected" by returning false; count
      // that as a failure rather than a restore that never happened.
      if (out === false) {
        res.failed.push({ key: p.key, error: 'deserialize rejected the saved data' });
      } else {
        res.restored.push(p.key);
      }
    });
    return res;
  }

  // ---- export / import ----
  // Plain JSON strings. Export throws if a provider fails (never exports a
  // partial save); import throws on unparsable input, unmigratable formats or
  // failed validation — no silent data loss.
  function exportString() {
    try { return JSON.stringify(buildEnvelope(buildCtx())); } catch (e) {
      throw new Error('SaveCore: export failed: ' + msg(e));
    }
  }

  function importString(str) {
    const data = parseRaw(str);
    if (!data) throw new Error('SaveCore: import string is not valid JSON');
    const env = isLegacyBlob(data) ? legacyToEnvelope(data) : data;
    let migrated;
    try { migrated = applyMigrations(env); } catch (e) {
      throw new Error('SaveCore: import failed: ' + msg(e));
    }
    const verdict = validate(migrated);
    if (!verdict.ok) throw new Error('SaveCore: import failed validation: ' + verdict.errors.join('; '));
    return migrated;
  }

  TC.SaveCore.FORMAT_VERSION = FORMAT_VERSION;
  TC.SaveCore.GAME_VERSION = GAME_VERSION;
  Object.defineProperty(TC.SaveCore, 'GENERATION_VERSION', { get: currentGenerationVersion });
  TC.SaveCore.DEFAULT_KEY = DEFAULT_KEY;

  TC.SaveCore.register = register;
  TC.SaveCore.unregister = unregister;
  TC.SaveCore.providerKeys = providerKeys;
  TC.SaveCore.buildCtx = buildCtx;
  TC.SaveCore.buildEnvelope = buildEnvelope;
  TC.SaveCore.registerMigration = registerMigration;
  TC.SaveCore.applyMigrations = applyMigrations;
  TC.SaveCore.validate = validate;
  TC.SaveCore.saveNow = saveNow;
  TC.SaveCore.loadFrom = loadFrom;
  TC.SaveCore.restore = restore;
  TC.SaveCore.exportString = exportString;
  TC.SaveCore.importString = importString;
  TC.SaveCore.isLegacyBlob = isLegacyBlob;
  TC.SaveCore.legacyToEnvelope = legacyToEnvelope;
})();

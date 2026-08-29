/* packstore.js — TC.PackStore: durable installed pack-manifest store (W26 / WS2).
 *
 * Separates USER-INSTALLED pack source data from TC.Settings (preferences),
 * world saves, and the active pack set. The store persists ONLY validated
 * JSON manifests under a versioned localStorage envelope with explicit per-
 * manifest, count and total-store caps. No executable code is ever stored —
 * every byte that enters the store is first validated through the SAME
 * TC.Packs.provideJSON security boundary used everywhere else, so an installed
 * manifest can never bypass TC.Packs validation.
 *
 * Lifecycle:
 *   - install(text)  : validate -> stage in store -> persist (does NOT activate)
 *   - load()         : provide every installed manifest to TC.Packs BEFORE boot
 *                      activation (so installed packs can be activated on reload)
 *   - remove(id)     : drop an installed manifest (rejected while it is active)
 *   - exportJSON()   : canonical envelope for backup/sharing
 *   - list/has/get   : read-only introspection
 *
 * Activation remains a SEPARATE, restart-required operation owned by TC.Packs
 * (session-permanence: dense indices cannot shift mid-session). Changing the
 * active set = edit Settings.activePacks + reload.
 *
 * Owns exactly this file. Loads after js/packs.js (needs TC.Packs at boot).
 * Exposed API: TC.PackStore.{KEY, load, install, remove, exportJSON, list,
 *   has, get, repair, stats}. */

(() => {
  const TC = (window.TC = window.TC || {});
  if (TC.PackStore) return; // load-once guard

  const KEY = 'tc_packs_installed_v1';
  const ENVELOPE_V = 1;
  const MAX_INSTALLED = 64;
  const MAX_MANIFEST_BYTES = 256 * 1024; // single manifest cap (mirrors TC.Packs)
  const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // whole-store cap

  // ---- storage abstraction (window.localStorage, headless-stub tolerant) ----
  function storage() {
    try {
      return (typeof window !== 'undefined' && window.localStorage) || null;
    } catch (e) {
      return null;
    }
  }

  // In-memory mirror of the persisted envelope; kept in sync by every mutator.
  let installed = []; // [{ id, digest, json }]
  let lastLoadErrors = [];

  function readEnvelope() {
    const s = storage();
    if (!s) return { v: ENVELOPE_V, manifests: [] };
    let raw;
    try {
      raw = s.getItem(KEY);
    } catch (e) {
      return { v: ENVELOPE_V, manifests: [] };
    }
    if (!raw) return { v: ENVELOPE_V, manifests: [] };
    let env;
    try {
      env = JSON.parse(raw);
    } catch (e) {
      // Corrupt/truncated storage degrades to empty; never throws at boot.
      return { v: ENVELOPE_V, manifests: [], corrupt: true };
    }
    if (!env || env.v !== ENVELOPE_V || !Array.isArray(env.manifests)) {
      return { v: ENVELOPE_V, manifests: [], corrupt: true };
    }
    return env;
  }

  function writeEnvelope(env) {
    const s = storage();
    if (!s) return true; // headless memory-only mode
    try {
      s.setItem(KEY, JSON.stringify(env));
      return true;
    } catch (e) {
      // A storage/quota failure is a failed mutation, not a successful
      // in-memory-only install. Callers commit their mirror only after this.
      return false;
    }
  }

  function persist(next) {
    const value = Array.isArray(next) ? next : installed;
    return writeEnvelope({ v: ENVELOPE_V, manifests: value.slice() });
  }

  function totalBytes(list) {
    const value = Array.isArray(list) ? list : installed;
    let n = 0;
    for (const m of value) n += (m.json ? m.json.length : 0);
    return n;
  }

  // Provide every installed manifest to TC.Packs so it can be activated on a
  // fresh boot. Runs BEFORE TC.Packs.bootActivate. A single bad entry is
  // skipped (degrade) — it must never block boot. Stored ids/digests are not
  // trusted: the validated manifest is the source of canonical identity.
  function load() {
    const env = readEnvelope();
    installed = [];
    lastLoadErrors = [];
    if (!Array.isArray(env.manifests)) return { provided: 0, errors: lastLoadErrors };
    if (env.manifests.length > MAX_INSTALLED) {
      lastLoadErrors.push('installed manifest count exceeds limit');
    }
    for (const m of env.manifests.slice(0, MAX_INSTALLED)) {
      if (!m || typeof m.json !== 'string') continue;
      if (m.json.length > MAX_MANIFEST_BYTES || totalBytes() + m.json.length > MAX_TOTAL_BYTES) {
        lastLoadErrors.push((m.id || '?') + ': installed store quota exceeded');
        continue;
      }
      try {
        const rec = TC.Packs && typeof TC.Packs.provideJSON === 'function'
          ? TC.Packs.provideJSON(m.json)
          : null;
        if (!rec) throw new Error('pack authority unavailable');
        installed.push({ id: rec.id, digest: rec.rawDigest, json: m.json });
      } catch (e) {
        lastLoadErrors.push((m && m.id ? m.id : '?') + ': ' + (e && e.message || e));
      }
    }
    return { provided: installed.length, errors: lastLoadErrors.slice() };
  }

  // Persist a candidate before changing the in-memory mirror. This keeps
  // install/replace/remove atomic when localStorage rejects the write.
  function commitCandidate(candidate) {
    if (!persist(candidate)) return false;
    installed = candidate;
    return true;
  }

  // Validate + store a manifest. Does NOT activate. Returns a result object.
  function install(text, opts) {
    opts = opts || {};
    if (typeof text !== 'string' || !text.length) return { ok: false, error: 'empty' };
    if (text.length > MAX_MANIFEST_BYTES) return { ok: false, error: 'too-large' };
    if (!TC.Packs || typeof TC.Packs.validateJSON !== 'function' ||
        typeof TC.Packs.provideJSON !== 'function') {
      return { ok: false, error: 'no-authority' };
    }

    let validated;
    try {
      validated = TC.Packs.validateJSON(text);
    } catch (e) {
      return { ok: false, error: 'invalid', detail: e && e.message || String(e) };
    }
    const id = validated.id;
    const digest = validated.rawDigest;
    const existing = installed.find((m) => m.id === id);
    if (existing && existing.digest === digest) {
      return { ok: true, id, digest, status: 'unchanged' };
    }
    // A build-provided manifest may already occupy this id without being in
    // the durable installed store. Reject different content before any store
    // write; identical content can be recorded without calling provideJSON
    // again, avoiding a duplicate error after persistence.
    const provided = TC.Packs.getManifest && TC.Packs.getManifest(id);
    if (!existing && provided) {
      if (provided.rawDigest !== digest) {
        return { ok: false, error: 'invalid', detail: 'pack id already provided with different content' };
      }
      const candidate = installed.concat({ id, digest, json: text });
      if (installed.length >= MAX_INSTALLED) return { ok: false, error: 'max-installed' };
      if (totalBytes(candidate) > MAX_TOTAL_BYTES) return { ok: false, error: 'quota' };
      if (!persist(candidate)) return { ok: false, error: 'storage' };
      installed = candidate;
      return { ok: true, id, digest, status: 'installed' };
    }
    if (existing && TC.Packs.isActive && TC.Packs.isActive(id)) {
      return { ok: false, error: 'active' };
    }
    if (existing && !opts.replace) return { ok: false, error: 'conflict' };

    const candidate = existing
      ? installed.map((m) => m.id === id ? { id, digest, json: text } : m)
      : installed.concat({ id, digest, json: text });
    if (!existing && installed.length >= MAX_INSTALLED) {
      return { ok: false, error: 'max-installed' };
    }
    if (totalBytes(candidate) > MAX_TOTAL_BYTES) return { ok: false, error: 'quota' };

    // Existing provided content is intentionally left untouched: replacing a
    // pack is a next-boot operation because TC.Packs is session-permanent.
    if (existing) {
      if (!commitCandidate(candidate)) return { ok: false, error: 'storage' };
      return { ok: true, id, digest, status: 'replaced' };
    }

    // New content is provided only after durable persistence succeeds. If the
    // authority rejects despite the probe, restore the prior store snapshot.
    if (!persist(candidate)) return { ok: false, error: 'storage' };
    try {
      const rec = TC.Packs.provideJSON(text);
      installed = candidate;
      return { ok: true, id: rec.id, digest: rec.rawDigest, status: 'installed' };
    } catch (e) {
      persist(installed);
      return { ok: false, error: 'invalid', detail: e && e.message || String(e) };
    }
  }

  // Remove an installed manifest. Rejected while it is part of the live
  // committed set (changing that would shift dense indices mid-session).
  function remove(id) {
    const idx = installed.findIndex((m) => m.id === id);
    if (idx < 0) return { ok: false, error: 'missing' };
    if (TC.Packs && typeof TC.Packs.isActive === 'function' && TC.Packs.isActive(id)) {
      return { ok: false, error: 'active' };
    }
    const candidate = installed.slice();
    candidate.splice(idx, 1);
    if (!commitCandidate(candidate)) return { ok: false, error: 'storage' };
    return { ok: true, id };
  }

  function list() {
    return installed.map((m) => ({ id: m.id, digest: m.digest }));
  }
  function has(id) {
    return installed.some((m) => m.id === id);
  }
  function get(id) {
    const m = installed.find((x) => x.id === id);
    return m ? { id: m.id, digest: m.digest } : null;
  }

  function exportJSON() {
    return JSON.stringify({ v: ENVELOPE_V, manifests: installed.slice() });
  }
  function exportPack(id) {
    const m = installed.find((x) => x.id === id);
    return m ? m.json : null;
  }

  // Drop any entry whose JSON no longer validates (defensive hygiene).
  function repair() {
    const before = installed.slice();
    const kept = [];
    for (const m of before) {
      try {
        const rec = TC.Packs.validateJSON(m.json);
        if (rec.id !== m.id || rec.rawDigest !== m.digest) {
          kept.push({ id: rec.id, digest: rec.rawDigest, json: m.json });
        } else {
          kept.push(m);
        }
      } catch (e) { /* drop */ }
    }
    if (totalBytes(kept) > MAX_TOTAL_BYTES || kept.length > MAX_INSTALLED || !persist(kept)) {
      return { removed: 0, error: 'storage' };
    }
    installed = kept;
    return { removed: before.length - kept.length };
  }

  function stats() {
    return {
      count: installed.length,
      totalBytes: totalBytes(),
      maxInstalled: MAX_INSTALLED,
      maxBytes: MAX_TOTAL_BYTES,
      loadErrors: lastLoadErrors.slice(),
    };
  }

  TC.PackStore = {
    KEY: KEY,
    load: load,
    install: install,
    remove: remove,
    exportJSON: exportJSON,
    exportPack: exportPack,
    list: list,
    has: has,
    get: get,
    repair: repair,
    stats: stats,
  };
})();

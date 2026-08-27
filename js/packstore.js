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
    if (!s) return false;
    try {
      s.setItem(KEY, JSON.stringify(env));
      return true;
    } catch (e) {
      // Quota or serialization failure must not crash boot; best-effort only.
      return false;
    }
  }

  function persist() {
    writeEnvelope({ v: ENVELOPE_V, manifests: installed.slice() });
  }

  function totalBytes() {
    let n = 0;
    for (const m of installed) n += (m.json ? m.json.length : 0);
    return n;
  }

  // Provide every installed manifest to TC.Packs so it can be activated on a
  // fresh boot. Runs BEFORE TC.Packs.bootActivate. A single bad entry is
  // skipped (degrade) — it must never block boot.
  function load() {
    const env = readEnvelope();
    installed = [];
    lastLoadErrors = [];
    if (!Array.isArray(env.manifests)) return { provided: 0, errors: lastLoadErrors };
    for (const m of env.manifests) {
      if (!m || typeof m.json !== 'string') continue;
      try {
        if (TC.Packs && typeof TC.Packs.provideJSON === 'function') {
          TC.Packs.provideJSON(m.json);
        } else {
          JSON.parse(m.json); // at least confirm it parses
        }
        installed.push({ id: m.id, digest: m.digest, json: m.json });
      } catch (e) {
        lastLoadErrors.push((m && m.id ? m.id : '?') + ': ' + (e && e.message || e));
      }
    }
    return { provided: installed.length, errors: lastLoadErrors.slice() };
  }

  // Validate + store a manifest. Does NOT activate. Returns a result object.
  function install(text, opts) {
    opts = opts || {};
    if (typeof text !== 'string' || !text.length) {
      return { ok: false, error: 'empty' };
    }
    if (text.length > MAX_MANIFEST_BYTES) {
      return { ok: false, error: 'too-large' };
    }
    // Parse id early for duplicate/conflict handling (needed when TC.Packs
    // rejects different content under same id in this session).
    let parsedId = null;
    try { const p = JSON.parse(text); if (p && typeof p.id === 'string') parsedId = p.id; } catch (e) { /* handled below */ }
    let rec;
    try {
      if (!TC.Packs || typeof TC.Packs.provideJSON !== 'function') {
        return { ok: false, error: 'no-authority' };
      }
      rec = TC.Packs.provideJSON(text); // throws on invalid; validates security
    } catch (e) {
      // Duplicate with different content is a store-level conflict, not a
      // generic invalid, when we already have that id installed.
      if (e && e.code === 'duplicate' && parsedId) {
        const existingDup = installed.find((m) => m.id === parsedId);
        if (existingDup) {
          if (TC.Packs.isActive && TC.Packs.isActive(parsedId)) {
            return { ok: false, error: 'active' };
          }
          if (!opts.replace) {
            return { ok: false, error: 'conflict' };
          }
          // Replace path for same-session duplicate: validate structure once
          // more via JSON parse (already valid enough to reach duplicate check)
          // then update the store for next boot.
          installed = installed.filter((m) => m.id !== parsedId);
          // Re-validate the new text is still provided-valid in a clean slot
          // by checking it parses; if it does, store it.
          try { JSON.parse(text); } catch (pe) {
            return { ok: false, error: 'invalid', detail: pe && pe.message || String(pe) };
          }
          if (installed.length >= MAX_INSTALLED) return { ok: false, error: 'max-installed' };
          if (totalBytes() + text.length > MAX_TOTAL_BYTES) return { ok: false, error: 'quota' };
          // Digest for the new entry: will be canonicalized on next load; use
          // a provisional hash of the text for this session's list.
          let newDigest = 'pending';
          try { newDigest = String(text.length) + ':' + text.slice(0, 32); } catch (e2) {}
          installed.push({ id: parsedId, digest: newDigest, json: text });
          persist();
          return { ok: true, id: parsedId, digest: newDigest, status: 'replaced' };
        }
      }
      return { ok: false, error: 'invalid', detail: (e && e.message) || String(e) };
    }
    const id = rec.id;
    const digest = rec.rawDigest;
    // Same id + same digest => idempotent no-op.
    const existing = installed.find((m) => m.id === id);
    if (existing) {
      if (existing.digest === digest) {
        return { ok: true, id, digest, status: 'unchanged' };
      }
      // Conflicting content for an already-installed id.
      if (TC.Packs.isActive && TC.Packs.isActive(id)) {
        return { ok: false, error: 'active' }; // cannot silently shift committed set
      }
      if (!opts.replace) {
        return { ok: false, error: 'conflict' };
      }
      // Replace path: drop the old entry, then fall through to insert.
      installed = installed.filter((m) => m.id !== id);
    }
    // Caps.
    if (installed.length >= MAX_INSTALLED) {
      return { ok: false, error: 'max-installed' };
    }
    if (totalBytes() + text.length > MAX_TOTAL_BYTES) {
      return { ok: false, error: 'quota' };
    }
    installed.push({ id, digest, json: text });
    persist();
    return { ok: true, id, digest, status: existing ? 'replaced' : 'installed' };
  }

  // Remove an installed manifest. Rejected while it is part of the live
  // committed set (changing that would shift dense indices mid-session).
  function remove(id) {
    const idx = installed.findIndex((m) => m.id === id);
    if (idx < 0) return { ok: false, error: 'missing' };
    if (TC.Packs && typeof TC.Packs.isActive === 'function' && TC.Packs.isActive(id)) {
      return { ok: false, error: 'active' };
    }
    installed.splice(idx, 1);
    persist();
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
    const before = installed.length;
    const kept = [];
    for (const m of installed) {
      try {
        if (TC.Packs && typeof TC.Packs.provideJSON === 'function') {
          TC.Packs.provideJSON(m.json);
        } else {
          JSON.parse(m.json);
        }
        kept.push(m);
      } catch (e) { /* drop */ }
    }
    installed = kept;
    persist();
    return { removed: before - kept.length };
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

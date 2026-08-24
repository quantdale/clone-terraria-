/* settings.js — TC.Settings: tiny versioned user-preference store.
//
// Locale choice and similar user preferences are NOT world progression:
// they must survive world deletion, save import/export and page reloads
// without ever touching the tc_save_v1/v2 payloads. This module owns that
// separation with one localStorage envelope:
//
//   tc_settings_v1 = {"v":1,"values":{"locale":"en", ...}}
//
// Contract (W20):
//   available()            -> true when localStorage works here
//   get(name, fallback)    -> stored value or fallback (unknown names pass through)
//   set(name, value)       -> true when persisted (null removes the field)
//   remove(name)           -> drop one field
//   clear()                -> wipe the whole envelope
//
// Robustness rules: corrupt/truncated JSON, wrong envelope shape or a
// throwing localStorage can never break boot — the store degrades to an
// in-memory map and warns once. Unknown fields inside `values` are preserved
// verbatim so future preference owners ride along without migrations.
//
// Owns exactly this file. Loads before localization.js (its first consumer).
// Style: 'use strict' IIFE, 2-space indent, single quotes, ES2020. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Settings) return; // load-once guard

  const KEY = 'tc_settings_v1';
  const warned = { parse: false };

  function warnOnce(msg) {
    if (warned[msg]) return;
    warned[msg] = true;
    try { console.warn('[TC.Settings] ' + msg); } catch (e) {}
  }

  function storageOk() {
    try {
      const probe = '__tc_settings_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (e) { return false; }
  }

  const mem = new Map();               // fallback when localStorage unusable
  const persistent = storageOk();
  let loaded = false;
  let values = {};                     // deserialized envelope values
  let version = 1;

  function readRaw() {
    if (!persistent) return mem.get(KEY) || null;
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    values = {};
    version = 1;
    const raw = readRaw();
    if (raw == null) return;
    let env = null;
    try { env = JSON.parse(raw); } catch (e) {
      warnOnce('corrupt settings payload ignored: ' + (e && e.message));
      return;
    }
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      warnOnce('settings payload was not an object; ignored');
      return;
    }
    if (typeof env.v === 'number' && isFinite(env.v)) version = env.v | 0;
    const v = env.values;
    if (v != null) {
      if (typeof v === 'object' && !Array.isArray(v)) values = v; // tolerance: unknown fields kept
      else warnOnce('settings values field had unexpected shape; ignored');
    }
  }

  function persist() {
    const env = JSON.stringify({ v: version, values: values });
    if (!persistent) { mem.set(KEY, env); return true; }
    try {
      window.localStorage.setItem(KEY, env);
      return true;
    } catch (e) {
      warnOnce('settings write failed: ' + (e && e.message));
      return false;
    }
  }

  function get(name, fallback) {
    load();
    if (name == null) return fallback;
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    return fallback;
  }

  function set(name, value) {
    load();
    if (name == null) return false;
    if (value === undefined) return remove(name);
    if (value === null) return remove(name);
    values[name] = value;
    return persist();
  }

  function remove(name) {
    load();
    if (name == null) return false;
    if (!Object.prototype.hasOwnProperty.call(values, name)) return persist();
    delete values[name];
    return persist();
  }

  function clear() {
    load();
    values = {};
    if (!persistent) { mem.delete(KEY); return true; }
    try { window.localStorage.removeItem(KEY); return true; } catch (e) { return persist(); }
  }

  TC.Settings = {
    KEY: KEY,
    available: () => persistent,
    get: get,
    set: set,
    remove: remove,
    clear: clear,
  };
})();

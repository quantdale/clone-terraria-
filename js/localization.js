/* localization.js — TC.Localization: THE canonical localization authority (W20,
   TASK_BOARD LOC-001). One service, no competing helpers.

   Mission: make localized display text a presentation concern while every
   machine contract stays locale-independent. Registry ids, save schema keys,
   progression flags, command/event names, enemy types, item ids, biome tags
   and recipe identities are NEVER translated and never derived from
   translations (see §6 of docs/ARCHITECTURE.md).

   API:
     register(locale, catalog, meta?) -> {ok}|{ok:false,error}
         Catalog: flat dotted keys or nested objects (flattened at
         registration). Values are strings, plural objects
         {zero?,one,two?,few?,many?,other}, or null (explicitly untranslated).
     setLocale(locale) -> bool      activates + persists via TC.Settings
     getLocale() / getFallbackLocale() / availableLocales(includeDev?)
     t(key, vars?)                  translate + interpolate + plural-select
     has(key, locale?)
     contentName(kind, ref)         registry-resolved display name
     contentDescription(kind, ref)  -> string|null
     validate() -> {ok, errors[], warnings[]}
     missing() -> [{key, locale}]   unique lookup misses, sorted
     stats() -> counters for tests/debug
     restore()                      apply persisted locale once (locale files call this)

   Fallback semantics: active locale -> fallback locale ('en') -> visible
   deterministic placeholder '[key]' plus a warn-once diagnostic. Never an
   empty string; never a per-frame console flood.

   Interpolation: '{name}' placeholders, plain string substitution only —
   no HTML evaluation, numeric zero is a valid value, a MISSING variable keeps
   its literal placeholder in the output and records a diagnostic (never the
   string 'undefined').

   Plural selection: Intl.PluralRules when available (per active locale),
   deterministic en-style one/other fallback otherwise. Categories resolve
   selected -> 'other'; entries without 'other' record a diagnostic.

   Pseudo-locale (dev stress): registerPseudoLocale('en-XA', opts) derives a
   synthetic catalog from the fallback at lookup time — deterministic accent
   mapping + vowel doubling (~+35% length) with optional visible wrap markers.
   Placeholder tokens are preserved verbatim. Dev locales are hidden from
   availableLocales() unless requested and are never offered to players as a
   real language.

   file:// contract: catalogs are plain scripts (js/locales/*.js) loaded from
   index.html — no fetch(), no bundler, works headless via the real loader.

   Owns exactly this file. Loads after settings.js/events.js, before any
   js/locales/*.js catalog. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Localization) return; // load-once guard

  const FALLBACK = 'en';
  const KEY_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
  const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
  const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

  // ---- state ----
  const catalogs = Object.create(null);   // locale -> {flat map}
  const meta = Object.create(null);       // locale -> {name, nativeName, dev, pseudo}
  let active = FALLBACK;
  let explicitChoice = false;

  const missingKeys = Object.create(null); // key -> true (unique set)
  const warnedMissing = Object.create(null);
  const counts = { lookups: 0, hits: 0, fallbackHits: 0, misses: 0 };

  function warnOnce(msg) {
    if (warnedMissing[msg]) return;
    warnedMissing[msg] = true;
    try { console.warn('[TC.Localization] ' + msg); } catch (e) {}
  }

  function validLocaleId(id) {
    return typeof id === 'string' && LOCALE_RE.test(id) && id.length <= 16;
  }

  // ---- catalog flattening ----
  function flatten(prefix, obj, out, errors) {
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const key = prefix ? prefix + '.' + k : k;
      const v = obj[k];
      if (v == null) { out[key] = null; continue; }        // explicit gap
      const t = typeof v;
      if (t === 'string') {
        if (!KEY_RE.test(key)) errors.push('malformed key "' + key + '"');
        out[key] = v;
      } else if (t === 'object') {
        if (Array.isArray(v)) { errors.push('array value at "' + key + '"'); continue; }
        // plural entry? ({one,other,...} with no nested objects inside)
        const keys = Object.keys(v);
        const pluralish = keys.length > 0 && keys.every((pk) =>
          ['zero', 'one', 'two', 'few', 'many', 'other'].indexOf(pk) >= 0 &&
          typeof v[pk] === 'string');
        if (pluralish) {
          if (!KEY_RE.test(key)) errors.push('malformed key "' + key + '"');
          out[key] = Object.assign({}, v);
        } else {
          flatten(key, v, out, errors);
        }
      } else {
        errors.push('unsupported value type at "' + key + '"');
      }
    }
  }

  // ---- registration ----
  function register(locale, catalog, m) {
    if (!validLocaleId(locale)) return { ok: false, error: 'invalid-locale-id' };
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      return { ok: false, error: 'catalog must be an object' };
    }
    if (catalogs[locale] && !(m && m.replace)) {
      return { ok: false, error: 'duplicate-locale' };
    }
    const flat = Object.create(null);
    const errors = [];
    flatten('', catalog, flat, errors);
    if (errors.length) return { ok: false, error: 'invalid-catalog', details: errors };
    catalogs[locale] = flat;
    meta[locale] = {
      name: (m && m.name) || locale,
      nativeName: (m && m.nativeName) || (m && m.name) || locale,
      dev: !!(m && m.dev),
      pseudo: !!(m && m.pseudo),
    };
    return { ok: true };
  }

  // Deterministic synthetic stress locale: transforms fallback text.
  function pseudoTransform(s, markers) {
    const MAP = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý' };
    let vowelIdx = 0;
    const marked = String(s).replace(PLACEHOLDER_RE,
      (m) => '\u0001' + m.slice(1, -1) + '\u0002');
    const body = marked.replace(/[A-Za-z]/g, (ch) => {
      const mapped = MAP[ch.toLowerCase()];
      if (!mapped) return ch;
      const out = (ch !== ch.toLowerCase()) ? mapped.toUpperCase() : mapped;
      vowelIdx++;
      return (vowelIdx % 3 === 0) ? out + out : out; // expansion pressure
    }).replace(/\u0001/g, '{').replace(/\u0002/g, '}');
    return markers ? '\u27E6' + body + '\u27E7' : body;
  }

  function registerPseudoLocale(id, opts) {
    const o = opts || {};
    const r = register(id, { 'pseudo.locale': id }, {
      name: o.name || 'Pseudo (' + id + ')',
      nativeName: o.nativeName || o.name || id,
      dev: true, pseudo: true, replace: true,
    });
    if (r.ok) meta[id].markers = o.markers !== false;
    return r;
  }

  // ---- lookup core ----
  function rawEntry(key, locale) {
    const cat = catalogs[locale];
    if (!cat) return undefined;
    return cat[key];
  }

  function resolveEntry(key) {
    counts.lookups++;
    let v = rawEntry(key, active);
    if (v !== undefined && v !== null) { counts.hits++; return v; }
    if (active !== FALLBACK) {
      v = rawEntry(key, FALLBACK);
      if (v !== undefined && v !== null) { counts.fallbackHits++; return v; }
    }
    counts.misses++;
    missingKeys[key] = true;
    warnOnce('missing key "' + key + '" (locale ' + active + ', fallback ' + FALLBACK + ')');
    return undefined;
  }

  function interpolate(str, vars, key) {
    if (str.indexOf('{') < 0) return str;
    return str.replace(PLACEHOLDER_RE, (whole, name) => {
      if (vars && Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null) {
        return String(vars[name]);
      }
      missingKeys[key + '#' + name] = true;
      warnOnce('missing interpolation variable {' + name + '} for "' + key + '"');
      return whole; // keep literal placeholder: deterministic + debuggable
    });
  }
  function pluralCategory(n) {
    try {
      if (typeof Intl !== 'undefined' && Intl.PluralRules) {
        return new Intl.PluralRules(active === FALLBACK || !meta[active] || meta[active].pseudo ? FALLBACK : active)
          .select(Number(n));
      }
    } catch (e) { /* fall through */ }
    return (Number(n) === 1) ? 'one' : 'other';
  }

  function selectPlural(entry, vars, key) {
    let n = 0;
    if (vars && typeof vars.n === 'number' && isFinite(vars.n)) n = vars.n;
    else if (typeof vars === 'number' && isFinite(vars)) n = vars;
    let cat = pluralCategory(n);
    if (!(cat in entry)) cat = 'other';
    const form = entry[cat];
    if (typeof form !== 'string') {
      missingKeys[key] = true;
      warnOnce('plural entry "' + key + '" lacks a usable form for category ' + cat);
      return '[key]';
    }
    return interpolate(form, vars, key);
  }

  function t(key, vars) {
    if (typeof key !== 'string' || !key) return '';
    const entry = resolveEntry(key);
    let out;
    if (entry === undefined) out = '[' + String(key) + ']';
    else if (typeof entry === 'string') out = interpolate(entry, vars, key);
    else if (typeof entry === 'object') out = selectPlural(entry, vars, key);
    else out = '[' + String(key) + ']';
    const m = meta[active];
    if (m && m.pseudo && typeof out === 'string') out = pseudoTransform(out, m.markers);
    return out;
  }

  function has(key, locale) {
    if (typeof key !== 'string' || !key) return false;
    const loc = locale || active;
    let v = rawEntry(key, loc);
    if ((v === undefined || v === null) && loc !== FALLBACK) v = rawEntry(key, FALLBACK);
    return v !== undefined && v !== null;
  }

  // ---- content-name resolution (registry-mediated identity) ----
  function snakeCase(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // Any reference form (numeric legacy index, legacy string key like the
  // ENEMY_DEFS object key, shorthand 'dirt', full 'core:dirt') -> stable
  // registry id. Falls back to the core-shorthand derivation for kinds whose
  // definitions are not mirrored (e.g. NPC kinds beyond the seeded set).
  function stableRefOf(kind, ref) {
    const R = TC.Registry;
    if (R && typeof R.legacyToStable === 'function') {
      try {
        const s = R.legacyToStable(kind, ref);
        if (s) return s;
      } catch (e) { /* guarded */ }
    }
    if (typeof ref === 'string') {
      if (ref.indexOf(':') >= 0) return ref;
      return 'core:' + snakeCase(ref);
    }
    return null;
  }

  function contentKey(kind, ref, field) {
    const stable = stableRefOf(kind, ref);
    if (!stable) return null;
    return kind + '.' + stable.replace(':', '.') + '.' + field;
  }

  function contentName(kind, ref) {
    const key = contentKey(String(kind == null ? '' : kind), ref, 'name');
    if (!key) return String(ref == null ? '' : ref);
    const out = t(key);
    if (out !== '[' + key + ']') return out;
    // Last-resort bridge: frozen English def metadata (identity-grade, never
    // authoritative presentation for NEW content). The coverage validator
    // guarantees this path stays cold for all registered content.
    const def = TC.Registry && typeof TC.Registry.get === 'function'
      ? TC.Registry.get(String(kind), ref) : null;
    if (def && typeof def.name === 'string' && def.name) return def.name;
    return out;
  }

  function contentDescription(kind, ref) {
    const key = contentKey(String(kind == null ? '' : kind), ref, 'description');
    if (!key || !has(key)) return null;
    return t(key);
  }

  // ---- locale switching ----
  function updateDocumentLocale() {
    try {
      const lang = active === FALLBACK ? 'en' : active.toLowerCase();
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.lang = lang;
      }
      if (typeof document !== 'undefined' && has('app.title')) {
        document.title = t('app.title');
      }
    } catch (e) { /* DOM-less contexts stay valid */ }
  }

  function emitLocaleChanged(from, to) {
    const E = TC.Events;
    if (E && E.EVENT && E.EVENT.LocaleChanged && typeof E.emit === 'function') {
      try { E.emit(E.EVENT.LocaleChanged, { from: from, to: to }); } catch (e) {}
    }
  }

  function isRegistered(id) {
    return !!catalogs[id];
  }

  function setLocale(locale) {
    if (!isRegistered(locale)) return false;
    const prev = active;
    explicitChoice = true;
    if (prev === locale) { persistChoice(); return true; }
    active = locale;
    persistChoice();
    updateDocumentLocale();
    emitLocaleChanged(prev, locale);
    return true;
  }

  function persistChoice() {
    // Preference lives OUTSIDE world/character saves by design (TC.Settings).
    try {
      if (TC.Settings && typeof TC.Settings.set === 'function') {
        TC.Settings.set('locale', active);
      }
    } catch (e) { /* persistence must never break switching */ }
  }

  function getLocale() { return active; }
  function getFallbackLocale() { return FALLBACK; }

  function availableLocales(includeDev) {
    const out = [];
    for (const id in catalogs) {
      if (!includeDev && meta[id] && meta[id].dev) continue;
      out.push(id);
    }
    return out.sort();
  }

  function localeMeta(id) {
    const m = meta[id];
    return m ? { name: m.name, nativeName: m.nativeName, dev: !!m.dev, pseudo: !!m.pseudo } : null;
  }

  // Apply the persisted preference exactly once per page load. Locale files
  // call this after registering so boot order never matters. An explicit
  // setLocale earlier in the same session wins over the stored value.
  function restore() {
    if (restore.done) return getLocale();
    restore.done = true;
    let saved = null;
    try { saved = TC.Settings ? TC.Settings.get('locale', null) : null; } catch (e) {}
    if (!explicitChoice) {
      if (typeof saved === 'string' && saved !== active && isRegistered(saved)) {
        const prev = active;
        active = saved;
        updateDocumentLocale();
        emitLocaleChanged(prev, saved);
      } else if (saved != null && !isRegistered(saved)) {
        warnOnce('stored locale "' + saved + '" is not registered; keeping ' + FALLBACK);
        try { if (TC.Settings) TC.Settings.set('locale', FALLBACK); } catch (e) {}
      }
    }
    updateDocumentLocale();
    return getLocale();
  }

  // ---- validation & diagnostics ----
  function validate() {
    const errors = [];
    const warnings = [];
    if (!isRegistered(FALLBACK)) {
      errors.push('fallback locale "' + FALLBACK + '" is not registered');
      return { ok: false, errors: errors, warnings: warnings };
    }
    const base = catalogs[FALLBACK];
    let total = 0;
    for (const key in base) {
      if (!Object.prototype.hasOwnProperty.call(base, key)) continue;
      if (base[key] == null) { warnings.push('fallback key "' + key + '" is explicitly empty'); continue; }
      total++;
      if (typeof base[key] === 'object') {
        const forms = base[key];
        if (!forms.other) errors.push('plural entry "' + key + '" lacks the required "other" form');
      }
    }
    for (const loc in catalogs) {
      if (loc === FALLBACK) continue;
      const cat = catalogs[loc];
      if (meta[loc] && meta[loc].pseudo) continue; // derived, not compared
      for (const key in cat) {
        const v = cat[key];
        if (v == null) continue;
        const bv = base[key];
        if (bv == null) { warnings.push('locale "' + loc + '" has key "' + key + '" absent from fallback'); continue; }
        // placeholder consistency across translations
        const bp = placeholders(typeof bv === 'string' ? bv : JSON.stringify(bv));
        const lp = placeholders(typeof v === 'string' ? v : JSON.stringify(v));
        if (bp.sort().join(',') !== lp.sort().join(',')) {
          errors.push('placeholder mismatch for "' + key + '" in "' + loc + '": {' +
            bp.join('},{') + '} vs {' + lp.join('},{') + '}');
        }
      }
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings, fallbackKeys: total };
  }

  function placeholders(s) {
    const out = [];
    let m;
    const re = new RegExp(PLACEHOLDER_RE.source, 'g');
    while ((m = re.exec(s)) !== null) out.push(m[1]);
    return out;
  }

  function missing() {
    return Object.keys(missingKeys).sort().map((k) => {
      const at = k.indexOf('#');
      return at < 0 ? { key: k, locale: active }
        : { key: k.slice(0, at), variable: k.slice(at + 1), locale: active };
    });
  }

  function clearDiagnostics() {
    for (const k in missingKeys) delete missingKeys[k];
    for (const k in warnedMissing) delete warnedMissing[k];
    counts.lookups = counts.hits = counts.fallbackHits = counts.misses = 0;
  }

  function keyCount(locale) {
    const cat = catalogs[locale || FALLBACK];
    if (!cat) return -1;
    let n = 0;
    for (const k in cat) if (Object.prototype.hasOwnProperty.call(cat, k)) n++;
    return n;
  }

  function stats() {
    return {
      locale: active,
      fallback: FALLBACK,
      locales: availableLocales(true),
      keys: keyCount(FALLBACK),
      lookups: counts.lookups,
      hits: counts.hits,
      fallbackHits: counts.fallbackHits,
      misses: counts.misses,
      uniqueMissing: Object.keys(missingKeys).length,
    };
  }

  TC.Localization = {
    FALLBACK_LOCALE: FALLBACK,
    register: register,
    registerPseudoLocale: registerPseudoLocale,
    setLocale: setLocale,
    getLocale: getLocale,
    getFallbackLocale: getFallbackLocale,
    availableLocales: availableLocales,
    localeMeta: localeMeta,
    t: t,
    has: has,
    contentName: contentName,
    contentDescription: contentDescription,
    contentKey: contentKey,
    validate: validate,
    missing: missing,
    clearDiagnostics: clearDiagnostics,
    stats: stats,
    restore: restore,
    isRegistered: isRegistered,
  };
})();

/* save.js — localStorage persistence bridge: SaveCore v2 envelopes with a
   legacy v1 fallback. Saves route through TC.SaveCore when it is loaded
   (atomic envelope under 'tc_save_v2', all registered providers ride along);
   loads prefer the v2 envelope and fall back to the v1 blob with unchanged
   validation, so old saves keep working with zero data loss. */
'use strict';
(function () {
  const TC = window.TC;
  if (!TC.Save) TC.Save = {};

  const KEY = 'tc_save_v1';
  const V2_KEY = 'tc_save_v2';
  const ALL_KEYS = [KEY, V2_KEY, V2_KEY + '.bak', V2_KEY + '.tmp'];
  const FALLBACK_INTERVAL = 30;

  // Pristine baseline for diffing, memoized per seed (generate is deterministic).
  // W1 liquid migration: the baseline is normalized through the same claim
  // conversion the runtime applies at build time (WATER/LAVA tiles -> AIR,
  // liquid owned by the TC.Liquids provider), so imported liquid is not
  // recorded as thousands of spurious AIR diffs. Legacy saves whose diffs
  // still carry WATER ids apply them before import and stay byte-compatible.
  let baseCache = null; // { seed, tiles, walls }
  function baseline(seed) {
    if (!TC.WorldGen || typeof TC.WorldGen.generate !== 'function') return null;
    if (baseCache && baseCache.seed === seed) return baseCache;
    let gen = null;
    try { gen = TC.WorldGen.generate(seed); } catch (e) { return null; }
    if (!gen || !gen.tiles) return null;
    const tiles = gen.tiles;
    const WATER = TC.TILE ? TC.TILE.WATER : -1;
    const LAVA = TC.TILE ? TC.TILE.LAVA : -1;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === WATER || tiles[i] === LAVA) {
        tiles[i] = 0 /* AIR */;
      }
    }
    baseCache = { seed: seed, tiles: tiles, walls: gen.walls || null };
    return baseCache;
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, val) {
    try { window.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) {}
  }

  const CHEST_SLOTS = 20; // max slots per chest container (matches TC.Chests)

  // Optional chests blob: { 'tx,ty': [null | {id,count}, ...up to 20] }.
  function validChests(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    const keys = Object.keys(c);
    for (let i = 0; i < keys.length; i++) {
      const slots = c[keys[i]];
      if (!Array.isArray(slots) || slots.length > CHEST_SLOTS) return false;
      for (let j = 0; j < slots.length; j++) {
        const s = slots[j];
        if (s == null) continue;
        if (typeof s !== 'object' || Array.isArray(s)) return false;
        if (typeof s.id !== 'string' || !s.id) return false;
        if (typeof s.count !== 'number' || !isFinite(s.count) ||
            (s.count | 0) !== s.count || s.count <= 0) return false;
      }
    }
    return true;
  }

  // Optional NPC list: [{ type, x, y }, ...] from TC.NPCs.serialize().
  function validNpcs(n) {
    if (!Array.isArray(n)) return false;
    for (let i = 0; i < n.length; i++) {
      const p = n[i];
      if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
      if (typeof p.x !== 'number' || !isFinite(p.x)) return false;
      if (typeof p.y !== 'number' || !isFinite(p.y)) return false;
    }
    return true;
  }

  // Shared field validation for both storage layouts (v1 blob or flattened
  // envelope): every diff index must fit the current world and every id must
  // be a known tile/wall.
  function validateShape(data) {
    if (typeof data.seed !== 'number' || !isFinite(data.seed)) return false;
    if (!Array.isArray(data.diffs)) return false;

    const maxIdx = TC.CONST.WORLD_W * TC.CONST.WORLD_H;
    const maxId = TC.TILE_DEFS.length - 1;
    for (let i = 0; i < data.diffs.length; i++) {
      const d = data.diffs[i];
      if (!Array.isArray(d) || d.length !== 2) return false;
      const idx = d[0], id = d[1];
      if (typeof idx !== 'number' || (idx | 0) !== idx || idx < 0 || idx >= maxIdx) return false;
      if (typeof id !== 'number' || (id | 0) !== id || id < 0 || id > maxId) return false;
    }

    // Optional wall diffs get the same treatment against the wall table.
    if (data.wallDiffs != null) {
      if (!Array.isArray(data.wallDiffs)) return false;
      const maxWallId = (TC.WALL_DEFS ? TC.WALL_DEFS.length : 0) - 1;
      for (let i = 0; i < data.wallDiffs.length; i++) {
        const d = data.wallDiffs[i];
        if (!Array.isArray(d) || d.length !== 2) return false;
        const idx = d[0], id = d[1];
        if (typeof idx !== 'number' || (idx | 0) !== idx || idx < 0 || idx >= maxIdx) return false;
        if (typeof id !== 'number' || (id | 0) !== id || id < 0 || id > maxWallId) return false;
      }
    }

    if (data.time != null && typeof data.time !== 'number') return false;
    if (data.player != null && typeof data.player !== 'object') return false;
    if (data.chests != null && !validChests(data.chests)) return false;
    if (data.npcs != null && !validNpcs(data.npcs)) return false;
    return true;
  }

  // Diff live tiles/walls against the pristine baseline for the current seed.
  // Returns { diffs, wallDiffs } or null when there is no world/baseline yet.
  TC.Save.computeWorldDiffs = function () {
    if (!TC.world || !TC.world.tiles || TC.worldSeed == null) return null;
    const base = baseline(TC.worldSeed);
    if (!base) return null;

    const tiles = TC.world.tiles;
    const n = Math.min(tiles.length, base.tiles.length);
    const diffs = [];
    for (let i = 0; i < n; i++) {
      if (tiles[i] !== base.tiles[i]) diffs.push([i, tiles[i]]);
    }
    for (let i = n; i < tiles.length; i++) diffs.push([i, tiles[i]]);

    // Wall-layer diffs, same pair shape as diffs; empty when the wall layer
    // is unavailable or nothing changed.
    const wallDiffs = [];
    const walls = TC.world.walls;
    if (walls && base.walls) {
      const wn = Math.min(walls.length, base.walls.length);
      for (let i = 0; i < wn; i++) {
        if (walls[i] !== base.walls[i]) wallDiffs.push([i, walls[i]]);
      }
      for (let i = wn; i < walls.length; i++) wallDiffs.push([i, walls[i]]);
    }
    return { diffs: diffs, wallDiffs: wallDiffs };
  };

  // Legacy v1 payload builder; also backs exportSave() when SaveCore is absent.
  function buildLegacyData() {
    const d = TC.Save.computeWorldDiffs();
    if (!d) return null;
    const data = {
      v: 1,
      seed: TC.worldSeed,
      time: (TC.Sky && typeof TC.Sky.time === 'number') ? TC.Sky.time : 0,
      diffs: d.diffs,
      player: (TC.player && typeof TC.player.serialize === 'function')
        ? TC.player.serialize() : null
    };
    if (d.wallDiffs.length > 0) data.wallDiffs = d.wallDiffs;
    // Chest contents ride along when the Chests registry exists.
    if (TC.Chests && typeof TC.Chests.serialize === 'function') {
      try { data.chests = TC.Chests.serialize(); } catch (e) {}
    }
    // NPC positions ride along when the NPCs registry exists.
    if (TC.NPCs && typeof TC.NPCs.serialize === 'function') {
      try { data.npcs = TC.NPCs.serialize(); } catch (e) {}
    }
    return data;
  }

  // ---- SaveCore providers ----
  // world.core carries seed/time + tile/wall diffs; character.core carries
  // player/chests/npcs. deserialize is an identity pass — main.js applies the
  // pieces to the freshly generated world (see continueGame).
  if (TC.SaveCore && typeof TC.SaveCore.register === 'function') {
    try {
      TC.SaveCore.register('world.core', {
        serialize: function () {
          const d = TC.Save.computeWorldDiffs();
          if (!d) throw new Error('world baseline unavailable');
          const data = {
            seed: TC.worldSeed,
            time: (TC.Sky && typeof TC.Sky.time === 'number') ? TC.Sky.time : 0,
            diffs: d.diffs
          };
          if (d.wallDiffs.length > 0) data.wallDiffs = d.wallDiffs;
          return data;
        },
        deserialize: function (d) { return d; }
      });
      TC.SaveCore.register('character.core', {
        serialize: function (ctx) {
          let chests = null, npcs = null;
          if (TC.Chests && typeof TC.Chests.serialize === 'function') {
            try { chests = TC.Chests.serialize(); } catch (e) {}
          }
          if (TC.NPCs && typeof TC.NPCs.serialize === 'function') {
            try { npcs = TC.NPCs.serialize(); } catch (e) {}
          }
          return {
            player: (ctx.player && typeof ctx.player.serialize === 'function')
              ? ctx.player.serialize() : null,
            chests: chests,
            npcs: npcs
          };
        },
        deserialize: function (d) { return d; }
      });
    } catch (e) {
      console.warn('[TC.Save] SaveCore provider registration skipped:', e && e.message);
    }
  }

  // Flatten an envelope back into the legacy-shaped object main.js consumes,
  // keeping the raw envelope around for provider dispatch. Returns null when
  // the world section is missing or malformed so the caller can fall back.
  function flattenEnvelope(env) {
    if (!env || typeof env !== 'object') return null;
    if (!env.world || !env.world.core) return null;
    const w = env.world.core.data;
    if (!w || typeof w !== 'object' || !Array.isArray(w.diffs)) return null;
    const c = (env.character && env.character.core) ? env.character.core.data : null;

    const out = {
      seed: (typeof w.seed === 'number' && isFinite(w.seed)) ? w.seed :
        ((env.metadata && typeof env.metadata.seed === 'number') ? env.metadata.seed : null),
      time: (typeof w.time === 'number') ? w.time : 0,
      diffs: w.diffs,
      player: (c && c.player != null) ? c.player : null,
      chests: (c && c.chests != null) ? c.chests : null,
      npcs: (c && c.npcs != null) ? c.npcs : null
    };
    if (Array.isArray(w.wallDiffs) && w.wallDiffs.length > 0) out.wallDiffs = w.wallDiffs;
    out.__envelope = env;
    return validateShape(out) ? out : null;
  }

  // Gather current game state and persist. Returns true on success.
  TC.Save.save = function () {
    if (!TC.world || !TC.world.tiles || TC.worldSeed == null) return false;
    // SaveCore path: atomic v2 envelope including every registered provider.
    if (TC.SaveCore && typeof TC.SaveCore.saveNow === 'function') {
      try { return !!TC.SaveCore.saveNow(V2_KEY); } catch (e) { return false; }
    }
    const data = buildLegacyData();
    if (!data) return false;
    return storageSet(KEY, JSON.stringify(data));
  };

  // Read + fully validate the legacy v1 blob. Returns data or null.
  function loadLegacy() {
    const raw = storageGet(KEY);
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (!data || typeof data !== 'object' || data.v !== 1) return null;
    if (!validateShape(data)) return null;
    return data;
  }

  // Parse and validate the stored save: prefer the v2 envelope, fall back to
  // the v1 blob. Returns data or null.
  TC.Save.load = function () {
    if (TC.SaveCore && typeof TC.SaveCore.loadFrom === 'function') {
      let env = null;
      try { env = TC.SaveCore.loadFrom(V2_KEY); } catch (e) { env = null; }
      if (env) {
        const flat = flattenEnvelope(env);
        if (flat) return flat;
      }
    }
    return loadLegacy();
  };

  TC.Save.hasSave = function () {
    for (let i = 0; i < ALL_KEYS.length; i++) {
      if (storageGet(ALL_KEYS[i])) return true;
    }
    return false;
  };

  TC.Save.deleteSave = function () {
    for (let i = 0; i < ALL_KEYS.length; i++) storageRemove(ALL_KEYS[i]);
  };

  // Export the live game state as a JSON string (v2 envelope when SaveCore is
  // available, else the legacy v1 shape). Returns null when unavailable.
  TC.Save.exportSave = function () {
    if (TC.SaveCore && typeof TC.SaveCore.exportString === 'function') {
      try { return TC.SaveCore.exportString(); } catch (e) { return null; }
    }
    const data = buildLegacyData();
    return data ? JSON.stringify(data) : null;
  };

  // Import a previously exported string and stage it for the next load.
  // Returns true when the string was accepted and stored.
  TC.Save.importSave = function (str) {
    if (typeof str !== 'string' || !str) return false;
    if (TC.SaveCore && typeof TC.SaveCore.importString === 'function') {
      // Legacy v1 exports stay on the v1 key: converting them here would
      // park an unloadable {systems.legacy} envelope under the v2 key that
      // flattenEnvelope cannot read back.
      let parsed = null;
      try { parsed = JSON.parse(str); } catch (e) { return false; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          TC.SaveCore.isLegacyBlob(parsed)) {
        if (parsed.v !== 1 || !validateShape(parsed)) return false;
        return storageSet(KEY, JSON.stringify(parsed));
      }
      try {
        const env = TC.SaveCore.importString(str);
        return storageSet(V2_KEY, JSON.stringify(env));
      } catch (e) { return false; }
    }
    // No SaveCore: accept only a well-formed legacy v1 blob.
    let data;
    try { data = JSON.parse(str); } catch (e) { return false; }
    if (!data || typeof data !== 'object' || data.v !== 1) return false;
    if (!validateShape(data)) return false;
    return storageSet(KEY, JSON.stringify(data));
  };

  // Periodic autosave while a world is live; failures are silent.
  // W22: a joined network client holds a presentation mirror, never world
  // truth — autosaving it would corrupt the local save with replicated
  // state, so client sessions are skipped here (single gate, no wraps).
  let acc = 0;
  TC.Save.autosave = function (dt) {
    const interval = (TC.CONST && TC.CONST.AUTOSAVE_INTERVAL) || FALLBACK_INTERVAL;
    if (!TC.world || !TC.world.tiles || !TC.player) { acc = 0; return; }
    if (TC.NetClient && TC.NetClient.drivesTick && TC.NetClient.drivesTick()) {
      acc = 0; return;
    }
    acc += dt;
    if (acc >= interval) {
      acc = 0;
      TC.Save.save();
    }
  };
})();

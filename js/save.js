/* save.js — localStorage persistence: full-world diffs + player state. */
'use strict';
(function () {
  const TC = window.TC;
  if (!TC.Save) TC.Save = {};

  const KEY = 'tc_save_v1';
  const FALLBACK_INTERVAL = 30;

  // Pristine baseline for diffing, memoized per seed (generate is deterministic).
  let baseCache = null; // { seed, tiles, walls }
  function baseline(seed) {
    if (!TC.WorldGen || typeof TC.WorldGen.generate !== 'function') return null;
    if (baseCache && baseCache.seed === seed) return baseCache;
    let gen = null;
    try { gen = TC.WorldGen.generate(seed); } catch (e) { return null; }
    if (!gen || !gen.tiles) return null;
    baseCache = { seed: seed, tiles: gen.tiles, walls: gen.walls || null };
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

  // Gather current game state and persist. Returns true on success.
  TC.Save.save = function () {
    if (!TC.world || !TC.world.tiles || TC.worldSeed == null) return false;
    const base = baseline(TC.worldSeed);
    if (!base) return false;

    const tiles = TC.world.tiles;
    const n = Math.min(tiles.length, base.tiles.length);
    const diffs = [];
    for (let i = 0; i < n; i++) {
      if (tiles[i] !== base.tiles[i]) diffs.push([i, tiles[i]]);
    }
    for (let i = n; i < tiles.length; i++) diffs.push([i, tiles[i]]);

    const data = {
      v: 1,
      seed: TC.worldSeed,
      time: (TC.Sky && typeof TC.Sky.time === 'number') ? TC.Sky.time : 0,
      diffs: diffs,
      player: (TC.player && typeof TC.player.serialize === 'function')
        ? TC.player.serialize() : null
    };
    // Optional wall-layer diffs, same pair shape as diffs; omitted when the
    // wall layer is unavailable or nothing changed.
    const walls = TC.world.walls;
    if (walls && base.walls) {
      const wn = Math.min(walls.length, base.walls.length);
      const wallDiffs = [];
      for (let i = 0; i < wn; i++) {
        if (walls[i] !== base.walls[i]) wallDiffs.push([i, walls[i]]);
      }
      for (let i = wn; i < walls.length; i++) wallDiffs.push([i, walls[i]]);
      if (wallDiffs.length > 0) data.wallDiffs = wallDiffs;
    }
    // Chest contents ride along when the Chests registry exists.
    if (TC.Chests && typeof TC.Chests.serialize === 'function') {
      try { data.chests = TC.Chests.serialize(); } catch (e) {}
    }
    // NPC positions ride along when the NPCs registry exists.
    if (TC.NPCs && typeof TC.NPCs.serialize === 'function') {
      try { data.npcs = TC.NPCs.serialize(); } catch (e) {}
    }
    return storageSet(KEY, JSON.stringify(data));
  };

  // Parse and validate the stored save. Returns data or null.
  TC.Save.load = function () {
    const raw = storageGet(KEY);
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (!data || typeof data !== 'object' || data.v !== 1) return null;
    if (typeof data.seed !== 'number' || !isFinite(data.seed)) return null;
    if (!Array.isArray(data.diffs)) return null;

    // Dimensions come from CONST (worldgen is deterministic), so validate that
    // every diff index fits the current world and every id is a known tile.
    const maxIdx = TC.CONST.WORLD_W * TC.CONST.WORLD_H;
    const maxId = TC.TILE_DEFS.length - 1;
    for (let i = 0; i < data.diffs.length; i++) {
      const d = data.diffs[i];
      if (!Array.isArray(d) || d.length !== 2) return null;
      const idx = d[0], id = d[1];
      if (typeof idx !== 'number' || (idx | 0) !== idx || idx < 0 || idx >= maxIdx) return null;
      if (typeof id !== 'number' || (id | 0) !== id || id < 0 || id > maxId) return null;
    }

    // Optional wall diffs get the same treatment against the wall table.
    if (data.wallDiffs != null) {
      if (!Array.isArray(data.wallDiffs)) return null;
      const maxWallId = (TC.WALL_DEFS ? TC.WALL_DEFS.length : 0) - 1;
      for (let i = 0; i < data.wallDiffs.length; i++) {
        const d = data.wallDiffs[i];
        if (!Array.isArray(d) || d.length !== 2) return null;
        const idx = d[0], id = d[1];
        if (typeof idx !== 'number' || (idx | 0) !== idx || idx < 0 || idx >= maxIdx) return null;
        if (typeof id !== 'number' || (id | 0) !== id || id < 0 || id > maxWallId) return null;
      }
    }

    if (data.time != null && typeof data.time !== 'number') return null;
    if (data.player != null && typeof data.player !== 'object') return null;
    if (data.chests != null && !validChests(data.chests)) return null;
    if (data.npcs != null && !validNpcs(data.npcs)) return null;
    return data;
  };

  TC.Save.hasSave = function () {
    return !!storageGet(KEY);
  };

  TC.Save.deleteSave = function () {
    storageRemove(KEY);
  };

  // Periodic autosave while a world is live; failures are silent.
  let acc = 0;
  TC.Save.autosave = function (dt) {
    const interval = (TC.CONST && TC.CONST.AUTOSAVE_INTERVAL) || FALLBACK_INTERVAL;
    if (!TC.world || !TC.world.tiles || !TC.player) { acc = 0; return; }
    acc += dt;
    if (acc >= interval) {
      acc = 0;
      TC.Save.save();
    }
  };
})();

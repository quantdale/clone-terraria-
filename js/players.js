/* players.js — TC.Players: multi-player identity authority (W22 / NET-001+).

   WHY: substantial legacy code reads the TC.player singleton. This module adds
   a deliberate multi-player registry WITHOUT a destructive rewrite:

     - every authoritative player has a stable id ('p1', 'p2', ...) assigned by
       the session that owns the world;
     - exactly one registered player is PRIMARY: TC.player keeps pointing at it,
       so single-player code paths are untouched (zero behavior change when no
       network session exists);
     - multiplayer-sensitive code (net server/client, movement system) uses
       TC.Players.all()/get(id) and never derives authority from the singleton;
     - teardown is explicit: remove(id) unregisters, and resetForNewWorld()
       drops every non-primary entity so sessions cannot leak across worlds.

   The registry stores live Player instances plus per-entity metadata:
     { id, player, remote, clientId, name }

   Headless-safe: zero Canvas/DOM dependency. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const MAX_PLAYERS = 8;
  const entries = new Map(); // id -> {id, player, remote, clientId, name}
  let primaryId = null;
  let nextOrdinal = 1;

  function assertPlayer(p) {
    return !!(p && typeof p === 'object' && isFinite(p.x) && isFinite(p.y));
  }

  function Players() {}

  // Register an existing Player instance under a stable id. Options:
  //   { id?, remote?, clientId?, name?, primary? }
  // The FIRST local registration becomes primary automatically; TC.player is
  // repointed only when a primary is explicitly declared or auto-elected.
  Players.create = function (player, opts) {
    opts = opts || {};
    if (!assertPlayer(player)) return null;
    if (entries.size >= MAX_PLAYERS) return null;
    let id = opts.id;
    if (typeof id !== 'string' || !id || entries.has(id)) {
      do { id = 'p' + (nextOrdinal++); } while (entries.has(id));
    }
    const rec = {
      id: id,
      player: player,
      remote: !!opts.remote,
      clientId: (typeof opts.clientId === 'string') ? opts.clientId : null,
      name: (typeof opts.name === 'string' && opts.name) ? opts.name : ('Player ' + id.slice(1)),
    };
    entries.set(id, rec);
    const wantPrimary = opts.primary === true ||
      (primaryId === null && !rec.remote);
    if (wantPrimary) Players.setPrimary(id);
    return rec;
  };

  Players.remove = function (id) {
    if (!entries.has(id)) return false;
    entries.delete(id);
    if (primaryId === id) {
      primaryId = null;
      // re-elect the first LOCAL player, never a remote mirror
      for (const rec of entries.values()) {
        if (!rec.remote) { Players.setPrimary(rec.id); break; }
      }
      if (primaryId === null) {
        // only remotes remain: keep the singleton pointing at nothing rather
        // than letting legacy code mutate a mirror through it
        TC.player = null;
      }
    }
    return true;
  };

  Players.get = function (id) {
    const rec = entries.get(id);
    return rec ? rec.player : null;
  };

  Players.entry = function (id) {
    return entries.get(id) || null;
  };

  Players.idOf = function (player) {
    for (const rec of entries.values()) if (rec.player === player) return rec.id;
    return null;
  };

  Players.all = function () {
    const out = [];
    for (const rec of entries.values()) out.push(rec.player);
    return out;
  };

  Players.entries = function () {
    return Array.from(entries.values());
  };

  Players.count = function () { return entries.size; };

  Players.primaryId = function () { return primaryId; };
  Players.primary = function () {
    return primaryId ? Players.get(primaryId) : null;
  };
  Players.setPrimary = function (id) {
    const rec = entries.get(id);
    if (!rec || rec.remote) return false;
    primaryId = id;
    TC.player = rec.player;   // compatibility alias stays authoritative
    return true;
  };

  Players.isRemote = function (id) {
    const rec = entries.get(id);
    return !!(rec && rec.remote);
  };

  // Session/world teardown: everything except the caller-designated keeper
  // (usually the primary local player) is dropped; stale ids cannot survive.
  Players.retainOnly = function (keepIds) {
    const keep = new Set(keepIds || []);
    for (const id of Array.from(entries.keys())) {
      if (!keep.has(id)) entries.delete(id);
    }
    if (primaryId && !entries.has(primaryId)) {
      primaryId = null;
      for (const rec of entries.values()) {
        if (!rec.remote) { Players.setPrimary(rec.id); break; }
      }
    }
    if (!TC.player && primaryId) TC.player = Players.get(primaryId);
  };

  Players.resetForNewWorld = function () {
    // World swap: entities die with the old world object graph. The host
    // re-registers whoever survives the transition.
    entries.clear();
    primaryId = null;
    nextOrdinal = 1;
  };

  Players.MAX = MAX_PLAYERS;

  TC.Players = Players;
})();

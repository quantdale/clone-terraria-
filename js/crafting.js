/* crafting.js — station detection + recipe logic. Pure logic, no DOM. */
'use strict';
(function () {
  const TC = window.TC;
  TC.Crafting = {};

  // tile id -> station name
  const STATION_TILES = {};
  STATION_TILES[TC.TILE.WORKBENCH] = 'workbench';
  STATION_TILES[TC.TILE.FURNACE] = 'furnace';
  STATION_TILES[TC.TILE.ANVIL] = 'anvil';

  const SCAN_RADIUS = 5; // tiles around the player tile

  // Scan tiles within SCAN_RADIUS of the player tile; returns Set of station names.
  TC.Crafting.stationsNearby = function (px, py) {
    const found = new Set();
    const world = TC.world;
    if (!world || typeof world.get !== 'function') return found;
    const ts = TC.CONST.TS;
    const ptx = Math.floor(px / ts);
    const pty = Math.floor(py / ts);
    for (let dy = -SCAN_RADIUS; dy <= SCAN_RADIUS; dy++) {
      for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
        const tx = ptx + dx, ty = pty + dy;
        if (tx < 0 || ty < 0 || tx >= world.width || ty >= world.height) continue;
        const name = STATION_TILES[world.get(tx, ty)];
        if (name) found.add(name);
      }
    }
    return found;
  };

  // All recipes currently craftable with this inventory + station set.
  TC.Crafting.available = function (inv, stations) {
    const out = [];
    const recipes = TC.RECIPES || [];
    for (let i = 0; i < recipes.length; i++) {
      if (TC.Crafting.canCraft(recipes[i], inv, stations)) out.push(recipes[i]);
    }
    return out;
  };

  // Station requirement met (when a station set is given) and all costs covered.
  TC.Crafting.canCraft = function (r, inv, stations) {
    if (!r || !inv || typeof inv.count !== 'function') return false;
    if (r.station && stations && !stations.has(r.station)) return false;
    const cost = r.cost || {};
    for (const id in cost) {
      if ((inv.count(id) | 0) < cost[id]) return false;
    }
    return true;
  };

  // Consume costs, grant outputs. Returns false without net consumption
  // if the output would not fit in the inventory.
  TC.Crafting.craft = function (r, inv, stations) {
    if (!r || !inv || typeof inv.add !== 'function' || typeof inv.remove !== 'function') return false;
    if (!TC.Crafting.canCraft(r, inv, stations)) return false;
    const cost = r.cost || {};
    for (const id in cost) inv.remove(id, cost[id]);
    let leftover = inv.add(r.out, r.n);
    if (typeof leftover !== 'number' || !isFinite(leftover)) leftover = 0;
    if (leftover !== 0) {
      // didn't fit — undo the partial add and put the costs back
      if (leftover > 0 && leftover < r.n) inv.remove(r.out, r.n - leftover);
      for (const id in cost) inv.add(id, cost[id]);
      return false;
    }
    return true;
  };
})();

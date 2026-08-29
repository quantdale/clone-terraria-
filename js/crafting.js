/* crafting.js — station detection + recipe logic. Pure logic, no DOM.
   Ingredients: cost values are numbers ({iron_bar: 8}) or objects
   ({any_bar: {tag: 'core:bar', n: 5}} / {x: {id: 'iron_bar', n: 2}}) matched
   against ITEM_DEFS[].tags arrays. Station needs: recipe.station is a name or
   an any-of name array; recipe.stationTags lists all-of capability tags. */
'use strict';
(function () {
  const TC = window.TC;
  TC.Crafting = {};

  // tile id -> station name
  const STATION_TILES = {};
  STATION_TILES[TC.TILE.WORKBENCH] = 'workbench';
  STATION_TILES[TC.TILE.FURNACE] = 'furnace';
  STATION_TILES[TC.TILE.ANVIL] = 'anvil';

  // station name -> capability tags it provides
  const STATION_TAGS = {
    workbench: ['station:workbench'],
    furnace: ['station:furnace'],
    anvil: ['station:anvil']
  };

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

  // ---- ingredients -----------------------------------------------------

  function normN(v) {
    const n = (typeof v === 'number' && isFinite(v)) ? Math.floor(v) : 0;
    return n > 0 ? n : 1;
  }

  // Normalize r.cost into [{id|tag, key, n}] entries; unknown shapes skipped.
  function ingredientsOf(r) {
    const out = [];
    const cost = (r && r.cost) || {};
    for (const key in cost) {
      const v = cost[key];
      if (v && typeof v === 'object') {
        if (typeof v.tag === 'string' && v.tag) {
          out.push({ tag: v.tag, key: key, n: normN(v.n) });
        } else if (typeof v.id === 'string' && v.id) {
          out.push({ id: v.id, key: key, n: normN(v.n) });
        }
      } else {
        const n = (typeof v === 'number' && isFinite(v)) ? Math.floor(v) : 0;
        if (n > 0 && key) out.push({ id: key, key: key, n: n });
      }
    }
    return out;
  }

  TC.Crafting.ingredientsOf = function (r) { return ingredientsOf(r); };

  function hasTag(id, tag) {
    const d = TC.ITEM_DEFS ? TC.ITEM_DEFS[id] : null;
    const tags = (d && Array.isArray(d.tags)) ? d.tags : null;
    if (!tags) return false;
    for (let i = 0; i < tags.length; i++) {
      if (tags[i] === tag) return true;
    }
    return false;
  }

  // Total count of inventory items carrying `tag`; needs raw slots.
  function countTag(inv, tag) {
    if (!inv || !Array.isArray(inv.slots)) return 0;
    let total = 0;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i];
      if (s && s.id && s.count > 0 && hasTag(s.id, tag)) total += s.count;
    }
    return total;
  }

  function haveCount(inv, ing) {
    return ing.tag ? countTag(inv, ing.tag) : ((inv.count(ing.id) | 0));
  }

  // ---- stations --------------------------------------------------------

  // Required all-of capability tags for a recipe. A plain string station
  // resolves through STATION_TAGS; an any-of name ARRAY contributes no tags
  // (its membership is checked by name in stationOk); recipe.stationTags
  // entries are always required verbatim. Returns a Set.
  TC.Crafting.STATION_TAGS = STATION_TAGS;
  TC.Crafting.stationTags = function (recipe) {
    const req = new Set();
    if (!recipe) return req;
    if (typeof recipe.station === 'string' && recipe.station) {
      const tags = STATION_TAGS[recipe.station];
      if (tags) {
        for (let i = 0; i < tags.length; i++) req.add(tags[i]);
      } else {
        req.add('station:' + recipe.station);
      }
    }
    if (Array.isArray(recipe.stationTags)) {
      for (const t of recipe.stationTags) {
        if (typeof t === 'string' && t) req.add(t);
      }
    }
    return req;
  };

  // Union of the capability tags a nearby-station Set provides.
  function availableTags(stations) {
    const out = new Set();
    if (stations instanceof Set) {
      stations.forEach((name) => {
        const tags = STATION_TAGS[name];
        if (tags) for (let i = 0; i < tags.length; i++) out.add(tags[i]);
      });
    }
    return out;
  }

  function stationOk(r, stations, haveTags) {
    if (!stations || !(stations instanceof Set)) return true;   // unrestricted caller
    const st = r.station;
    if (Array.isArray(st)) {                 // any-of names
      let any = false;
      for (let i = 0; i < st.length; i++) {
        if (typeof st[i] === 'string' && stations.has(st[i])) { any = true; break; }
      }
      if (!any) return false;
    } else if (typeof st === 'string' && st && !stations.has(st)) {
      return false;
    }
    const req = TC.Crafting.stationTags(r);  // all-of tags
    if (req.size) {
      if (!haveTags) haveTags = availableTags(stations);
      for (const t of req) {
        if (!haveTags.has(t)) return false;
      }
    }
    return true;
  }

  // W14 progression gate: recipes may carry a `requires` condition in the
  // shared TC.Progression grammar (flag string or compound object).
  function progressionOk(r) {
    const c = r && r.requires;
    if (c == null || c === '') return true;
    if (TC.Progression && typeof TC.Progression.test === 'function') {
      try { return !!TC.Progression.test(c); } catch (e) { return false; }
    }
    return false;
  }

  // ---- recipe index (precomputed once per RECIPES table identity/length) --

  let indexCache = null;   // {source, length, list: [{r, ings}]}

  function indexedRecipes() {
    const recipes = TC.RECIPES;
    if (!Array.isArray(recipes)) return [];
    if (!indexCache || indexCache.source !== recipes ||
        indexCache.length !== recipes.length) {
      const list = new Array(recipes.length);
      for (let i = 0; i < recipes.length; i++) {
        const r = recipes[i];
        list[i] = { r: r, ings: ingredientsOf(r) };
      }
      indexCache = { source: recipes, length: recipes.length, list: list };
    }
    return indexCache.list;
  }

  function countsOk(ings, inv) {
    if (!inv || typeof inv.count !== 'function') return false;
    for (let i = 0; i < ings.length; i++) {
      if (haveCount(inv, ings[i]) < ings[i].n) return false;
    }
    return true;
  }

// All recipes currently craftable with this inventory + station set +
   // progression. Uses the precomputed recipe index; O(recipes) per call.
   TC.Crafting.available = function (inv, stations) {
     const out = [];
     const entries = indexedRecipes();
     let haveTags = null;
     for (let i = 0; i < entries.length; i++) {
       const e = entries[i];
       if (!progressionOk(e.r)) continue;
       if (!stationOk(e.r, stations, haveTags)) continue;
       if (!countsOk(e.ings, inv)) continue;
       out.push(e.r);
     }
     return out;
   };

  // Station requirement met (when a station set is given), progression gate
  // passed and all costs covered — plain ids by count, tagged ingredients
  // across matching items.
  TC.Crafting.canCraft = function (r, inv, stations) {
    if (!r || !inv || typeof inv.count !== 'function') return false;
    if (!progressionOk(r)) return false;
    if (!stationOk(r, stations, null)) return false;
    return countsOk(ingredientsOf(r), inv);
  };

  // Why can't this recipe be crafted right now? Returns null when craftable,
  // else one of: 'progression' | 'station' | 'costs'. UI hints consume the
  // coarse reason without reaching into recipe internals.
  TC.Crafting.lockReason = function (r, inv, stations) {
    if (!r) return 'costs';
    if (!progressionOk(r)) return 'progression';
    if (stations && !stationOk(r, stations, null)) return 'station';
    if (!inv || typeof inv.count !== 'function') return 'costs';
    const ings = ingredientsOf(r);
    for (let i = 0; i < ings.length; i++) {
      if (haveCount(inv, ings[i]) < ings[i].n) return 'costs';
    }
    return null;
  };

  // Remove up to n tagged items (slot order), recording exact removals so a
  // rollback can restore them. Mutates raw slots; emits one aggregate event.
  function removeTagged(inv, tag, n) {
    const removed = [];
    if (!Array.isArray(inv.slots)) return removed;
    for (let i = 0; i < inv.slots.length && n > 0; i++) {
      const s = inv.slots[i];
      if (s && s.id && s.count > 0 && hasTag(s.id, tag)) {
        const take = Math.min(s.count, n);
        s.count -= take;
        n -= take;
        removed.push({ id: s.id, n: take });
        if (s.count <= 0) inv.slots[i] = null;
      }
    }
    if (removed.length) {
      try {
        if (TC.Events && typeof TC.Events.emit === 'function' &&
            TC.Events.EVENT && TC.Events.EVENT.InventoryChanged) {
          let total = 0;
          for (let i = 0; i < removed.length; i++) total += removed[i].n;
          TC.Events.emit(TC.Events.EVENT.InventoryChanged,
            { reason: 'craft-remove', tag: tag, count: total });
        }
      } catch (e) { /* never block crafting on listeners */ }
    }
    return removed;
  }

  // Transactional craft: validate everything, consume all inputs, grant the
  // output. On rollback (output would not fit) inputs are restored exactly
  // and nothing else changes. Returns bool.
  TC.Crafting.craft = function (r, inv, stations) {
    if (!r || !inv || typeof inv.add !== 'function' || typeof inv.remove !== 'function') return false;
    if (!TC.Crafting.canCraft(r, inv, stations)) return false;

    const ings = ingredientsOf(r);
    const removed = [];                       // [{id,n}] for exact rollback
    for (let i = 0; i < ings.length; i++) {
      const g = ings[i];
      if (g.tag) {
        const part = removeTagged(inv, g.tag, g.n);
        for (let j = 0; j < part.length; j++) removed.push(part[j]);
      } else {
        inv.remove(g.id, g.n);
        removed.push({ id: g.id, n: g.n });
      }
    }

    const n = (typeof r.n === 'number' && isFinite(r.n) && r.n > 0) ? Math.floor(r.n) : 1;
    let leftover = inv.add(r.out, n);
    if (typeof leftover !== 'number' || !isFinite(leftover)) leftover = 0;
    if (leftover !== 0) {
      // didn't fit — undo the partial add and put the costs back
      if (leftover > 0 && leftover < n) inv.remove(r.out, n - leftover);
      for (let i = removed.length - 1; i >= 0; i--) inv.add(removed[i].id, removed[i].n);
      return false;
    }

    try {
      if (TC.Events && typeof TC.Events.emit === 'function' &&
          TC.Events.EVENT && TC.Events.EVENT.CraftCompleted) {
        TC.Events.emit(TC.Events.EVENT.CraftCompleted,
          { outId: r.out, count: n, source: 'crafting.js' });
      }
    } catch (e) { /* listeners must never break crafting */ }
    return true;
  };
})();

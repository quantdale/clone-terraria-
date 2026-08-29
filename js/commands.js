/* commands.js — TC.Commands: canonical mutation transactions (ARCHITECTURE.md §4).

   Every authoritative mutation goes through a named command: validate once,
   then apply as one coherent step. validate() gates every mutable precondition
   so a passing validate means apply commits; apply() exceptions are caught and
   reported as {ok:false,error} — never disguised as success.

   API:
     TC.Commands.register(name, {validate(ctx)?, apply(ctx)})  throws on duplicate name
     TC.Commands.unregister(name) -> bool
     TC.Commands.has(name) -> bool
     TC.Commands.names() -> string[]
     TC.Commands.submit(name, ctx) -> {ok:true,result}|{ok:false,error}

   Queue (deterministic FIFO intake — drained once per tick by the scheduler's
   'commands' phase; see runtime.js):
     TC.Commands.enqueue(name, ctx)  -> {queued:true} | {queued:false,error}
     TC.Commands.drain()             -> results[] for this batch
     TC.Commands.pending()           -> number of queued commands
     TC.Commands.clearQueue()        -> dropped count (world teardown)
     TC.Commands.stats()             -> {processed,rejected,dropped,maxDepth}

   Queue contract:
     - FIFO order is preserved exactly;
     - a command enqueued DURING a drain executes in the NEXT tick's drain
       (snapshot semantics — no unbounded same-tick recursion);
     - the queue is bounded (MAX_QUEUE); overflow drops newest and counts it;
     - clearQueue() runs on every world transition (WorldLoaded) so queued
       commands can never leak across worlds.

   Predefined vocabulary (? marks optional fields):
     MineTile     {tx,ty,toolPower,tool?,player?,dt?}
     MineWall     {tx,ty,toolPower,tool?,player?,dt?}
     PlaceTile    {tx,ty,item,player?,slot?}
     PlaceWall    {tx,ty,wallId?|item?,player?,slot?}
     UseItem      {player,slot,aimX?,aimY?,dt?}
     MoveItem     {fromInv,fromSlot,toInv,toSlot,count?}
     EquipItem    {player,item,slot?}
     CraftRecipe  {recipe,inv,stations?}
     InteractTile {tx,ty,player?}

   Events (emitted via TC.Events when present; silently skipped otherwise):
     TileChanged, TileBroken, InventoryChanged, CraftCompleted.

   Behaviors are faithful mirrors of the live paths they are meant to replace:
   MineTile/MineWall follow Player.doMine/doMineWall (break completion matches
   the wiring.js shim; pot/crystal specials ride on World.applyMineDamage via
   loot.js's patch), PlaceTile follows Player.doPlace, EquipItem follows
   Player.doEquip, MoveItem reproduces Inventory.swapOrPlace outcomes,
   CraftRecipe delegates to TC.Crafting, InteractTile follows Player.interact
   with wiring.js surfaces taking precedence. Swapping callers over later is
   behavior-preserving. One deliberate tightening, required by the §4 rule
   that a command commits or fails as a whole: PlaceTile/PlaceWall validate
   that the paying inventory slot (ctx.slot when given, else the first slot
   holding the item) actually holds it — doPlace's hotbar-index consume can
   silently skip, a command may not. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Commands) return;                       // load-once guard

  const TS = (TC.CONST && TC.CONST.TS) || 16;
  const DEFAULT_DT = 1 / 60;                     // one fixed sim step
  const EQUIP_CD = 0.25;                         // mirrors player.js armor swap cooldown
  const TREE_CAP = 400;                          // mirrors player.js fellTree BFS cap

  // ======================================================================
  // Guarded cross-module helpers (siblings land in parallel)
  // ======================================================================

  function tDef(id) { return TC.TILE_DEFS ? TC.TILE_DEFS[id] : null; }
  function iDef(id) { return TC.ITEM_DEFS ? TC.ITEM_DEFS[id] : null; }
  function wDef(id) { return TC.WALL_DEFS ? TC.WALL_DEFS[id] : null; }
  function maxStack(id) { const d = iDef(id); return (d && d.maxStack) || 999; }

  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') { try { TC.Audio.play(name); } catch (e) {} }
  }
  function pBurst(x, y, n, colors, spd) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try { TC.Particles.burst(x, y, n, { colors: colors, speed: spd }); } catch (e) {}
    }
  }
  // Observation only; a missing or misbehaving bus never breaks a transaction.
  function emit(name, payload) {
    if (TC.Events && typeof TC.Events.emit === 'function') {
      try { TC.Events.emit(name, payload); } catch (e) {}
    }
  }

  function getWorld() {
    return (TC.world && typeof TC.world.get === 'function') ? TC.world : null;
  }
  function inBounds(w, tx, ty) {
    return tx >= 0 && ty >= 0 && tx < w.width && ty < w.height;
  }
  // Strict integer check (no silent coercion of garbage input).
  function asInt(v) {
    return (typeof v === 'number' && isFinite(v) && (v | 0) === v) ? v : null;
  }
  function posIn(w, c) {
    const tx = asInt(c.tx), ty = asInt(c.ty);
    return (tx !== null && ty !== null && inBounds(w, tx, ty)) ? [tx, ty] : null;
  }
  function toolPowerOf(c) {
    return (typeof c.toolPower === 'number' && isFinite(c.toolPower) && c.toolPower > 0)
      ? c.toolPower : null;
  }
  function dtOf(c) {
    return (typeof c.dt === 'number' && isFinite(c.dt) && c.dt > 0) ? c.dt : DEFAULT_DT;
  }
  function inReach(player, tx, ty) {
    return !(player && typeof player.inReach === 'function') || !!player.inReach(tx, ty);
  }
  function overlapsPlayer(player, tx, ty) {
    const rx = tx * TS, ry = ty * TS;
    return rx < player.x + player.w && rx + TS > player.x &&
           ry < player.y + player.h && ry + TS > player.y;
  }

  // Remove n of id from a slot; tolerates slot-index or id-based removal
  // (same dual strategy as player.js / loot.js).
  function consumeFromSlot(inv, slotIdx, id, n) {
    if (!inv || typeof inv.remove !== 'function') return false;
    const read = () => {
      if (typeof inv.get !== 'function') return -1;
      const s = inv.get(slotIdx);
      return (s && s.id === id) ? s.count : 0;
    };
    const before = read();
    if (before <= 0) return false;
    try { inv.remove(slotIdx, n); } catch (e) {}
    if (read() === before) { try { inv.remove(id, n); } catch (e) {} }
    return read() < before;
  }
  function findSlotWith(inv, id) {
    if (!inv || typeof inv.get !== 'function' || !inv.slots) return -1;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.get(i);
      if (s && s.id === id && s.count > 0) return i;
    }
    return -1;
  }
  // Inventory slot index clamped against the inventory's own size.
  function slotIn(inv, v) {
    const k = asInt(v);
    const size = (inv && inv.slots && inv.slots.length) ? inv.slots.length : 50;
    return (k !== null && k >= 0 && k < size) ? k : -1;
  }
  // Which single slot a placement pays from: an explicit slot when given
  // (must hold the item), else the first slot holding it. -1 means the item
  // is not reachable from one slot — placements never go through unpaid
  // (doPlace's hotbar-index consume can silently skip; commands may not).
  function resolveConsumeSlot(inv, item, slot) {
    if (slot != null) {
      const k = slotIn(inv, slot);
      const s = (k >= 0) ? inv.get(k) : null;
      return (s && s.id === item) ? k : -1;
    }
    return findSlotWith(inv, item);
  }

  // ======================================================================
  // Registry + submit
  // ======================================================================

  const registry = new Map();

  function register(name, def) {
    if (typeof name !== 'string' || !name) {
      throw new Error('Commands.register: command name required');
    }
    if (!def || typeof def.apply !== 'function') {
      throw new Error('Commands.register(' + name + '): apply(ctx) required');
    }
    if (def.validate != null && typeof def.validate !== 'function') {
      throw new Error('Commands.register(' + name + '): validate must be a function');
    }
    if (registry.has(name)) {
      throw new Error('Commands.register: duplicate command "' + name + '"');
    }
    registry.set(name, { validate: def.validate || null, apply: def.apply });
  }

  function unregister(name) { return registry.delete(name); }
  function has(name) { return registry.has(name); }
  function names() { return Array.from(registry.keys()); }

  // validate-then-apply. validate returns true (or undefined) to pass, a
  // string reason or false to reject. apply's return value becomes result;
  // a throw becomes {ok:false,error} — reported, never faked.
  function submit(name, ctx) {
    const cmd = registry.get(name);
    if (!cmd) return { ok: false, error: 'unknown-command:' + name };
    const c = (ctx && typeof ctx === 'object') ? ctx : {};
    if (cmd.validate) {
      let verdict;
      try {
        verdict = cmd.validate(c);
      } catch (e) {
        return { ok: false, error: 'validate-exception:' + ((e && e.message) || e) };
      }
      if (verdict !== true && verdict !== undefined) {
        return { ok: false, error: (typeof verdict === 'string') ? verdict : 'validation-failed' };
      }
    }
    try {
      return { ok: true, result: cmd.apply(c) };
    } catch (e) {
      return { ok: false, error: 'apply-exception:' + ((e && e.message) || e) };
    }
  }

  // ======================================================================
  // Shared break completion — the exactly-once tail of every tile break
  // ======================================================================

  // Mirrors the union of the vanilla mine tail (player.js), the wiring.js
  // break-completion shim and the loot.js pot/crystal handling. Writing AIR
  // is idempotent: when wiring.js's shim already completed the break inside
  // applyMineDamage this is a no-op; when it is absent we finish the break
  // ourselves. Pot loot / crystal completion arrive through the patched
  // applyMineDamage when loot.js is loaded (its POT/LIFE_CRYSTAL handling is
  // not separately exposed, so routing through the world method IS the hook).
  function completeTileBreak(w, tx, ty, id, td) {
    const cx = (tx + 0.5) * TS, cy = (ty + 0.5) * TS;
    if (w.get(tx, ty) !== TC.TILE.AIR) w.set(tx, ty, TC.TILE.AIR);   // set() emits TileChanged
    if (id === TC.TILE.CHEST && TC.Chests && typeof TC.Chests.spill === 'function') {
      try { TC.Chests.spill(tx, ty); } catch (e) {}       // scatter stored items first
    }
    if (td.drop && TC.Items && typeof TC.Items.spawnDrop === 'function') {
      try { TC.Items.spawnDrop(cx, cy, td.drop, 1); } catch (e) {}
    }
    sfx('break');
    pBurst(cx, cy, 10, td.colors, 120);
    // Exactly-once: World.set above already emitted TileChanged; here we emit
    // only TileBroken, with the canonical id field plus the legacy tile field
    // loot.js reads (player.js's live path emits {tx,ty,id} today).
    emit('TileBroken', { tx: tx, ty: ty, id: id, tile: id, drop: td.drop || null });
    return { broken: true, tile: id, drop: td.drop || null };
  }

  // Axes on TRUNK fell the connected tree instead of chipping one tile
  // (mirror of Player.fellTree: 8-dir trunk flood capped at TREE_CAP, leaf
  // ring removed via raw writes, one wood drop per trunk tile).
  function fellTreeAt(w, tx, ty) {
    const T = TC.TILE;
    const DIR = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

    const trunks = [];
    const seen = new Set();
    const q = [[tx, ty]];
    seen.add(tx + ',' + ty);
    while (q.length && trunks.length < TREE_CAP) {
      const cur = q.pop();
      trunks.push(cur);
      for (let i = 0; i < 8; i++) {
        const nx = cur[0] + DIR[i][0], ny = cur[1] + DIR[i][1];
        const k = nx + ',' + ny;
        if (!seen.has(k) && w.get(nx, ny) === T.TRUNK) {
          seen.add(k);
          q.push([nx, ny]);
        }
      }
    }

    const leaves = [];
    const seenL = new Set();
    for (let i = 0; i < trunks.length; i++) {
      for (let d = 0; d < 8; d++) {
        const lx = trunks[i][0] + DIR[d][0], ly = trunks[i][1] + DIR[d][1];
        const k = lx + ',' + ly;
        if (!seen.has(k) && !seenL.has(k) && w.get(lx, ly) === T.LEAVES) {
          seenL.add(k);
          leaves.push([lx, ly]);
        }
      }
    }

    const remove = (rx, ry) => {
      w.setRaw(rx, ry, T.AIR);                   // setRaw emits TileChanged
      if (TC.Lighting && typeof TC.Lighting.onTileChanged === 'function') {
        try { TC.Lighting.onTileChanged(rx, ry); } catch (e) {}
      }
    };
    for (let i = 0; i < trunks.length; i++) {
      remove(trunks[i][0], trunks[i][1]);
      if (TC.Items && typeof TC.Items.spawnDrop === 'function') {
        try {
          TC.Items.spawnDrop(trunks[i][0] * TS + TS / 2, trunks[i][1] * TS + TS / 2, 'wood', 1);
        } catch (e) {}
      }
    }
    for (let i = 0; i < leaves.length; i++) remove(leaves[i][0], leaves[i][1]);

    sfx('break');
    pBurst(tx * TS + TS / 2, ty * TS + TS / 2, 12, ['#7a5230', '#6a4628', '#2f8f38'], 130);
    emit('TileBroken', { tx: tx, ty: ty, tile: T.TRUNK, drop: 'wood', felled: true, trunks: trunks.length });
    return { broken: true, felled: true, tile: T.TRUNK, drop: 'wood', trunks: trunks.length, leaves: leaves.length };
  }

  // ======================================================================
  // MineTile
  // ======================================================================

  function validateMineTile(c) {
    const w = getWorld();
    if (!w || typeof w.applyMineDamage !== 'function') return 'no-world';
    const pos = posIn(w, c);
    if (!pos) return 'bad-target';
    const tp = toolPowerOf(c);
    if (tp === null) return 'bad-tool-power';
    const id = w.get(pos[0], pos[1]);
    const td = tDef(id);
    // Same minability rule as Player.doMine.
    if (!td || id === TC.TILE.AIR || !(td.hardness > 0) || td.hardness >= 9999 ||
        (td.minPower || 0) > tp ||
        (c.tool != null && td.tool !== 'any' && td.tool !== c.tool)) {
      return 'not-minable';
    }
    if (!inReach(c.player, pos[0], pos[1])) return 'out-of-reach';
    return true;
  }

  function applyMineTile(c) {
    const w = getWorld();
    const tx = c.tx, ty = c.ty;
    const id = w.get(tx, ty);
    const td = tDef(id);
    if (c.tool === 'axe' && id === TC.TILE.TRUNK) return fellTreeAt(w, tx, ty);
    const amt = (c.toolPower / 100) * dtOf(c) / td.hardness;
    const broke = !!w.applyMineDamage(tx, ty, amt);
    if (!broke) return { broken: false };
    return completeTileBreak(w, tx, ty, id, td);
  }

  // ======================================================================
  // MineWall — picks only, only where no minable tile sits; walls drop nothing
  // ======================================================================

  function validateMineWall(c) {
    const w = getWorld();
    if (!w || typeof w.getWall !== 'function' ||
        typeof w.applyWallDamage !== 'function' || typeof w.setWall !== 'function') {
      return 'no-world';
    }
    if (!TC.WALL_DEFS) return 'no-wall-defs';
    if (c.tool != null && c.tool !== 'pick') return 'wrong-tool';
    const pos = posIn(w, c);
    if (!pos) return 'bad-target';
    const tp = toolPowerOf(c);
    if (tp === null) return 'bad-tool-power';
    const id = w.get(pos[0], pos[1]);
    const td = tDef(id);
    if (!(id === TC.TILE.AIR || (td && td.replaceable))) return 'tile-in-way';
    const wallId = w.getWall(pos[0], pos[1]);
    const wd = wDef(wallId);
    if (!(wallId > 0) || !wd || !(wd.hardness > 0)) return 'no-wall';
    if (!inReach(c.player, pos[0], pos[1])) return 'out-of-reach';
    return true;
  }

  function applyMineWall(c) {
    const w = getWorld();
    const tx = c.tx, ty = c.ty;
    const wallId = w.getWall(tx, ty);
    const wd = wDef(wallId);
    const amt = (c.toolPower / 100) * dtOf(c) / wd.hardness;
    const broke = !!w.applyWallDamage(tx, ty, amt);
    if (!broke) return { broken: false };
    // applyWallDamage may or may not remove the wall itself; make sure it's gone.
    try { w.setWall(tx, ty, TC.WALL.NONE); } catch (e) {}
    try { w.clearWallDamage(tx, ty); } catch (e) {}
    sfx('break');
    pBurst((tx + 0.5) * TS, (ty + 0.5) * TS, 10, [wd.color], 120);
    // No TileChanged here: World.setWall intentionally emits nothing and the
    // live doMineWall path matches — a wall-only payload without `id` would
    // corrupt wiring.js's plate/timer registry keyed off tile events.
    return { broken: true, wall: wallId };
  }

  // ======================================================================
  // PlaceTile
  // ======================================================================

  function validatePlaceTile(c) {
    const w = getWorld();
    if (!w || typeof w.set !== 'function') return 'no-world';
    const pos = posIn(w, c);
    if (!pos) return 'bad-target';
    const idef = iDef(c.item);
    if (!idef || idef.tile == null) return 'unknown-block-item';
    const cur = w.get(pos[0], pos[1]);
    const cd = tDef(cur);
    if (!(cur === TC.TILE.AIR || (cd && cd.replaceable))) return 'target-occupied';

    // Needs an orthogonal non-air neighbour to attach to (as Player.doPlace).
    const around = [
      w.get(pos[0] + 1, pos[1]), w.get(pos[0] - 1, pos[1]),
      w.get(pos[0], pos[1] + 1), w.get(pos[0], pos[1] - 1)
    ];
    let anchored = false;
    for (let i = 0; i < 4; i++) {
      if (around[i] != null && around[i] !== TC.TILE.AIR) { anchored = true; break; }
    }
    if (!anchored) return 'unanchored';

    if (c.player) {
      if (!inReach(c.player, pos[0], pos[1])) return 'out-of-reach';
      const pd = tDef(idef.tile);
      if (pd && pd.solid && overlapsPlayer(c.player, pos[0], pos[1])) return 'blocked-by-player';
      if (!c.player.inventory) return 'no-inventory';
      // Coherent transaction: never conjure blocks — the paying slot must
      // hold the item before anything is placed.
      const paySlot = resolveConsumeSlot(c.player.inventory, c.item, c.slot);
      if (paySlot < 0) return 'missing-item';
      c._placeSlot = paySlot;                    // internal: resolved slot for apply
    }
    return true;
  }

  function applyPlaceTile(c) {
    const w = getWorld();
    const idef = iDef(c.item);
    w.set(c.tx, c.ty, idef.tile);                // set() emits TileChanged
    if (c.player && c.player.inventory) {
      consumeFromSlot(c.player.inventory, c._placeSlot, c.item, 1);
      // Inventory.remove already emitted InventoryChanged — no re-emit.
    }
    sfx('place');
    return { placed: true, tile: idef.tile };
  }

  // ======================================================================
  // PlaceWall — no live gameplay caller yet (walls are worldgen-only today);
  // defined so wall placement has a canonical home when it ships.
  // ======================================================================

  function resolveWallId(c) {
    let wallId = c.wallId;
    if (wallId == null && c.item) {
      const d = iDef(c.item);
      wallId = d ? d.wall : null;
    }
    const k = asInt(wallId);
    const max = TC.WALL_DEFS ? TC.WALL_DEFS.length : 0;
    return (k !== null && k > 0 && k < max) ? k : null;
  }

  function validatePlaceWall(c) {
    const w = getWorld();
    if (!w || typeof w.setWall !== 'function' || typeof w.getWall !== 'function') return 'no-world';
    if (!TC.WALL_DEFS) return 'no-wall-defs';
    const pos = posIn(w, c);
    if (!pos) return 'bad-target';
    const wallId = resolveWallId(c);
    if (wallId === null) return 'bad-wall-id';
    if (w.getWall(pos[0], pos[1]) !== TC.WALL.NONE) return 'wall-occupied';
    if (c.player && c.item) {
      if (!c.player.inventory) return 'no-inventory';
      const paySlot = resolveConsumeSlot(c.player.inventory, c.item, c.slot);
      if (paySlot < 0) return 'missing-item';
      c._placeSlot = paySlot;                    // internal: resolved slot for apply
    }
    return true;
  }

  function applyPlaceWall(c) {
    const w = getWorld();
    const wallId = resolveWallId(c);
    w.setWall(c.tx, c.ty, wallId);               // walls ride no tile event (see applyMineWall)
    if (c.player && c.item && c.player.inventory) {
      consumeFromSlot(c.player.inventory, c._placeSlot, c.item, 1);
      // Inventory.remove already emitted InventoryChanged — no re-emit.
    }
    sfx('place');
    return { placed: true, wall: wallId };
  }

  // ======================================================================
  // EquipItem — mirror of Player.doEquip (worn piece returns to the slot)
  // ======================================================================

  function validateEquipItem(c) {
    const p = c.player;
    if (!p || !p.inventory || !p.equipment) return 'no-player';
    const def = iDef(c.item);
    if (!def || def.kind !== 'armor') return 'not-armor';
    if (def.slot !== 'head' && def.slot !== 'body' && def.slot !== 'feet') return 'unknown-slot';
    if ((p.equipCd || 0) > 0) return 'cooldown';
    const useSlot = (c.slot != null) ? slotIn(p.inventory, c.slot)
                                     : findSlotWith(p.inventory, c.item);
    if (useSlot < 0) return 'item-not-in-inventory';
    const s = p.inventory.get(useSlot);
    if (!s || s.id !== c.item) return 'item-not-in-slot';
    c._equipSlot = useSlot;                      // internal: resolved slot for apply
    return true;
  }

  function applyEquipItem(c) {
    const p = c.player;
    const inv = p.inventory;
    const slot = iDef(c.item).slot;
    const useSlot = c._equipSlot;
    const worn = p.equipment[slot] ? { id: p.equipment[slot], count: 1 } : null;
    let done = false;
    if (typeof inv.swapOrPlace === 'function') {
      try { inv.swapOrPlace(useSlot, worn); done = true; } catch (e) {}
    }
    if (!done && inv.slots) {                    // fallback: write the slot directly
      try { inv.slots[useSlot] = worn; done = true; } catch (e) {}
    }
    if (!done) throw new Error('inventory refused the armor swap');
    p.equipment[slot] = c.item;
    p.equipCd = EQUIP_CD;
    sfx('pickup');
    // swapOrPlace already emitted InventoryChanged — no re-emit.
    return { equipped: true, slot: slot, previous: worn ? worn.id : null };
  }

  // ======================================================================
  // MoveItem — reproduces Inventory.swapOrPlace outcomes arithmetically:
  // merge into a same-id stack, fill an empty slot, or (full stacks only)
  // swap two different stacks between the slots.
  // ======================================================================

  function planMove(c) {
    const fi = c.fromInv, ti = c.toInv;
    const fromSlot = slotIn(fi, c.fromSlot);
    const toSlot = slotIn(ti, c.toSlot);
    if (fromSlot < 0 || toSlot < 0) return { error: 'bad-slot' };
    if (fi === ti && fromSlot === toSlot) return { error: 'same-slot' };
    const src = fi.get(fromSlot);
    if (!src || !(src.count > 0)) return { error: 'empty-source-slot' };
    let take = src.count;
    if (c.count != null) {
      take = (typeof c.count === 'number' && isFinite(c.count)) ? Math.floor(c.count) : 0;
      if (take < 1) return { error: 'bad-count' };
      if (take > src.count) return { error: 'count-exceeds-stack' };
    }
    const dst = ti.get(toSlot);
    let capacity;
    if (!dst) capacity = maxStack(src.id);
    else if (dst.id === src.id) capacity = maxStack(src.id) - dst.count;
    else capacity = (take === src.count) ? Infinity : 0;   // swap needs the full stack
    const moved = Math.min(take, capacity);
    if (!(moved > 0)) return { error: 'dest-full' };
    return { fromSlot: fromSlot, toSlot: toSlot, src: src, dst: dst, moved: moved };
  }

  function validateMoveItem(c) {
    const fi = c.fromInv, ti = c.toInv;
    if (!fi || !ti || typeof fi.get !== 'function' || typeof ti.get !== 'function' ||
        !Array.isArray(fi.slots) || !Array.isArray(ti.slots)) {
      return 'bad-inventory';
    }
    return planMove(c).error || true;
  }

  function applyMoveItem(c) {
    const fi = c.fromInv, ti = c.toInv;
    const plan = planMove(c);
    if (plan.error) throw new Error(plan.error);   // validate passed; must not happen
    const src = plan.src, dst = plan.dst, moved = plan.moved;
    const id = src.id;
    if (dst && dst.id !== id) {                    // full-stack swap
      const srcCount = src.count;
      fi.slots[plan.fromSlot] = { id: dst.id, count: dst.count };
      ti.slots[plan.toSlot] = { id: id, count: srcCount };
    } else {
      if (dst) dst.count += moved;
      else ti.slots[plan.toSlot] = { id: id, count: moved };
      if (moved >= src.count) fi.slots[plan.fromSlot] = null;
      else src.count -= moved;
    }
    emit('InventoryChanged', { id: id, count: moved, from: plan.fromSlot, to: plan.toSlot });
    return { moved: moved, id: id };
  }

  // ======================================================================
  // ContainerMove — W23 canonical player<->chest transaction. One authority
  // for every container transfer: local UI drag/quick-move AND networked
  // intents both land here, so conservation rules cannot fork.
  //   ctx {player, tx, ty, from:'inv'|'chest', to:'inv'|'chest',
  //        fromSlot, toSlot?, count?}
  // Omitted toSlot = authoritative auto-placement (merge then first empty).
  // ======================================================================

  function chestAt(tx, ty) {
    if (!TC.Chests || typeof TC.Chests.get !== 'function') return null;
    const slots = TC.Chests.get(tx, ty);
    if (!Array.isArray(slots)) return null;
    return { slots: slots, get: function (i) { return slots[i]; } };
  }

  function validateContainerMove(c) {
    const w = getWorld();
    if (!w || typeof w.get !== 'function') return 'no-world';
    if (!posIn(w, c)) return 'bad-target';
    if (!inReach(c.player, c.tx, c.ty)) return 'out-of-reach';
    if (!TC.TILE || w.get(c.tx, c.ty) !== TC.TILE.CHEST) return 'not-a-chest';
    const inv = c.player && c.player.inventory;
    if (!inv || !Array.isArray(inv.slots)) return 'no-player';
    const chest = chestAt(c.tx, c.ty);
    if (!chest) return 'no-container';
    if (c.from !== 'inv' && c.from !== 'chest') return 'bad-endpoint';
    if (c.to !== 'inv' && c.to !== 'chest') return 'bad-endpoint';
    if (c.from === c.to) return 'same-endpoint';
    c._fromInv = (c.from === 'inv') ? inv : chest;
    c._toInv = (c.to === 'inv') ? inv : chest;
    c._auto = (c.toSlot == null);
    if (!c._auto) {
      return planMove({ fromInv: c._fromInv, toInv: c._toInv,
        fromSlot: c.fromSlot, toSlot: c.toSlot, count: c.count }).error || true;
    }
    // auto mode validation: source stack exists, count sane, SOMETHING fits.
    const fi = c._fromInv;
    const fs = slotIn(fi, c.fromSlot);
    if (fs < 0) return 'bad-slot';
    const src = fi.get(fs);
    if (!src || !(src.count > 0)) return 'empty-source-slot';
    let take = src.count;
    if (c.count != null) {
      take = (typeof c.count === 'number' && isFinite(c.count)) ? Math.floor(c.count) : 0;
      if (take < 1) return 'bad-count';
      if (take > src.count) return 'count-exceeds-stack';
    }
    c._take = take;
    const max = maxStack(src.id);
    const ti = c._toInv;
    let room = 0;
    for (let j = 0; j < ti.slots.length && room < take; j++) {
      const t = ti.slots[j];
      if (!t) room += max;
      else if (t.id === src.id && t !== src) room += max - t.count;
    }
    if (room <= 0) return 'dest-full';
    return true;
  }

  function applyContainerMove(c) {
    const fi = c._fromInv, ti = c._toInv;
    const fs = slotIn(fi, c.fromSlot);
    const src = fi.get(fs);
    let take = (c._auto) ? c._take : Math.min(
      (c.count != null) ? c.count : src.count, src.count);
    const id = src.id;
    const max = maxStack(id);
    let moved = 0;
    if (c._auto) {
      for (let j = 0; j < ti.slots.length && take > 0; j++) {   // merge first
        const t = ti.slots[j];
        if (t && t.id === id && t !== src && t.count < max) {
          const m = Math.min(max - t.count, take);
          t.count += m; take -= m; moved += m;
        }
      }
      for (let j = 0; j < ti.slots.length && take > 0; j++) {   // then empty
        if (!ti.slots[j]) {
          const m = Math.min(max, take);
          ti.slots[j] = { id: id, count: m };
          take -= m; moved += m;
        }
      }
      if (moved >= src.count) fi.slots[fs] = null;
      else src.count -= moved;
    } else {
      const r = applyMoveItem({ fromInv: fi, toInv: ti,
        fromSlot: c.fromSlot, toSlot: c.toSlot, count: c.count });
      emit('InventoryChanged', { id: id, count: r.moved, from: fs, to: c.toSlot });
      return r;
    }
    if (!(moved > 0)) throw new Error('container-move-nothing-fit');
    emit('InventoryChanged', { id: id, count: moved, from: fs, to: 'auto' });
    return { moved: moved, id: id };
  }

  // ======================================================================
  // CraftRecipe — delegates to TC.Crafting (station set optional)
  // ======================================================================

  function validateCraftRecipe(c) {
    if (!TC.Crafting || typeof TC.Crafting.canCraft !== 'function' ||
        typeof TC.Crafting.craft !== 'function') {
      return 'no-crafting';
    }
    const r = c.recipe;
    if (!r || typeof r !== 'object' || !r.out) return 'bad-recipe';
    const inv = c.inv;
    if (!inv || typeof inv.count !== 'function' || typeof inv.add !== 'function' ||
        typeof inv.remove !== 'function') {
      return 'bad-inventory';
    }
    if (c.stations != null && !(c.stations instanceof Set)) return 'bad-stations';
    if (!TC.Crafting.canCraft(r, inv, c.stations)) return 'cannot-craft';
    return true;
  }

  function applyCraftRecipe(c) {
    const r = c.recipe;
    if (!TC.Crafting.craft(r, c.inv, c.stations)) {
      throw new Error('craft-failed');             // e.g. output did not fit
    }
    // CraftCompleted is emitted canonically by Crafting.craft — no re-emit here.
    return { out: r.out, n: r.n || 1 };
  }

  // ======================================================================
  // InteractTile — wiring surfaces first, then doors, then chests
  // (precedence of the patched Player.interact)
  // ======================================================================

  function validateInteractTile(c) {
    const w = getWorld();
    if (!w || typeof w.get !== 'function' || typeof w.set !== 'function') return 'no-world';
    if (!posIn(w, c)) return 'bad-target';
    if (!inReach(c.player, c.tx, c.ty)) return 'out-of-reach';
    return true;
  }

  function applyInteractTile(c) {
    const w = getWorld();
    const tx = c.tx, ty = c.ty;
    const p = c.player;
    const m = { worldX: (tx + 0.5) * TS, worldY: (ty + 0.5) * TS };

    if (p && TC.Wiring && typeof TC.Wiring.interact === 'function') {
      let handled = false;
      try { handled = !!TC.Wiring.interact(p, m); } catch (e) {}
      if (handled) return { acted: true, action: 'device' };
    }

    const id = w.get(tx, ty);
    const T = TC.TILE;
    if (id === T.DOOR_CLOSED || id === T.DOOR_OPEN) {
      const next = id === T.DOOR_CLOSED ? T.DOOR_OPEN : T.DOOR_CLOSED;
      const nd = tDef(next);
      if (nd && nd.solid && p && !p.dead && overlapsPlayer(p, tx, ty)) {
        return { acted: false, reason: 'blocked' };   // don't shut a door into the player
      }
      w.set(tx, ty, next);                       // set() emits TileChanged
      sfx('place');
      return { acted: true, action: 'door', open: next === T.DOOR_OPEN };
    }
    if (id === T.CHEST && TC.UI && typeof TC.UI.openChest === 'function') {
      try { TC.UI.openChest(tx, ty); } catch (e) {}
      return { acted: true, action: 'chest' };
    }
    return { acted: false, reason: 'nothing-to-interact' };
  }

  // ======================================================================
  // UseItem — dispatches one use of the stack in a slot, mirroring the
  // Player.useHeld switch. Aim defaults to "straight ahead" when the caller
  // has no cursor position to offer.
  // ======================================================================

  function synthMouse(c, p) {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    return {
      worldX: (typeof c.aimX === 'number' && isFinite(c.aimX)) ? c.aimX
        : cx + (p.facing || 1) * TS * 2,
      worldY: (typeof c.aimY === 'number' && isFinite(c.aimY)) ? c.aimY : cy
    };
  }

  function validateUseItem(c) {
    const p = c.player;
    if (!p || !p.inventory || typeof p.inventory.get !== 'function') return 'no-player';
    const slot = slotIn(p.inventory, c.slot);
    if (slot < 0) return 'bad-slot';
    const stack = p.inventory.get(slot);
    if (!stack || !stack.id) return 'empty-slot';
    if (!iDef(stack.id)) return 'unknown-item';
    c._useSlot = slot;                           // internal: resolved slot for apply
    return true;
  }

  function applyUseItem(c) {
    const p = c.player;
    const slot = c._useSlot;
    const stack = p.inventory.get(slot);
    const def = iDef(stack.id);
    const m = synthMouse(c, p);
    const dt = dtOf(c);

    // Continuous integration hooks first (legacy useHeld order): grapple,
    // thrown gear, buckets, crystals/pots, fishing, potions/accessories.
    // These own their own cadence/cooldowns and report whether they consumed
    // the press; they remain simulation behaviors, not transactions.
    const HOOKS = [
      ['grapple', TC.Grapple], ['gear', TC.Gear], ['liquids', TC.Liquids],
      ['loot', TC.Loot], ['fishing', TC.Fishing], ['accessories', TC.Accessories]
    ];
    for (let i = 0; i < HOOKS.length; i++) {
      const mod = HOOKS[i][1];
      if (mod && typeof mod.onUseHeld === 'function') {
        let took = false;
        try { took = !!mod.onUseHeld(p, def, dt); } catch (e) { took = false; }
        if (took) { p.mineTarget = null; return { used: true, action: HOOKS[i][0] }; }
      }
    }

    switch (def.kind) {
      case 'tool': {
        // Mirror doMine: hammers reshape, tools try the tile, picks fall back
        // to the wall behind it. Swing/dig feedback rides the player's own
        // cadence fields so animation + audio match the live path exactly.
        const tx = Math.floor(m.worldX / TS), ty = Math.floor(m.worldY / TS);
        const w = getWorld();
        if (def.tool === 'hammer' && w && typeof w.canShape === 'function' &&
            typeof w.hammer === 'function' && w.canShape(tx, ty)) {
          p.mineTarget = null;
          p.mining = true;
          if (typeof p.startSwing === 'function') p.startSwing(def, true);
          p.mineTick -= dt;
          if (p.mineTick <= 0) {
            p.mineTick = 0.2;
            sfx('dig');
            const tcx2 = (tx + 0.5) * TS, tcy2 = (ty + 0.5) * TS;
            pBurst(tcx2, tcy2, 3, ['#c8c8cf', '#8f8f98'], 70);
            let changed = false;
            try { changed = !!w.hammer(tx, ty); } catch (e) {}
            if (changed) pBurst(tcx2, tcy2, 2, ['#ffffff'], 40);
          }
          return { used: true, action: 'hammer' };
        }
        const sub = { tx: tx, ty: ty, toolPower: def.power, tool: def.tool, player: p, dt: dt };
        const tileTry = submit('MineTile', sub);
        if (tileTry.ok) {
          const r = tileTry.result || {};
          p.mining = true;
          if (typeof p.startSwing === 'function') p.startSwing(def, true);
          if (!r.broken) {
            if (!p.mineTarget || p.mineTarget.tx !== tx || p.mineTarget.ty !== ty) {
              p.mineTarget = { tx: tx, ty: ty, progress: 0 };
              p.mineTick = 0;
            }
            p.mineTick -= dt;
            if (p.mineTick <= 0) {
              p.mineTick = 0.2;
              sfx('dig');
              pBurst((tx + 0.5) * TS, (ty + 0.5) * TS, 3, tDef(r.tile || 0) ? (tDef(r.tile).colors || []) : [], 70);
            }
          } else {
            p.mineTarget = null;
            p.mineTick = 0;
          }
          return { used: true, action: 'mine', mine: tileTry.result };
        }
        if (def.tool === 'pick') {
          const wallTry = submit('MineWall', sub);
          if (wallTry.ok) {
            const r = wallTry.result || {};
            p.mining = true;
            if (typeof p.startSwing === 'function') p.startSwing(def, true);
            if (!r.broken) {
              if (!p.mineTarget || p.mineTarget.tx !== tx || p.mineTarget.ty !== ty) {
                p.mineTarget = { tx: tx, ty: ty, progress: 0 };
                p.mineTick = 0;
              }
              p.mineTick -= dt;
              if (p.mineTick <= 0) {
                p.mineTick = 0.2;
                sfx('dig');
                const wd = TC.WALL_DEFS ? TC.WALL_DEFS[r.wall] : null;
                pBurst((tx + 0.5) * TS, (ty + 0.5) * TS, 3, wd ? [wd.color] : [], 70);
              }
            } else {
              p.mineTarget = null;
              p.mineTick = 0;
            }
            return { used: true, action: 'mine-wall', mine: wallTry.result };
          }
          if (wallTry.error !== 'not-minable' && wallTry.error !== 'no-wall' &&
              wallTry.error !== 'tile-in-way') {
            p.mineTarget = null;
            return { used: false, reason: wallTry.error };
          }
        }
        p.mineTarget = null;
        return { used: false, reason: tileTry.error };
      }
      case 'block': {
        p.mineTarget = null;
        // Actuators attach to a host tile instead of placing (legacy doPlace).
        if (stack.id === 'actuator' && TC.Wiring && typeof TC.Wiring.attachActuatorAt === 'function') {
          try { TC.Wiring.attachActuatorAt(p, m); } catch (e) {}
          return { used: true, action: 'actuator' };
        }
        const tx = Math.floor(m.worldX / TS), ty = Math.floor(m.worldY / TS);
        const r = submit('PlaceTile', { tx: tx, ty: ty, item: stack.id, player: p, slot: slot });
        return r.ok ? { used: true, action: 'place', place: r.result }
                    : { used: false, reason: r.error };
      }
      case 'armor':
        p.mineTarget = null;
        {
          const er = submit('EquipItem', { player: p, item: stack.id, slot: slot });
          return er.ok ? { used: true, action: 'equip' }
                       : { used: false, reason: er.error || 'equip-failed' };
        }
      case 'weapon':
        p.mineTarget = null;
        if (typeof p.doMelee !== 'function') return { used: false, reason: 'player-cannot-melee' };
        if (p.swing && p.swing.item === def) return { used: false, reason: 'cooldown' };   // mid-swing
        p.doMelee(def);
        return { used: true, action: 'melee' };
      case 'ranged':
        p.mineTarget = null;
        if (typeof p.doBow !== 'function') return { used: false, reason: 'player-cannot-shoot' };
        p.doBow(def, m);
        return { used: true, action: 'bow' };
      case 'summon':
        p.mineTarget = null;
        if (typeof p.doSummon !== 'function') return { used: false, reason: 'player-cannot-summon' };
        p.doSummon(def, stack.id);
        return { used: true, action: 'summon' };
      case 'crystal': {
        // Life crystals ride loot.js's hook directly — no recursion into the
        // legacy player.useHeld switch.
        p.mineTarget = null;
        if (TC.Loot && typeof TC.Loot.onUseHeld === 'function') {
          let took = false;
          try { took = !!TC.Loot.onUseHeld(p, def, dt); } catch (e) {}
          return took ? { used: true, action: 'crystal' } : { used: false, reason: 'crystal-refused' };
        }
        return { used: false, reason: 'no-loot-module' };
      }
      default:
        p.mineTarget = null;
        return { used: false, reason: 'inert' };   // materials etc.: no use action
    }
  }

  // ======================================================================
  // ShopBuy / ShopSell — transactional NPC economy (W2). Validate-then-apply
  // guarantees failure mutates nothing: stock, price, purse and capacity are
  // all checked up front; currency leaves exactly once via TC.Economy.pay.
  // ======================================================================

  // Resolve the live stock entry for an NPC kind. Progression-aware rows
  // (requires: flag string or fn) filter through TC.NPCs.shopOf.
  function resolveStockEntry(npcType, itemId) {
    if (!TC.NPCs || typeof TC.NPCs.shopOf !== 'function') return null;
    const stock = TC.NPCs.shopOf(npcType);
    if (!Array.isArray(stock)) return null;
    for (let i = 0; i < stock.length; i++) {
      if (stock[i] && stock[i].itemId === itemId) return stock[i];
    }
    return null;
  }

  // Capacity dry-run: could `n` of id fit without mutating anything?
  function canFit(inv, id, n) {
    if (!inv || !Array.isArray(inv.slots)) return false;
    const max = maxStack(id);
    let room = 0;
    for (let i = 0; i < inv.slots.length && room < n; i++) {
      const s = inv.slots[i];
      if (!s) room += max;
      else if (s.id === id) room += max - s.count;
    }
    return room >= n;
  }

  function shopPriceOf(entry) {
    const base = (entry && typeof entry.price === 'number' && isFinite(entry.price))
      ? Math.max(1, Math.floor(entry.price)) : null;
    if (base != null) return base;
    const d = iDef(entry && entry.itemId);
    return (d && typeof d.value === 'number') ? Math.max(1, d.value) : 1;
  }

  function validateShopBuy(c) {
    const p = c.player;
    if (!p || !p.inventory || !Array.isArray(p.inventory.slots)) return 'no-player';
    if (!c.npcType || typeof c.npcType !== 'string') return 'no-shop';
    if (!iDef(c.itemId)) return 'unknown-item';
    const entry = resolveStockEntry(c.npcType, c.itemId);
    if (!entry) return 'not-in-stock';
    c._price = shopPriceOf(entry);               // internal: resolved price
    if (!TC.Economy || typeof TC.Economy.total !== 'function') return 'no-economy';
    if (TC.Economy.total(p.inventory) < c._price) return 'too-poor';
    if (!canFit(p.inventory, c.itemId, 1)) return 'inventory-full';
    return true;
  }

  function applyShopBuy(c) {
    const inv = c.player.inventory;
    if (!TC.Economy.pay(inv, c._price)) return { bought: false, reason: 'pay-failed' };
    const left = inv.add(c.itemId, 1);
    if (left > 0) {                              // belt & braces: refund + report
      TC.Economy.give(inv, c._price);
      return { bought: false, reason: 'inventory-full' };
    }
    sfx('pickup');
    emit(TC.Events.EVENT.ShopBuy,
      { npcType: c.npcType, itemId: c.itemId, price: c._price });
    return { bought: true, price: c._price };
  }

  // Sell ratio: shopkeepers pay a fifth of the base value, minimum one coin.
  const SELL_RATIO = 0.2;
  function sellPriceOf(id) {
    const d = iDef(id);
    const v = d && typeof d.value === 'number' ? d.value : 0;
    return v > 0 ? Math.max(1, Math.floor(v * SELL_RATIO)) : 0;
  }

  function validateShopSell(c) {
    const p = c.player;
    if (!p || !p.inventory) return 'no-player';
    const slot = slotIn(p.inventory, c.slot);
    if (slot < 0) return 'bad-slot';
    const stack = p.inventory.get(slot);
    if (!stack || !stack.id) return 'empty-slot';
    if (!iDef(stack.id)) return 'unknown-item';
    if (stack.id.indexOf('coin_') === 0) return 'cannot-sell-currency';
    const unit = sellPriceOf(stack.id);
    if (unit <= 0) return 'not-sellable';
    const want = (c.count == null) ? stack.count : asInt(c.count);
    if (want == null || want <= 0 || want > stack.count) return 'bad-count';
    c._slot = slot;                              // internal: resolved slot/count/price
    c._count = want;
    c._unit = unit;
    return true;
  }

  function applyShopSell(c) {
    const inv = c.player.inventory;
    const stack = inv.get(c._slot);
    if (!stack || !stack.id) return { sold: false, reason: 'empty-slot' };
    const id = stack.id;
    consumeFromSlot(inv, c._slot, id, c._count);
    const proceeds = TC.Economy.give(inv, c._unit * c._count);
    sfx('pickup');
    emit(TC.Events.EVENT.ShopSell,
      { itemId: id, count: c._count, unitPrice: c._unit, proceeds: proceeds });
    return { sold: true, proceeds: proceeds };
  }

  // ======================================================================
  // Registration
  // ======================================================================

  // =====================================================================
  // Command queue — deterministic FIFO intake drained by the scheduler's
  // 'commands' phase (runtime.js calls drain() once per fixed tick).
  // Snapshot semantics: commands enqueued during a drain wait for the next
  // tick. Bounded: overflow drops the newest command and counts it.
  // =====================================================================

  const MAX_QUEUE = 256;
  let queue = [];
  let draining = false;
  const qstats = { processed: 0, rejected: 0, dropped: 0, maxDepth: 0 };

  function enqueue(name, ctx) {
    if (typeof name !== 'string' || !registry.has(name)) {
      return { queued: false, error: 'unknown-command:' + name };
    }
    if (queue.length >= MAX_QUEUE) {
      qstats.dropped++;
      return { queued: false, error: 'queue-full' };
    }
    queue.push({ name: name, ctx: (ctx && typeof ctx === 'object') ? ctx : {} });
    if (queue.length > qstats.maxDepth) qstats.maxDepth = queue.length;
    return { queued: true };
  }

  // Drain the current batch in FIFO order. Commands enqueued while draining
  // are left in `queue` for the NEXT tick (snapshot taken up front).
  function drain() {
    if (draining) return [];                 // re-entrant guard: never recurse
    draining = true;
    const batch = queue;
    queue = [];
    const results = new Array(batch.length);
    for (let i = 0; i < batch.length; i++) {
      const r = submit(batch[i].name, batch[i].ctx);
      results[i] = { name: batch[i].name, result: r };
      if (r && r.ok) {
        qstats.processed++;
        if (TC.Runtime && typeof TC.Runtime._incCommandOk === 'function') try { TC.Runtime._incCommandOk(); } catch (e) {}
      } else {
        qstats.rejected++;
        if (TC.Runtime && typeof TC.Runtime._incCommandReject === 'function') try { TC.Runtime._incCommandReject(); } catch (e) {}
      }
    }
    draining = false;
    return results;
  }

  function pendingCount() { return queue.length; }

  // World teardown / state transition: drop everything pending. Returns the
  // number of commands discarded.
  function clearQueue() {
    const n = queue.length;
    queue = [];
    if (n) qstats.dropped += n;
    return n;
  }

  function queueStats() {
    return { processed: qstats.processed, rejected: qstats.rejected,
             dropped: qstats.dropped, maxDepth: qstats.maxDepth };
  }

  register('MineTile', { validate: validateMineTile, apply: applyMineTile });
  register('MineWall', { validate: validateMineWall, apply: applyMineWall });
  register('PlaceTile', { validate: validatePlaceTile, apply: applyPlaceTile });
  register('PlaceWall', { validate: validatePlaceWall, apply: applyPlaceWall });
  register('UseItem', { validate: validateUseItem, apply: applyUseItem });
  register('MoveItem', { validate: validateMoveItem, apply: applyMoveItem });
  register('EquipItem', { validate: validateEquipItem, apply: applyEquipItem });
  register('CraftRecipe', { validate: validateCraftRecipe, apply: applyCraftRecipe });
  register('InteractTile', { validate: validateInteractTile, apply: applyInteractTile });
  register('ShopBuy', { validate: validateShopBuy, apply: applyShopBuy });
  register('ShopSell', { validate: validateShopSell, apply: applyShopSell });
  register('ContainerMove', { validate: validateContainerMove, apply: applyContainerMove });

  TC.Commands = { register, unregister, has, names, submit,
                  enqueue, drain, pending: pendingCount, clearQueue, stats: queueStats };

  // Foundation scheduler: the queue drains in the canonical 'commands' phase
  // (runtime.js ticks the scheduler; main.js no longer calls update directly).
  // Gated to live simulation: queued intents never execute on title/pause.
  if (TC.Systems && typeof TC.Systems.register === 'function') {
    TC.Systems.register('commands', 'core.queue', {
      update: function (dt) { drain(); }
    }, {
      when: function () { return TC.state === 'playing' && !(TC.UI && TC.UI.paused); }
    });
  }
  // A fresh world never inherits queued intents from the previous one.
  if (TC.Events && typeof TC.Events.on === 'function' && TC.Events.EVENT && TC.Events.EVENT.WorldLoaded) {
    try { TC.Events.on(TC.Events.EVENT.WorldLoaded, function () { clearQueue(); }); } catch (e) {}
  }
})();

/* systems.js — update-phase scheduler (TC.Systems), render layers
   (TC.RenderLayers), boot-task registry. Pure registry/scheduling module:
   it owns no game state and only calls registered callbacks. */
'use strict';
(function () {
  const TC = (window.TC = window.TC || {});

  // ---- guarded invocation ----

  // Run fn isolated: a throw is logged (first few per entry, then silenced —
  // the count keeps growing and is visible via list()) and the caller goes on.
  function guarded(label, errState, fn) {
    try {
      return fn();
    } catch (err) {
      errState.errors++;
      if (errState.errors <= 3) console.error('[TC] ' + label + ':', err);
      return undefined;
    }
  }

  // ===================================================================
  // TC.Systems — fixed update phases + registered systems
  // ===================================================================

  // Phase order follows docs/ARCHITECTURE.md §6 and maps onto js/main.js
  // step() (legacy calls migrate into phases gradually):
  //   input         TC.Input polls, TC.UI.update (runs on title too)
  //   commands      command queue (MineTile/PlaceTile/...) — future home
  //   movement      TC.Player.update intent (physics folded in today)
  //   physics       collision resolution (inside entity updates today)
  //   projectiles   TC.Projectiles.update / TC.Combat arrows
  //   ai            TC.Enemies.spawnDirector/update, TC.NPCs.update
  //   combat        TC.Combat.update, status/buff ticks
  //   environment   TC.Sky, TC.Biomes, TC.Music, TC.MiniMap
  //   liquidsWiring TC.World.update (water flow, chunk rebuild, mechanisms)
  //   items         TC.Items.update (magnet + pickup)
  //   progression   TC.Save.autosave, spawn/progress rules, TC.Lighting
  //   eventsFlush   drain the event queue after all mutation is done
  const PHASES = ['input', 'commands', 'movement', 'physics', 'projectiles', 'ai',
                  'combat', 'environment', 'liquidsWiring', 'items', 'progression', 'eventsFlush'];

  const byPhase = new Map(PHASES.map((p) => [p, new Map()])); // phase -> name -> entry
  const resolvedCache = new Map();                            // phase -> {order, cycle, cycleLogged}
  let cacheDirty = true;
  let regSeq = 0;

  function invalidate() { cacheDirty = true; }

  function normalizeNames(v) {
    if (!v) return [];
    return (Array.isArray(v) ? v : [v]).map(String);
  }

  // Register a system into a phase. sys = {init?, update(dt)?}; opts.after /
  // opts.before constrain order within the SAME phase (unknown names, e.g.
  // other-phase ones, are ignored — phases already order those). Duplicate
  // phase/name replaces in place, keeping the original slot. Returns the
  // entry, or null if rejected.
  function registerSystem(phase, name, sys, opts) {
    if (!byPhase.has(phase)) {
      console.warn('[TC.Systems] unknown phase "' + phase + '" — dropped "' + name + '"');
      return null;
    }
    if (typeof name !== 'string' || !name) {
      console.warn('[TC.Systems] register: invalid name');
      return null;
    }
    if (!sys || (typeof sys.init !== 'function' && typeof sys.update !== 'function')) {
      console.warn('[TC.Systems] "' + name + '" needs init() or update(dt) — dropped');
      return null;
    }
    const bucket = byPhase.get(phase);
    let entry = bucket.get(name);
    if (entry) {
      console.warn('[TC.Systems] duplicate "' + phase + '/' + name + '" — replacing in place');
    } else {
      entry = { phase, name, regIndex: regSeq++, inited: false, errors: 0 };
      bucket.set(name, entry);
    }
    entry.sys = sys;
    entry.after = normalizeNames(opts && opts.after);
    entry.before = normalizeNames(opts && opts.before);
    entry.hasInit = typeof sys.init === 'function';
    entry.hasUpdate = typeof sys.update === 'function';
    invalidate();
    return entry;
  }

  // Stable topological sort of one phase: after/before edges, ties broken by
  // registration order. Returns {order, cycle} — cycle lists stuck names.
  function computeOrder(bucket) {
    const names = [...bucket.keys()];
    const indeg = new Map();
    const adj = new Map();
    for (const n of names) { indeg.set(n, 0); adj.set(n, []); }
    for (const e of bucket.values()) {
      for (const a of e.after) {
        if (adj.has(a)) { adj.get(a).push(e.name); indeg.set(e.name, indeg.get(e.name) + 1); }
      }
      for (const b of e.before) {
        if (adj.has(b)) { adj.get(e.name).push(b); indeg.set(b, indeg.get(b) + 1); }
      }
    }
    let ready = names.filter((n) => indeg.get(n) === 0).map((n) => bucket.get(n));
    const order = [];
    while (ready.length) {
      // pick lowest regIndex => stable output for unconstrained systems
      let mi = 0;
      for (let i = 1; i < ready.length; i++) if (ready[i].regIndex < ready[mi].regIndex) mi = i;
      const e = ready.splice(mi, 1)[0];
      order.push(e);
      for (const m of adj.get(e.name)) {
        indeg.set(m, indeg.get(m) - 1);
        if (indeg.get(m) === 0) ready.push(bucket.get(m));
      }
    }
    if (order.length !== names.length) {
      return { order, cycle: names.filter((n) => indeg.get(n) > 0).join(', ') };
    }
    return { order, cycle: null, cycleLogged: false };
  }

  function resolveCached(phase) {
    if (cacheDirty) { resolvedCache.clear(); cacheDirty = false; }
    if (!resolvedCache.has(phase)) resolvedCache.set(phase, computeOrder(byPhase.get(phase)));
    return resolvedCache.get(phase);
  }

  // Resolved execution order for one phase. Throws on constraint cycles
  // (programming error — fail loud for callers that want the strict answer).
  function resolveOrder(phase) {
    if (!byPhase.has(phase)) throw new Error('[TC.Systems] unknown phase "' + phase + '"');
    const res = resolveCached(phase);
    if (res.cycle) {
      throw new Error('[TC.Systems] constraint cycle in phase "' + phase + '" involving: ' + res.cycle);
    }
    return res.order.slice();
  }

  // Run init() for every system in phase/resolved order. Idempotent: systems
  // already initialized are skipped; a throwing init is marked done so it
  // does not retry every frame. Returns {ran, failed}.
  function initAll() {
    let ran = 0, failed = 0;
    for (const phase of PHASES) {
      for (const e of resolveCached(phase).order) {
        if (!e.hasInit || e.inited) continue;
        e.inited = true;
        ran++;
        const before = e.errors;
        guarded('Systems init ' + phase + '/' + e.name, e, () => e.sys.init());
        if (e.errors > before) failed++;
      }
    }
    return { ran, failed };
  }

  // Walk all phases in fixed order calling update(dt). Each call is isolated:
  // a throwing system is logged (rate-limited) and skipped, the tick goes on.
  // A cyclic phase is skipped with a one-time error log instead of crashing.
  function updateAll(dt) {
    for (const phase of PHASES) {
      const res = resolveCached(phase);
      if (res.cycle) {
        if (!res.cycleLogged) {
          res.cycleLogged = true;
          console.error('[TC.Systems] skipping phase "' + phase + '" — constraint cycle: ' + res.cycle);
        }
        continue;
      }
      for (const e of res.order) {
        if (!e.hasUpdate) continue;
        guarded('Systems update ' + phase + '/' + e.name, e, () => e.sys.update(dt));
      }
    }
  }

  // Debug snapshot: every system in execution order.
  function listSystems() {
    const out = [];
    for (const phase of PHASES) {
      for (const e of resolveCached(phase).order) {
        out.push({
          phase: e.phase, name: e.name,
          hasInit: e.hasInit, hasUpdate: e.hasUpdate,
          after: e.after.slice(), before: e.before.slice(),
          inited: !!e.inited, errors: e.errors
        });
      }
    }
    return out;
  }

  // ---- boot-task registry ----

  // Explicit initialization instead of script-load-order side effects:
  // modules call TC.Systems.boot('name', {init}) at load; main calls
  // runBoot() once at startup. Tasks run in registration order; each runs
  // at most once per arming. Re-registering a name replaces the task and
  // re-arms it (call runBoot() again to run it).
  const boots = new Map(); // name -> {name, task, done, errors}

  function boot(name, task) {
    if (typeof name !== 'string' || !name) {
      console.warn('[TC.Systems] boot: invalid name');
      return null;
    }
    if (!task || typeof task.init !== 'function') {
      console.warn('[TC.Systems] boot "' + name + '" needs {init}');
      return null;
    }
    const prev = boots.get(name);
    if (prev && prev.done) {
      console.warn('[TC.Systems] boot "' + name + '" re-registered after runBoot() — call runBoot() again');
    }
    const entry = { name, task, done: false, errors: 0 };
    boots.set(name, entry);
    return entry;
  }

  // Run every armed boot task. Returns {ran, failed}.
  function runBoot() {
    let ran = 0, failed = 0;
    for (const e of boots.values()) {
      if (e.done) continue;
      e.done = true;
      ran++;
      const before = e.errors;
      guarded('Systems boot ' + e.name, e, () => e.task.init());
      if (e.errors > before) failed++;
    }
    return { ran, failed };
  }

  TC.Systems = {
    PHASES: PHASES.slice(),
    register: registerSystem, initAll, updateAll, resolveOrder, list: listSystems,
    boot, runBoot
  };

  // ===================================================================
  // TC.RenderLayers — fixed-order draw layers
  // ===================================================================

  // Layer order mirrors js/main.js draw(): background first, then world-space
  // content under the camera transform, lighting as a screen-space overlay,
  // HUD/menus/tooltips last in screen space.
  const LAYERS = ['background', 'walls', 'liquidsBehind', 'tiles', 'items', 'enemies',
                  'npcs', 'player', 'projectiles', 'combatFx', 'particles', 'lighting',
                  'worldOverlays', 'hud', 'menus', 'tooltips'];
  const WORLD_LAYERS = ['background', 'walls', 'liquidsBehind', 'tiles', 'items', 'enemies',
                        'npcs', 'player', 'projectiles', 'combatFx', 'particles', 'worldOverlays'];
  const SCREEN_LAYERS = ['lighting', 'hud', 'menus', 'tooltips'];
  const worldSet = new Set(WORLD_LAYERS);

  const drawers = new Map(LAYERS.map((l) => [l, new Map()])); // layer -> name -> entry

  // Register a drawer. World layers get drawFn(ctx, cam) and draw in world
  // pixels; screen layers get drawFn(ctx, view) with view = {w, h, cam}.
  // Duplicate layer/name replaces in place. Returns the entry or null.
  function registerLayer(layer, name, fn) {
    const bucket = drawers.get(layer);
    if (!bucket) {
      console.warn('[TC.RenderLayers] unknown layer "' + layer + '" — dropped "' + name + '"');
      return null;
    }
    if (typeof name !== 'string' || !name || typeof fn !== 'function') {
      console.warn('[TC.RenderLayers] register("' + layer + '"): needs a name and drawFn(ctx, camOrView)');
      return null;
    }
    if (bucket.has(name)) console.warn('[TC.RenderLayers] duplicate "' + layer + '/' + name + '" — replacing in place');
    const entry = { layer, name, fn, errors: 0 };
    bucket.set(name, entry);
    return entry;
  }

  // Apply the camera transform for world-space layers. Prefers main.js's live
  // TC.applyCam (setTransform is absolute, so prior transforms are replaced);
  // falls back to a manual transform from the passed cam for headless use.
  function applyCamera(ctx, cam) {
    if (typeof TC.applyCam === 'function') { TC.applyCam(ctx); return true; }
    const z = (cam && cam.zoom) || 1;
    if (cam && typeof cam.x === 'number' && typeof cam.y === 'number') {
      ctx.setTransform(z, 0, 0, z, -cam.x * z, -cam.y * z);
      return true;
    }
    return false;
  }

  function drawLayer(ctx, layer, arg) {
    for (const e of drawers.get(layer).values()) {
      ctx.save();
      try {
        e.fn(ctx, arg);
      } catch (err) {
        e.errors++;
        if (e.errors <= 3) console.error('[TC.RenderLayers] draw ' + layer + '/' + e.name + ':', err);
      } finally {
        ctx.restore();
      }
    }
  }

  // Execute world-space layers in fixed order under the camera transform
  // (applied here once, restored after). Owns the transform for its duration.
  function drawWorld(ctx, cam) {
    const applied = applyCamera(ctx, cam);
    try {
      for (let i = 0; i < LAYERS.length; i++) {
        const layer = LAYERS[i];
        if (worldSet.has(layer)) drawLayer(ctx, layer, cam);
      }
    } finally {
      if (applied) {
        if (typeof TC.clearCam === 'function') TC.clearCam(ctx);
        else ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }

  // Execute screen-space layers in fixed order at the caller's transform
  // (identity in the normal frame). Each drawer is wrapped in save/restore so
  // leaked styles/clips cannot bleed into the next drawer.
  function drawScreen(ctx, w, h) {
    const view = { w, h, cam: TC.camera || null };
    for (let i = 0; i < LAYERS.length; i++) {
      const layer = LAYERS[i];
      if (!worldSet.has(layer)) drawLayer(ctx, layer, view);
    }
  }

  // Remove all drawers from one layer, or from every layer. Returns count.
  function clear(layer) {
    if (layer == null) {
      let n = 0;
      for (const bucket of drawers.values()) { n += bucket.size; bucket.clear(); }
      return n;
    }
    const bucket = drawers.get(layer);
    if (!bucket) {
      console.warn('[TC.RenderLayers] clear: unknown layer "' + layer + '"');
      return 0;
    }
    const n = bucket.size;
    bucket.clear();
    return n;
  }

  // Debug snapshot: every drawer in draw order.
  function listLayers() {
    const out = [];
    for (const layer of LAYERS) {
      for (const e of drawers.get(layer).values()) {
        out.push({ layer: e.layer, name: e.name, space: worldSet.has(layer) ? 'world' : 'screen', errors: e.errors });
      }
    }
    return out;
  }

  TC.RenderLayers = {
    LAYERS: LAYERS.slice(),
    WORLD_LAYERS: WORLD_LAYERS.slice(),
    SCREEN_LAYERS: SCREEN_LAYERS.slice(),
    register: registerLayer, drawWorld, drawScreen, clear, list: listLayers
  };
})();

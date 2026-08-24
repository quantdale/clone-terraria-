/* runtime.js — TC.Runtime: canonical fixed-step host + headless simulation boundary.
   Lead-owned. ONE production tick authority for both the browser host (main.js)
   and headless tests:

     - executes simulation exclusively through TC.Systems.updateAll (phases:
       input → commands(drain) → environment → movement → … → eventsFlush);
       a guarded legacy direct-call sequence remains ONLY for embeds without
       the scheduler module;
     - owns tickCount, currentPhase observability and command counters;
     - gates simulation on game state: title/paused run UI + event flush only;
     - updates the camera after a simulated step;
     - headless API: createWorld(seed), advanceTicks(n), Commands.enqueue,
       getState(), reset() — no Canvas drawing, DOM layout or rAF required.

   Rendering is NOT part of the tick: the browser host dispatches through
   TC.RenderLayers separately (see main.js). */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  let tickCount = 0;
  let currentPhase = null;
  let commandsProcessed = 0;
  let commandsRejected = 0;

  function simulating() {
    return TC.state === 'playing' && !(TC.UI && TC.UI.paused);
  }

  function flushEvents() {
    if (TC.Events && typeof TC.Events.flush === 'function') {
      try { TC.Events.flush(); } catch (e) {}
    }
  }

  // Smooth camera follow (legacy centerCamera(false)); snapping after world
  // transitions stays a host concern (main.centerCamera(true)).
  function updateCamera() {
    const cam = TC.camera;
    if (!TC.world || !cam || !TC.player) return;
    const canvas = TC.canvas;
    const viewW = canvas ? canvas.width : 800;
    const viewH = canvas ? canvas.height : 600;
    const TS = (TC.CONST && TC.CONST.TS) || 16;
    const wpx = TC.world.width * TS;
    const hpx = TC.world.height * TS;
    const vw = viewW / cam.zoom, vh = viewH / cam.zoom;
    let tx = TC.player.x + TC.player.w / 2 - vw / 2;
    let ty = TC.player.y + TC.player.h / 2 - vh / 2;
    tx = (wpx <= vw) ? (wpx - vw) / 2 : Math.max(0, Math.min(wpx - vw, tx));
    ty = (hpx <= vh) ? (hpx - vh) / 2 : Math.max(0, Math.min(hpx - vh, ty));
    cam.x += (tx - cam.x) * 0.18;
    cam.y += (ty - cam.y) * 0.18;
  }

  // Host-level key toggles (F3 debug, M mute) — checked once per fixed step,
  // matching the legacy step() placement exactly.
  function hostToggles() {
    if (!TC.Input || typeof TC.Input.pressed !== 'function') return;
    if (TC.Input.pressed('F3')) TC.debug = !TC.debug;
    if (TC.Input.pressed('KeyM') && TC.Audio && typeof TC.Audio.toggleMuted === 'function') {
      try { TC.Audio.toggleMuted(); } catch (e) {}
    }
  }

  // Guarded legacy sequence — used ONLY when js/systems.js is absent (bare
  // embeds). Order mirrors the pre-convergence main.js step() verbatim.
  function legacyTick(dt) {
    if (TC.UI && typeof TC.UI.update === 'function') { try { TC.UI.update(dt); } catch (e) {} }
    if (!simulating()) { flushEvents(); return; }
    try {
      if (TC.Sky) TC.Sky.update(dt);
      if (TC.Biomes) TC.Biomes.update(dt);
      if (TC.Grapple && typeof TC.Grapple.preUpdate === 'function') TC.Grapple.preUpdate(dt);
      if (TC.player) TC.player.update(dt);
      if (TC.Grapple && typeof TC.Grapple.postUpdate === 'function') TC.Grapple.postUpdate(dt);
      if (TC.Loot && TC.player) TC.Loot.update(TC.player, dt);
      if (TC.Accessories && typeof TC.Accessories.update === 'function') TC.Accessories.update(dt);
      if (TC.Fishing && typeof TC.Fishing.update === 'function') TC.Fishing.update(dt);
      if (TC.Enemies) { TC.Enemies.spawnDirector(dt); TC.Enemies.update(dt); }
      if (TC.NPCs) TC.NPCs.update(dt);
      if (TC.Items) TC.Items.update(dt, TC.player);
      if (TC.Combat) TC.Combat.update(dt);
      if (TC.Gear) TC.Gear.update(dt);
      if (TC.Magic && typeof TC.Magic.update === 'function') TC.Magic.update(dt);
      if (TC.Particles) TC.Particles.update(dt);
      if (TC.world) TC.world.update(dt);
      if (TC.Wiring && typeof TC.Wiring.update === 'function') TC.Wiring.update(dt);
      if (TC.Liquids && typeof TC.Liquids.update === 'function') TC.Liquids.update(dt);
      if (TC.Lighting) TC.Lighting.update(dt, TC.camera);
      if (TC.Music) TC.Music.update(dt);
      if (TC.MiniMap) TC.MiniMap.update(dt);
      if (TC.Save) TC.Save.autosave(dt);
      flushEvents();
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[TC.Runtime] legacy tick', e);
    }
  }

  // Advance the simulation one fixed step. dt defaults to 1/60.
  function tick(dt) {
    const step = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : 1 / 60;
    tickCount++;
    hostToggles();

    if (TC.Systems && typeof TC.Systems.updateAll === 'function') {
      TC.Systems.updateAll(step);   // phases gate themselves (title/pause)
    } else {
      legacyTick(step);
    }

    if (simulating()) updateCamera();
    currentPhase = null;
  }

  function advanceTicks(n, dt) {
    const steps = (typeof n === 'number' && isFinite(n) && n > 0) ? (n | 0) : 1;
    const step = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : 1 / 60;
    for (let i = 0; i < steps; i++) tick(step);
    return tickCount;
  }

  // Full session teardown back to a pristine title state (no world).
  function reset() {
    tickCount = 0;
    currentPhase = null;
    commandsProcessed = 0;
    commandsRejected = 0;
    if (TC.Commands && typeof TC.Commands.clearQueue === 'function') {
      try { TC.Commands.clearQueue(); } catch (e) {}
    }
    if (TC.Systems && typeof TC.Systems.resetCounts === 'function') {
      try { TC.Systems.resetCounts(); } catch (e) {}
    }
    TC.state = 'title';
    TC.world = null;
    TC.worldSeed = null;
    TC.player = null;
  }

  // Headless world creation — mirrors TC.newGame without browser side effects.
  function createWorld(seed) {
    seed = (seed == null) ? 1337 : (seed | 0);
    if (TC.Chests && typeof TC.Chests.clear === 'function') try { TC.Chests.clear(); } catch (e) {}
    if (TC.Enemies && typeof TC.Enemies.clear === 'function') try { TC.Enemies.clear(); } catch (e) {}
    if (TC.Items && typeof TC.Items.clearDrops === 'function') try { TC.Items.clearDrops(); } catch (e) {}
    if (TC.Combat && typeof TC.Combat.clear === 'function') try { TC.Combat.clear(); } catch (e) {}
    if (TC.Particles && typeof TC.Particles.clear === 'function') try { TC.Particles.clear(); } catch (e) {}
    if (TC.Progression && typeof TC.Progression.resetForNewWorld === 'function') try { TC.Progression.resetForNewWorld(); } catch (e) {}
    if (TC.Wiring && typeof TC.Wiring.resetForNewWorld === 'function') try { TC.Wiring.resetForNewWorld(); } catch (e) {}
    if (TC.Grapple && typeof TC.Grapple.resetForNewWorld === 'function') try { TC.Grapple.resetForNewWorld(); } catch (e) {}
    if (TC.NPCs && typeof TC.NPCs.clear === 'function') try { TC.NPCs.clear(); } catch (e) {}

    let gen = null;
    gen = TC.WorldGen.generate(seed);
    if (gen && TC.Loot && typeof TC.Loot.populateWorld === 'function') {
      TC.Loot.populateWorld(gen, seed);
    }
    TC.worldSeed = seed;
    TC.world = new TC.World(gen);
    if (TC.Lighting && typeof TC.Lighting.init === 'function') {
      try { TC.Lighting.init(TC.world); } catch (e) {}
    }
    if (TC.Liquids && typeof TC.Liquids.importFromWorld === 'function') {
      try { TC.Liquids.importFromWorld(TC.world); } catch (e) {}
    }
    TC.player = new TC.Player(
      gen.spawnX * TC.CONST.TS + TC.CONST.TS / 2 - TC.CONST.PLAYER_W / 2,
      gen.spawnY * TC.CONST.TS - TC.CONST.PLAYER_H
    );
    if (TC.player.giveStarterKit) TC.player.giveStarterKit();
    if (TC.NPCs && typeof TC.NPCs.spawnGuide === 'function') {
      try { TC.NPCs.spawnGuide(gen.spawnX * TC.CONST.TS, gen.spawnY * TC.CONST.TS); } catch (e) {}
    }
    if (TC.Sky && typeof TC.Sky.reset === 'function') TC.Sky.reset();

    TC.state = 'playing';
    if (TC.Input && typeof TC.Input.barrier === 'function') {
      try { TC.Input.barrier(); } catch (e) {}
    }
    tickCount = 0;
    if (TC.Commands && typeof TC.Commands.clearQueue === 'function') {
      try { TC.Commands.clearQueue(); } catch (e) {}
    }
    if (TC.Events && TC.Events.EVENT && TC.Events.EVENT.WorldLoaded) {
      try { TC.Events.emit(TC.Events.EVENT.WorldLoaded, { seed: seed }); } catch (e) {}
    }
    if (TC.NPCs && typeof TC.NPCs.evaluateUnlocks === 'function') {
      try { TC.NPCs.evaluateUnlocks(); } catch (e) {}
    }
    return { seed: seed, world: TC.world, player: TC.player, gen: gen };
  }

  function getState() {
    return {
      tickCount: tickCount,
      state: TC.state,
      simulating: simulating(),
      currentPhase: currentPhase,
      pendingCommands: (TC.Commands && typeof TC.Commands.pending === 'function')
        ? TC.Commands.pending() : 0,
      commandStats: (TC.Commands && typeof TC.Commands.stats === 'function')
        ? TC.Commands.stats() : null,
      commandsProcessed: commandsProcessed,
      commandsRejected: commandsRejected,
      systemCounts: (TC.Systems && typeof TC.Systems.getCounts === 'function')
        ? TC.Systems.getCounts() : {},
      perTickCounts: (TC.Systems && typeof TC.Systems.getPerTickCounts === 'function')
        ? TC.Systems.getPerTickCounts() : {},
      renderLayers: (TC.RenderLayers && typeof TC.RenderLayers.list === 'function')
        ? TC.RenderLayers.list() : [],
      systems: (TC.Systems && typeof TC.Systems.list === 'function')
        ? TC.Systems.list() : [],
      worldSeed: (typeof TC.worldSeed === 'number') ? TC.worldSeed : null
    };
  }

  // Observability hooks driven by systems.js instrumentation.
  function incCommandOk() { commandsProcessed++; }
  function incCommandReject() { commandsRejected++; }
  function setPhase(p) { currentPhase = p; }

  TC.Runtime = {
    tick: tick,
    advanceTicks: advanceTicks,
    reset: reset,
    createWorld: createWorld,
    getState: getState,
    getTickCount: function () { return tickCount; },
    getCurrentPhase: function () { return currentPhase; },
    _incCommandOk: incCommandOk,
    _incCommandReject: incCommandReject,
    _setPhase: setPhase
  };
  TC.Simulation = TC.Runtime;   // alias for headless consumers

  // A fresh world never inherits stale tick counts or queued intents.
  if (TC.Events && typeof TC.Events.on === 'function' &&
      TC.Events.EVENT && TC.Events.EVENT.WorldLoaded) {
    try {
      TC.Events.on(TC.Events.EVENT.WorldLoaded, function () {
        tickCount = 0;
        if (TC.Systems && typeof TC.Systems.resetCounts === 'function') {
          try { TC.Systems.resetCounts(); } catch (e) {}
        }
      });
    } catch (e) {}
  }
})();

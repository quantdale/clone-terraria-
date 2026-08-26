/* main.js — browser host: canvas lifecycle, game-state transitions, camera,
   and the production registration of every update system + render layer.
   Lead-owned.

   CONVERGENCE CONTRACT (runtime-authority campaign):
   - The fixed-step simulation is executed ONLY through TC.Runtime.tick →
     TC.Systems.updateAll. This file registers systems; it does not sequence
     them. Phase ownership is documented in js/systems.js PHASES.
   - Discrete world mutations flow through the command queue drained in the
     scheduler's 'commands' phase (js/commands.js).
   - Rendering dispatches exclusively through TC.RenderLayers.drawWorld /
     drawScreen. This file registers drawers; it does not draw them manually.
     The host owns exactly one thing visually: the sky/background clear that
     must precede every layer (it cannot live inside a world-space transform).
   - Headless consumers skip this file's host parts entirely and use
     TC.Runtime.createWorld / advanceTicks (no Canvas/DOM/rAF needed). */
'use strict';
(function () {
  const TC = window.TC;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  TC.canvas = canvas;

  const cam = { x: 0, y: 0, zoom: TC.CONST.ZOOM };
  TC.camera = cam;

  let viewW = 0, viewH = 0;
  function resize() {
    viewW = canvas.width = window.innerWidth;
    viewH = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- camera helpers for world-space drawers ----
  TC.applyCam = function (c) {
    c.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);
  };
  TC.clearCam = function (c) {
    c.setTransform(1, 0, 0, 1, 0, 0);
  };

  // ---- game state ----
  TC.state = 'title';            // 'title' | 'playing'
  TC.world = null;
  TC.worldSeed = null;
  TC.player = null;
  TC.debug = false;
  TC.fps = 0;

  // Input ownership: a menu click that causes a transition must never also
  // act as a gameplay input (see input.js barrier notes).
  function enterPlaying() {
    TC.state = 'playing';
    if (TC.Input && typeof TC.Input.barrier === 'function') TC.Input.barrier();
  }

  function buildWorld(seed, diffs, wallDiffs) {
    const gen = TC.WorldGen.generate(seed);
    if (TC.Loot && TC.Loot.populateWorld) TC.Loot.populateWorld(gen, seed);
    TC.worldSeed = seed;
    TC.world = new TC.World(gen);
    if (diffs) {
      for (let i = 0; i < diffs.length; i++) {
        const idx = diffs[i][0];
        const tx = idx % TC.world.width;
        const ty = (idx / TC.world.width) | 0;
        TC.world.setRaw(tx, ty, diffs[i][1]);
      }
    }
    if (wallDiffs && typeof TC.world.setRawWall === 'function') {
      for (let i = 0; i < wallDiffs.length; i++) {
        const idx = wallDiffs[i][0];
        const tx = idx % TC.world.width;
        const ty = (idx / TC.world.width) | 0;
        TC.world.setRawWall(tx, ty, wallDiffs[i][1]);
      }
    }
    if (diffs || wallDiffs) TC.world.markAllDirty();
    if (TC.Lighting) TC.Lighting.init(TC.world);
    // W1 liquid migration: claim ALL liquid into the TC.Liquids volume layer.
    if (TC.Liquids && typeof TC.Liquids.importFromWorld === 'function') {
      try { TC.Liquids.importFromWorld(TC.world); } catch (e) {
        console.warn('[TC] liquid import failed:', e && e.message);
      }
    }
    if (TC.Grapple && typeof TC.Grapple.resetForNewWorld === 'function') {
      try { TC.Grapple.resetForNewWorld(); } catch (e) {}
    }
    return gen;
  }

  TC.newGame = function (seed) {
    seed = (seed == null) ? ((Math.random() * 2147483647) | 0) : (seed | 0);
    if (TC.Chests && typeof TC.Chests.clear === 'function') TC.Chests.clear();
    const gen = buildWorld(seed, null);
    TC.player = new TC.Player(
      gen.spawnX * TC.CONST.TS + TC.CONST.TS / 2 - TC.CONST.PLAYER_W / 2,
      gen.spawnY * TC.CONST.TS - TC.CONST.PLAYER_H
    );
    TC.player.giveStarterKit();
    if (TC.Enemies) TC.Enemies.clear();
    if (TC.Progression && typeof TC.Progression.resetForNewWorld === 'function') TC.Progression.resetForNewWorld();
    if (TC.Wiring && typeof TC.Wiring.resetForNewWorld === 'function') TC.Wiring.resetForNewWorld();
    if (TC.NPCs && TC.NPCs.spawnGuide) TC.NPCs.spawnGuide(gen.spawnX * TC.CONST.TS, gen.spawnY * TC.CONST.TS);
    if (TC.Items) TC.Items.clearDrops();
    if (TC.Combat) TC.Combat.clear();
    if (TC.Particles) TC.Particles.clear();
    if (TC.Sky) TC.Sky.reset();
    centerCamera(true);
    enterPlaying();
    if (TC.Events) { try { TC.Events.emit(TC.Events.EVENT.WorldLoaded, { seed: seed }); } catch (e) {} }
    if (TC.NPCs && typeof TC.NPCs.evaluateUnlocks === 'function') {
      try { TC.NPCs.evaluateUnlocks(); } catch (eu) {}
    }
  };

  TC.continueGame = function () {
    const data = TC.Save.load();
    if (!data) { TC.newGame(); return; }
    // W25 MOD-003: classify pack compatibility BEFORE any world/character
    // state mutates. An incompatible load refuses cleanly, shows an
    // actionable diagnostic, and leaves the stored save untouched.
    if (TC.Packs && data.__envelope) {
      const cls = TC.Packs.classifySave(data.__envelope.packs || null);
      if (!cls.ok) {
        if (TC.UI && typeof TC.UI.showPackProblem === 'function') {
          TC.UI.showPackProblem(cls);
        } else {
          console.warn('[TC] save incompatible with active packs:', cls.problems.join('; '));
        }
        return; // stay on title; storage untouched
      }
    }
    const gen = buildWorld(data.seed, data.diffs, data.wallDiffs);
    TC.player = TC.Player.deserialize(data.player);
    if (!TC.player) {
      TC.player = new TC.Player(
        gen.spawnX * TC.CONST.TS + TC.CONST.TS / 2 - TC.CONST.PLAYER_W / 2,
        gen.spawnY * TC.CONST.TS - TC.CONST.PLAYER_H
      );
      TC.player.giveStarterKit();
    }
    if (TC.Enemies) TC.Enemies.clear();
    if (TC.NPCs && TC.NPCs.load) TC.NPCs.load(data.npcs);
    if (TC.Items) TC.Items.clearDrops();
    if (TC.Combat) TC.Combat.clear();
    if (TC.Particles) TC.Particles.clear();
    if (TC.Sky && typeof data.time === 'number') TC.Sky.time = data.time;
    if (TC.Chests && typeof TC.Chests.load === 'function') TC.Chests.load(data.chests);
    if (TC.Fishing && typeof TC.Fishing.restoreLegacy === 'function' && data.fishing != null) {
      try { TC.Fishing.restoreLegacy(data.fishing); } catch (e) {}
    }
    if (TC.Wiring && typeof TC.Wiring.resetForNewWorld === 'function') TC.Wiring.resetForNewWorld();
    if (data.__envelope && TC.SaveCore && typeof TC.SaveCore.restore === 'function') {
      try { TC.SaveCore.restore(data.__envelope); } catch (e) { console.warn('[TC] save restore:', e); }
    }
    if (TC.NPCs && typeof TC.NPCs.evaluateUnlocks === 'function') {
      try { TC.NPCs.evaluateUnlocks(); } catch (eu) {}
    }
    centerCamera(true);
    enterPlaying();
    if (TC.Events) { try { TC.Events.emit(TC.Events.EVENT.WorldLoaded, { seed: data.seed }); } catch (e) {} }
  };

  TC.quitToTitle = function () {
    // W22: a joined network client holds a PRESENTATION MIRROR, never truth —
    // it must not overwrite the local save with replicated state.
    const netClient = TC.NetClient && TC.NetClient.active ? TC.NetClient.active() : null;
    if (netClient && netClient.isActive()) {
      netClient.disconnect('quit-to-title');
      if (TC.Runtime && typeof TC.Runtime.reset === 'function') TC.Runtime.reset();
      if (TC.WorldRegions && typeof TC.WorldRegions.reset === 'function') {
        try { TC.WorldRegions.reset(); } catch (e) {}
      }
      if (TC.Commands && typeof TC.Commands.clearQueue === 'function') {
        try { TC.Commands.clearQueue(); } catch (e) {}
      }
      TC.world = null;
      TC.worldSeed = null;
      TC.player = null;
      TC.state = 'title';
      if (TC.Input && typeof TC.Input.barrier === 'function') TC.Input.barrier();
      return;
    }
    // W22: hosting a session? Tear it down with the world (the HOST world is
    // truth, so the regular save below stays correct).
    if (TC.__netHost) {
      try { TC.__netHost.stop('host-quit'); } catch (e) {}
      TC.__netHost = null;
    }
    TC.Save.save();
    TC.world = null;
    TC.worldSeed = null;
    TC.player = null;
    TC.state = 'title';
    if (TC.WorldRegions && typeof TC.WorldRegions.reset === 'function') {
      try { TC.WorldRegions.reset(); } catch (e) {}
    }
    if (TC.Commands && typeof TC.Commands.clearQueue === 'function') {
      try { TC.Commands.clearQueue(); } catch (e) {}
    }
    if (TC.Input && typeof TC.Input.barrier === 'function') TC.Input.barrier();
  };

  function centerCamera(snap) {
    const wpx = TC.world.width * TC.CONST.TS;
    const hpx = TC.world.height * TC.CONST.TS;
    const vw = viewW / cam.zoom, vh = viewH / cam.zoom;
    let tx, ty;
    if (TC.player) {
      tx = TC.player.x + TC.player.w / 2 - vw / 2;
      ty = TC.player.y + TC.player.h / 2 - vh / 2;
    } else { tx = 0; ty = 0; }
    tx = (wpx <= vw) ? (wpx - vw) / 2 : Math.max(0, Math.min(wpx - vw, tx));
    ty = (hpx <= vh) ? (hpx - vh) / 2 : Math.max(0, Math.min(hpx - vh, ty));
    if (snap) { cam.x = tx; cam.y = ty; }
    else { cam.x += (tx - cam.x) * 0.18; cam.y += (ty - cam.y) * 0.18; }
  }

  // =====================================================================
  // System registration — the canonical update schedule (see systems.js
  // PHASES). Registration order breaks ties inside a phase, so it mirrors
  // the legacy step() sequence within each phase bucket.
  // =====================================================================
  function simGate() {
    return TC.state === 'playing' && !(TC.UI && TC.UI.paused);
  }

  function registerSystems() {
    if (!TC.Systems || typeof TC.Systems.register !== 'function') return;

    // input — UI runs on title too (menu buttons); never gated.
    TC.Systems.register('input', 'ui', {
      update: function (dt) { if (TC.UI) TC.UI.update(dt); }
    });
    // input — player intent creation MUST precede the commands drain in the
    // same tick: click-edge consumers (e.g. fishing) sample input in later
    // phases, so a deferred dispatch would lose the press edge. This keeps
    // held-use cadence driven by fixed steps, never display frames.
    TC.Systems.register('input', 'player-intent', {
      update: function () {
        const p = TC.player, inp = TC.Input;
        if (!p || typeof p.enqueueUseIntent !== 'function') return;
        const held = !!(inp && inp.mouse && inp.mouse.down);
        if (!held || TC.state !== 'playing' || (inp && inp.uiHover)) {
          p.mineTarget = null;
          return;
        }
        p.enqueueUseIntent(inp.mouse, 1 / 60);
        // discrete RMB interaction rides the same same-tick pipeline
        if (inp.mouse.rightClicked && !p.dead && typeof p.requestInteract === 'function') {
          p.requestInteract(inp.mouse);
        }
      }
    }, { when: function () { return TC.state === 'playing'; } });

    // environment — day/night before anything consumes daylight.
    TC.Systems.register('environment', 'sky', {
      update: function (dt) { if (TC.Sky) TC.Sky.update(dt); }
    }, { when: simGate });
    // biomes self-registers here (gated).

    // movement — graddle pull thrust resolves BEFORE player physics; the
    // rope constraint corrects position AFTER movement (see js/grapple.js).
    TC.Systems.register('movement', 'grapple-pre', {
      update: function (dt) { if (TC.Grapple && TC.Grapple.preUpdate) TC.Grapple.preUpdate(dt); }
    }, { when: simGate, before: ['player'] });
    TC.Systems.register('movement', 'player', {
      update: function (dt) {
        // W22: every authoritative player entity steps through the same
        // physics; single-player is the degenerate one-entry case.
        const players = (TC.Players && TC.Players.count && TC.Players.count() > 0)
          ? TC.Players.all()
          : (TC.player ? [TC.player] : []);
        for (let i = 0; i < players.length; i++) {
          const pl = players[i];
          if (!pl) continue;
          pl.mining = false;
          pl.update(dt);
        }
      }
    }, { when: simGate });
    TC.Systems.register('movement', 'grapple-post', {
      update: function (dt) { if (TC.Grapple && TC.Grapple.postUpdate) TC.Grapple.postUpdate(dt); }
    }, { when: simGate, after: ['player'] });
    TC.Systems.register('movement', 'loot', {
      update: function (dt) { if (TC.Loot && TC.player) TC.Loot.update(TC.player, dt); }
    }, { when: simGate });

    // ai — spawn director strictly before entity update.
    TC.Systems.register('ai', 'fishing', {
      update: function (dt) { if (TC.Fishing && TC.Fishing.update) TC.Fishing.update(dt); }
    }, { when: simGate });
    TC.Systems.register('ai', 'spawn-director', {
      update: function (dt) { if (TC.Enemies) TC.Enemies.spawnDirector(dt); }
    }, { when: simGate });
    TC.Systems.register('ai', 'enemies', {
      update: function (dt) { if (TC.Enemies) TC.Enemies.update(dt); }
    }, { when: simGate, after: ['spawn-director'] });
    TC.Systems.register('ai', 'npcs', {
      update: function (dt) { if (TC.NPCs) TC.NPCs.update(dt); }
    }, { when: simGate });

    // items — magnet/pickup before combat consumes targets.
    TC.Systems.register('items', 'items', {
      update: function (dt) { if (TC.Items) TC.Items.update(dt, TC.player); }
    }, { when: simGate });

    // combat — core.combat self-registers first (drives Projectiles), then
    // thrown gear, mana, status ticks, particle decay — legacy order.
    TC.Systems.register('combat', 'accessories', {
      update: function (dt) { if (TC.Accessories && TC.Accessories.update) TC.Accessories.update(dt); }
    }, { when: simGate });
    TC.Systems.register('combat', 'gear', {
      update: function (dt) { if (TC.Gear) TC.Gear.update(dt); }
    }, { when: simGate });
    TC.Systems.register('combat', 'magic', {
      update: function (dt) { if (TC.Magic && TC.Magic.update) TC.Magic.update(dt); }
    }, { when: simGate });
    TC.Systems.register('combat', 'particles', {
      update: function (dt) { if (TC.Particles) TC.Particles.update(dt); }
    }, { when: simGate });

    // liquidsWiring — chunk rebuild first, then mechanisms, then settling.
    TC.Systems.register('liquidsWiring', 'world', {
      update: function (dt) { if (TC.world) TC.world.update(dt); }
    }, { when: simGate });
    // wiring self-registers here (gated); liquids wait for it (legacy order).
    TC.Systems.register('liquidsWiring', 'liquids', {
      update: function (dt) { if (TC.Liquids && TC.Liquids.update) TC.Liquids.update(dt); }
    }, { when: simGate, after: ['wiring'] });

    // progression — lighting refresh, soundtrack, map, autosave.
    TC.Systems.register('progression', 'lighting', {
      update: function (dt) { if (TC.Lighting) TC.Lighting.update(dt, cam); }
    }, { when: simGate });
    TC.Systems.register('progression', 'music', {
      update: function (dt) { if (TC.Music && TC.Music.update) TC.Music.update(dt); }
    }, { when: simGate });
    TC.Systems.register('progression', 'minimap', {
      update: function (dt) { if (TC.MiniMap && TC.MiniMap.update) TC.MiniMap.update(dt); }
    }, { when: simGate });
    TC.Systems.register('progression', 'autosave', {
      update: function (dt) { if (TC.Save) TC.Save.autosave(dt); }
    }, { when: simGate });

    // eventsFlush — drain deferred events after all mutation.
    TC.Systems.register('eventsFlush', 'core.flush', {
      update: function () { if (TC.Events && TC.Events.flush) TC.Events.flush(); }
    });

    if (TC.Systems.initAll) TC.Systems.initAll();
  }

  // =====================================================================
  // Render-layer registration — the canonical draw schedule (see systems.js
  // LAYERS). The host draws only the background clear itself.
  // =====================================================================
  function worldGuard(fn) {
    return function (c, camera) {
      if (!TC.world || TC.state === 'title') return;
      fn(c, camera);
    };
  }

  function registerLayers() {
    if (!TC.RenderLayers || typeof TC.RenderLayers.register !== 'function') return;
    const R = TC.RenderLayers;

    R.register('tiles', 'core.world', worldGuard(function (c, camera) {
      TC.world.draw(c, camera);
    }));
    R.register('liquids', 'core.liquids', worldGuard(function (c, camera) {
      if (TC.Liquids && typeof TC.Liquids.draw === 'function') TC.Liquids.draw(c, camera, TC.world);
    }));
    R.register('worldDecor', 'core.loot-tiles', worldGuard(function (c, camera) {
      if (TC.Loot) TC.Loot.drawTiles(c, camera, TC.world);
    }));
    // wiring self-registers into worldOverlays (above decor, below entities —
    // its legacy call site).

    R.register('items', 'core.items', worldGuard(function (c, camera) {
      if (TC.Items) TC.Items.draw(c, camera);
    }));
    R.register('enemies', 'core.enemies', worldGuard(function (c, camera) {
      if (TC.Enemies) TC.Enemies.draw(c, camera);
    }));
    R.register('npcs', 'core.npcs', worldGuard(function (c, camera) {
      if (TC.NPCs) TC.NPCs.draw(c, camera);
    }));
    R.register('player', 'core.player', worldGuard(function (c, camera) {
      if (TC.player) TC.player.draw(c, camera);
    }));
    R.register('projectiles', 'core.fishing', worldGuard(function (c, camera) {
      if (TC.Fishing && typeof TC.Fishing.draw === 'function') TC.Fishing.draw(c, camera);
    }));
    R.register('projectiles', 'core.combat', worldGuard(function (c, camera) {
      if (TC.Combat) TC.Combat.draw(c, camera);
    }));
    R.register('combatFx', 'core.grapple', worldGuard(function (c, camera) {
      if (TC.Grapple && typeof TC.Grapple.drawWorld === 'function') TC.Grapple.drawWorld(c, camera);
    }));
    R.register('combatFx', 'core.gear', worldGuard(function (c, camera) {
      if (TC.Gear) TC.Gear.draw(c, camera);
    }));
    R.register('combatFx', 'core.magic', worldGuard(function (c, camera) {
      if (TC.Magic && typeof TC.Magic.drawWorld === 'function') TC.Magic.drawWorld(c, camera);
    }));
    R.register('particles', 'core.particles', worldGuard(function (c, camera) {
      if (TC.Particles) TC.Particles.draw(c, camera);
    }));

    // screen space
    R.register('ambient', 'core.biomes', function (c, view) {
      if (TC.Biomes && TC.state !== 'title') TC.Biomes.drawOverlay(c, view.w, view.h, view.cam);
    });
    R.register('lighting', 'core.lighting', function (c, view) {
      if (TC.world && TC.state !== 'title' && TC.Lighting) TC.Lighting.draw(c, view.cam);
    });
    R.register('overlays', 'core.minimap', function (c, view) {
      if (TC.MiniMap && TC.world && TC.state !== 'title') TC.MiniMap.draw(c, view.w, view.h);
    });
    R.register('overlays', 'core.cursor', function (c, view) {
      if (TC.Input) TC.Input.drawCursor(c, view.cam);
    });
    R.register('hud', 'core.ui', function (c, view) {
      if (TC.UI) TC.UI.draw(c, view.w, view.h);
    });
    R.register('hud', 'core.magic', function (c, view) {
      if (TC.Magic && typeof TC.Magic.drawHud === 'function') TC.Magic.drawHud(c, view.w, view.h);
    });
    R.register('hud', 'core.accessories', function (c, view) {
      if (TC.Accessories && typeof TC.Accessories.drawHud === 'function') TC.Accessories.drawHud(c);
    });
    R.register('tooltips', 'core.debug-legacy', function (c, view) {
      drawDebug(c);
    });
    R.register('tooltips', 'core.debug', function (c, view) {
      if (TC.Debug && typeof TC.Debug.drawHud === 'function') TC.Debug.drawHud(c, view.w, view.h);
    });
  }

  function drawDebug(c) {
    if (!TC.debug || !TC.world) return;
    const lines = [];
    lines.push('fps ' + TC.fps.toFixed(0));
    if (TC.player) {
      lines.push('pos ' + (TC.player.x / 16).toFixed(1) + ',' + (TC.player.y / 16).toFixed(1));
      lines.push('hp ' + TC.player.hp + '/' + TC.player.maxHp);
    }
    if (TC.Input) {
      const m = TC.Input.mouse;
      const tx = (m.worldX / 16) | 0, ty = (m.worldY / 16) | 0;
      const id = TC.world.get(tx, ty);
      lines.push('cursor tile ' + tx + ',' + ty + ' = ' + TC.TILE_DEFS[id].name);
      if (TC.Lighting) lines.push('light ' + TC.Lighting.lightAt(tx, ty).toFixed(2));
    }
    if (TC.Enemies) lines.push('enemies ' + TC.Enemies.list.length);
    if (TC.Items) lines.push('drops ' + TC.Items.drops.length);
    c.save();
    c.font = '12px monospace';
    c.fillStyle = '#fff';
    for (let i = 0; i < lines.length; i++) c.fillText(lines[i], 8, 240 + i * 14);
    c.restore();
  }

  // ---- render dispatch (RenderLayers is THE pipeline) ----
  function draw() {
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Host-owned background clear: precedes every registered layer.
    if (TC.Sky) TC.Sky.draw(ctx, cam, viewW, viewH);
    else { ctx.fillStyle = '#69b7f2'; ctx.fillRect(0, 0, viewW, viewH); }

    if (TC.world && TC.state !== 'title') {
      TC.RenderLayers.drawWorld(ctx, cam);
    }
    TC.RenderLayers.drawScreen(ctx, viewW, viewH);
  }

  // ---- main loop ----
  let last = performance.now(), acc = 0;
  const STEP = 1 / 60;
  let fpsAcc = 0, fpsN = 0;

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 0.5) { TC.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

    acc += dt;
    while (acc >= STEP) {
      // W22: a joined network client advances presentation + input sampling
      // only — the authoritative simulation lives on the server it joined.
      if (TC.NetClient && TC.NetClient.drivesTick()) TC.NetClient.frame(STEP);
      else TC.Runtime.tick(STEP);   // canonical fixed-step authority
      acc -= STEP;
    }
    if (TC.Debug && typeof TC.Debug.frame === 'function') TC.Debug.frame(dt);
    draw();
    if (TC.Input) TC.Input.endFrame();
    requestAnimationFrame(frame);
  }

  // ---- boot ----
  if (TC.Input) TC.Input.init(canvas);
  // W25: activate the persisted pack set BEFORE the registry sync so pack
  // content joins the same identity pass as built-ins. Failure falls back
  // to the zero-pack base set (fail closed); the reason is surfaced on the
  // title screen via TC.Packs.lastError().
  let packsBootError = null;
  if (TC.Packs && typeof TC.Packs.bootActivate === "function") {
    const bootResult = TC.Packs.bootActivate();
    packsBootError = bootResult.error || null;
  }
  if (TC.Registry) {
    TC.Registry.syncFromTables();
    try { TC.Registry.validate(); } catch (e) { console.warn('[TC] registry validation:', e.message); }
  }
  if (TC.Systems && TC.Systems.runBoot) TC.Systems.runBoot();
  registerSystems();
  registerLayers();
  requestAnimationFrame(frame);
})();

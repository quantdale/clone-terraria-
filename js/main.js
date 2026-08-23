/* main.js — bootstrapping, game loop, camera. Lead-owned. */
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
  TC.state = 'title';            // 'title' | 'playing' | 'paused'
  TC.world = null;
  TC.worldSeed = null;
  TC.player = null;
  TC.debug = false;
  TC.fps = 0;

  // Input ownership: a menu click that causes a transition must never also
  // act as a gameplay input. The transition runs mid-step inside UI.update,
  // and the activating button's mouseup can still be queued behind the
  // synchronous worldgen — so entering gameplay drops every transient
  // pointer/key state before the first gameplay frame consumes input.
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
    // W1 liquid migration: claim ALL liquid (fresh worldgen output + any
    // legacy WATER/LAVA diff tiles) into the TC.Liquids volume layer. From
    // here on the layer is the single runtime authority; the tile ids are
    // only a legacy representation consumed by this one-way import.
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
    TC.Save.save();
    TC.world = null;
    TC.worldSeed = null;
    TC.player = null;
    TC.state = 'title';
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

  // ---- simulation step ----
  function step(dt) {
    if (TC.Input) {
      if (TC.Input.pressed('F3')) TC.debug = !TC.debug;
      if (TC.Input.pressed('KeyM') && TC.Audio) TC.Audio.toggleMuted();
    }
    if (TC.UI) TC.UI.update(dt);   // runs on title too (menu buttons)
    if (TC.state !== 'playing') return;
    if (TC.Sky) TC.Sky.update(dt);
    if (TC.Biomes) TC.Biomes.update(dt);
    // Grapple pull thrust resolves before player physics; the rope
    // constraint corrects position after movement (see js/grapple.js).
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
    if (TC.Lighting) TC.Lighting.update(dt, cam);
    if (TC.Music) TC.Music.update(dt);
    if (TC.MiniMap) TC.MiniMap.update(dt);
    if (TC.Save) TC.Save.autosave(dt);
    if (TC.Events) TC.Events.flush();
    centerCamera(false);
  }

  // ---- render ----
  function draw() {
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (TC.Sky) TC.Sky.draw(ctx, cam, viewW, viewH);
    else { ctx.fillStyle = '#69b7f2'; ctx.fillRect(0, 0, viewW, viewH); }

    if (TC.world && TC.state !== 'title') {
      TC.applyCam(ctx);
      TC.world.draw(ctx, cam);
      if (TC.Liquids && typeof TC.Liquids.draw === 'function') TC.Liquids.draw(ctx, cam, TC.world);
      if (TC.Loot) TC.Loot.drawTiles(ctx, cam, TC.world);
      if (TC.Wiring && typeof TC.Wiring.draw === 'function') TC.Wiring.draw(ctx, cam);
      if (TC.Items) TC.Items.draw(ctx, cam);
      if (TC.Enemies) TC.Enemies.draw(ctx, cam);
      if (TC.NPCs) TC.NPCs.draw(ctx, cam);
      if (TC.player) TC.player.draw(ctx, cam);
      if (TC.Fishing && typeof TC.Fishing.draw === 'function') TC.Fishing.draw(ctx, cam);
      if (TC.Combat) TC.Combat.draw(ctx, cam);
      if (TC.Grapple && typeof TC.Grapple.drawWorld === 'function') TC.Grapple.drawWorld(ctx, cam);
      if (TC.Gear) TC.Gear.draw(ctx, cam);
      if (TC.Magic && typeof TC.Magic.drawWorld === 'function') TC.Magic.drawWorld(ctx, cam);
      if (TC.Particles) TC.Particles.draw(ctx, cam);
      TC.clearCam(ctx);

      if (TC.Biomes) TC.Biomes.drawOverlay(ctx, viewW, viewH, cam);
      if (TC.Lighting) TC.Lighting.draw(ctx, cam);
      if (TC.MiniMap) TC.MiniMap.draw(ctx, viewW, viewH);
      if (TC.Input) TC.Input.drawCursor(ctx, cam);
    }

    if (TC.UI) TC.UI.draw(ctx, viewW, viewH);
    if (TC.Magic && typeof TC.Magic.drawHud === 'function') TC.Magic.drawHud(ctx, viewW, viewH);
    if (TC.Accessories && typeof TC.Accessories.drawHud === 'function') TC.Accessories.drawHud(ctx);
    drawDebug(ctx);
    if (TC.Debug && typeof TC.Debug.drawHud === 'function') TC.Debug.drawHud(ctx, viewW, viewH);
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
    while (acc >= STEP) { step(STEP); acc -= STEP; }
    if (TC.Debug && typeof TC.Debug.frame === 'function') TC.Debug.frame(dt);
    draw();
    if (TC.Input) TC.Input.endFrame();
    requestAnimationFrame(frame);
  }

  // ---- boot ----
  if (TC.Input) TC.Input.init(canvas);
  if (TC.Registry) {
    TC.Registry.syncFromTables();
    try { TC.Registry.validate(); } catch (e) { console.warn('[TC] registry validation:', e.message); }
  }
  if (TC.Systems && TC.Systems.runBoot) TC.Systems.runBoot();
  requestAnimationFrame(frame);
})();

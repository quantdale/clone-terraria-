/* debug.js — TC.Debug: engine instrumentation + restricted test hooks.
   Dev-only surface (docs/terraria-parity/testing-ci-release.md §8):
     - rolling timings: mark()/endMark() spans rolled up once per frame by
       frame(), queried via stats(name)
     - plain counters: inc()/snapshot()
     - F3 overlay: drawHud(ctx,w,h), renders ONLY when TC.debug is true
       (main.js owns the toggle; the lead wires both calls)
     - window.__TEST__ automation hooks, attached ONLY when
       location.hash === '#test' — never otherwise.
   Zero gameplay impact when unused: no Systems registration, no state
   mutation outside these maps, every cross-module read guarded. No
   Math.random anywhere. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Debug) return;                        // load-once guard

  const warned = Object.create(null);
  function warnOnce(msg) {
    if (warned[msg]) return;
    warned[msg] = true;
    console.warn('[TC.Debug] ' + msg);
  }

  // ====================================================================
  // Rolling timings
  // ====================================================================

  const WINDOW = 120;                          // samples kept per name (~2s @60fps)
  const FRAME_KEY = 'frame';                   // auto sample recorded by frame()

  const rings = new Map();                     // name -> {buf, head, count}
  const openSpans = new Map();                 // name -> performance.now() at mark()
  const pending = new Map();                   // name -> accumulated ms this frame

  function pushSample(name, ms) {
    let r = rings.get(name);
    if (!r) { r = { buf: new Float64Array(WINDOW), head: 0, count: 0 }; rings.set(name, r); }
    r.buf[r.head] = ms;
    r.head = (r.head + 1) % WINDOW;
    if (r.count < WINDOW) r.count++;
  }

  // Open a named span; re-marking an open name restarts it.
  function mark(name) {
    if (typeof name === 'string' && name) openSpans.set(name, performance.now());
  }

  // Close a span opened by mark(); its duration joins the current frame.
  function endMark(name) {
    const t0 = (typeof name === 'string') ? openSpans.get(name) : undefined;
    if (t0 === undefined) return;
    openSpans.delete(name);
    const d = performance.now() - t0;
    pending.set(name, (pending.get(name) || 0) + d);
  }

  // Lead calls once per rendered frame with the rAF delta (seconds): commits
  // every marked span as one sample per name and records the delta itself as
  // the 'frame' pacing sample (wall-clock — includes vsync idle; use
  // mark/endMark around subsystem work for true CPU costs).
  function frame(dt) {
    for (const [name, ms] of pending) pushSample(name, ms);
    pending.clear();
    if (typeof dt === 'number' && isFinite(dt) && dt >= 0) pushSample(FRAME_KEY, dt * 1000);
  }

  // {avgMs, maxMs, samples} over the retained window; zeros when unknown.
  function stats(name) {
    const r = rings.get(name);
    if (!r || !r.count) return { avgMs: 0, maxMs: 0, samples: 0 };
    let sum = 0, max = 0;
    for (let i = 0; i < r.count; i++) {
      const v = r.buf[i];
      sum += v;
      if (v > max) max = v;
    }
    return { avgMs: sum / r.count, maxMs: max, samples: r.count };
  }

  function forEachSample(name, fn) {
    const r = rings.get(name);
    if (!r) return;
    for (let i = 0; i < r.count; i++) fn(r.buf[i]);
  }

  // ====================================================================
  // Counters
  // ====================================================================

  const counters = Object.create(null);

  function inc(name, delta) {
    if (typeof name !== 'string' || !name) return;
    const d = (typeof delta === 'number' && isFinite(delta)) ? delta : 1;
    counters[name] = (counters[name] || 0) + d;
  }

  // Plain-object copy of all counter values.
  function snapshot() {
    const out = {};
    for (const k in counters) out[k] = counters[k];
    return out;
  }

  // ====================================================================
  // F3 overlay — screen space, drawn only while TC.debug is true
  // ====================================================================

  function guardedCall(ns, fnName) {
    const mod = TC[ns];
    if (!mod || typeof mod[fnName] !== 'function') return null;
    try { return mod[fnName](); } catch (err) { return null; }
  }

  function collectLines() {
    const lines = [];
    lines.push('fps ' + ((typeof TC.fps === 'number') ? TC.fps.toFixed(0) : '?'));

    const f = stats(FRAME_KEY);
    if (f.samples) {
      const b = [0, 0, 0, 0];
      forEachSample(FRAME_KEY, (ms) => {
        if (ms < 4) b[0]++; else if (ms < 8) b[1]++; else if (ms < 16) b[2]++; else b[3]++;
      });
      lines.push('frame ' + f.avgMs.toFixed(1) + '/' + f.maxMs.toFixed(1) +
                 'ms  <4:' + b[0] + ' 4-8:' + b[1] + ' 8-16:' + b[2] + ' 16+:' + b[3]);
    }

    const marks = [];
    for (const name of rings.keys()) {
      if (name === FRAME_KEY) continue;
      marks.push(name + ' ' + stats(name).avgMs.toFixed(2) + 'ms');
    }
    if (marks.length) lines.push('timings ' + marks.join(' '));

    const liq = guardedCall('Liquids', 'stats');
    if (liq) lines.push('liquids cells ' + (liq.cells | 0) + ' active ' + (liq.active | 0));

    // Runtime-authority observability: tick number, scheduler phase, command
    // queue depth and lifetime processed/rejected counts.
    const rt = guardedCall('Runtime', 'getState');
    if (rt) {
      lines.push('tick ' + rt.tickCount + ' phase ' + (rt.currentPhase || 'idle') +
                 ' cmds ' + (rt.pendingCommands | 0) + '/' + (rt.commandsProcessed | 0) +
                 ' rej ' + (rt.commandsRejected | 0));
    }

    const proj = guardedCall('Projectiles', 'activeCount');
    if (proj != null) lines.push('projectiles ' + (proj | 0));

    if (TC.Enemies && TC.Enemies.list) lines.push('enemies ' + TC.Enemies.list.length);
    if (TC.Items && TC.Items.drops) lines.push('drops ' + TC.Items.drops.length);

    const flags = guardedCall('Progression', 'all');
    if (flags) lines.push('flags ' + (flags.length ? flags.join(', ') : 'none'));
    // WOF encounter observability (W17): state/phase/elapsed/servants/projectiles
    try {
      const wof = (TC.Enemies && typeof TC.Enemies.getWofEncounter === 'function') ? TC.Enemies.getWofEncounter() : null;
      if (wof) {
        lines.push('wof ' + wof.state + ' p' + wof.phase + ' ' + (wof.elapsed || 0).toFixed(1) + 's hp' + (wof.hpFrac * 100 | 0) + '% dir' + (wof.dir > 0 ? '→' : '←'));
        lines.push('wof servants ' + wof.servants + '/' + wof.peakServants + ' proj ' + (TC.Projectiles ? TC.Projectiles.activeCount() : '?') + '/' + wof.peakProjectiles + ' trans ' + wof.transitions + (wof.despawnReason ? ' despawn:' + wof.despawnReason : ''));
      }
    } catch (e) {}
    return lines;
  }

  // Screen-space HUD text continuing main.js's own F3 block: that starts at
  // y=240 and tops out at 7 lines, so begin two rows below its maximum.
  function drawHud(ctx, w, h) {
    if (!TC.debug) return;
    const lines = collectLines();
    ctx.save();
    ctx.font = '12px monospace';
    ctx.fillStyle = '#fff';
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 8, 352 + i * 14);
    ctx.restore();
  }

  // ====================================================================
  // __TEST__ hooks — attached ONLY when location.hash === '#test'
  // ======================================================================

  function testMode() {
    try { return window.location.hash === '#test'; } catch (err) { return false; }
  }

  // Build a fresh world through the real game service. Returns
  // {ok:true, seed, state} or null on failure.
  function newWorld(seed) {
    if (typeof TC.newGame !== 'function') return null;
    try { TC.newGame(seed == null ? undefined : (seed | 0)); }
    catch (err) { warnOnce('newWorld: ' + err); return null; }
    return { ok: true, seed: TC.worldSeed, state: TC.state };
  }

  // Direct placement (no teleport service exists). Zeroes velocity so tests
  // start deterministic. Returns {x,y} or null.
  function teleportPlayer(x, y) {
    const p = TC.player;
    if (!p || typeof x !== 'number' || !isFinite(x) ||
        typeof y !== 'number' || !isFinite(y)) return null;
    p.x = x;
    p.y = y;
    if (typeof p.vx === 'number') p.vx = 0;
    if (typeof p.vy === 'number') p.vy = 0;
    return { x: p.x, y: p.y };
  }

  // Returns the number of items ACTUALLY added (inventory may be full).
  function giveItem(id, count) {
    const inv = TC.player && TC.player.inventory;
    if (!inv || typeof inv.add !== 'function') return 0;
    const n = (typeof count === 'number' && isFinite(count)) ? Math.floor(count) : 0;
    if (!id || !(n > 0)) return 0;
    try {
      const left = inv.add(id, n);
      return n - left;
    } catch (err) { warnOnce('giveItem: ' + err); return 0; }
  }

  // Delegates to Enemies' own spawn path — never hand-builds enemy objects:
  // a generic spawner if enemies.js grows one (spawnEnemy/spawn), else
  // spawnBoss. Today that means boss types spawn; regular types return null
  // until Enemies exposes a generic entry point.
  function spawnEnemy(type, x, y) {
    const E = TC.Enemies;
    if (!E || typeof type !== 'string' || !type) return null;
    if (!(TC.ENEMY_DEFS && TC.ENEMY_DEFS[type])) {
      warnOnce('spawnEnemy: unknown enemy type "' + type + '"');
      return null;
    }
    try {
      if (typeof E.spawnEnemy === 'function') return E.spawnEnemy(type, x, y);
      if (typeof E.spawn === 'function') return E.spawn(type, x, y);
      if (typeof E.spawnBoss === 'function') {
        const e = E.spawnBoss(type, x, y);
        if (!e && !TC.ENEMY_DEFS[type].boss) {
          warnOnce('spawnEnemy: "' + type + '" needs a generic Enemies spawn path (only bosses reachable today)');
        }
        return e;
      }
    } catch (err) { warnOnce('spawnEnemy: ' + err); return null; }
    warnOnce('spawnEnemy: TC.Enemies exposes no spawn path');
    return null;
  }

  function numOrNull(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  // Plain serializable snapshot for assertions.
  function getStateSnapshot() {
    const p = TC.player;
    return {
      state: (TC.state == null) ? null : TC.state,
      seed: numOrNull(TC.worldSeed),
      playerPos: p ? { x: numOrNull(p.x), y: numOrNull(p.y) } : null,
      hp: p ? numOrNull(p.hp) : null,
      enemies: (TC.Enemies && TC.Enemies.list) ? TC.Enemies.list.length : 0,
      drops: (TC.Items && TC.Items.drops) ? TC.Items.drops.length : 0
    };
  }

  // Flush a save through TC.Save. true/false on result, null when unusable.
  function saveNow() {
    if (!TC.Save || typeof TC.Save.save !== 'function') return null;
    try { return !!TC.Save.save(); }
    catch (err) { warnOnce('saveNow: ' + err); return null; }
  }
  function getWofEncounter() {
    try {
      if (TC.Enemies && typeof TC.Enemies.getWofEncounter === 'function') return TC.Enemies.getWofEncounter();
    } catch (e) {}
    return null;
  }
  function setWofHp(frac) {
    try {
      const list = TC.Enemies && TC.Enemies.list;
      if (!list) return false;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.def && e.def.ai === 'wof') {
          const f = Math.max(0, Math.min(1, Number(frac)));
          e.hp = Math.max(1, Math.round(e.maxHp * f));
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // Read-only runtime authority snapshot for browser regression proofs:
  // scheduler registrations, per-tick execution counts, render-layer dispatch
  // counters, command queue state. No mutable production cheats here.
  function getRuntimeState() {
    try { return (TC.Runtime && typeof TC.Runtime.getState === 'function') ? TC.Runtime.getState() : null; }
    catch (e) { return null; }
  }

  if (testMode()) {
    // loadFixture deliberately absent — no fixture system exists yet; harnesses
    // must feature-detect ('loadFixture' in window.__TEST__ === false).
    window.__TEST__ = {
      newWorld: newWorld,
      teleportPlayer: teleportPlayer,
      giveItem: giveItem,
      spawnEnemy: spawnEnemy,
      getStateSnapshot: getStateSnapshot,
      saveNow: saveNow,
      getWofEncounter: getWofEncounter,
      setWofHp: setWofHp,
      getRuntimeState: getRuntimeState
    };
  }

  TC.Debug = {
    mark: mark, endMark: endMark, frame: frame, stats: stats,
    inc: inc, snapshot: snapshot, drawHud: drawHud
  };
})();

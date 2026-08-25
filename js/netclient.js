/* netclient.js — TC.NetClient: the joining side of the W22 authoritative
   multiplayer slice (NET-003).

   The client NEVER owns game truth. It:
     - samples its continuous input every tick and ships it as an 'input'
       frame (sequence-numbered; the server rejects stale/duplicate samples);
     - proposes discrete intents ('cmd') that the server validates and runs
       through canonical TC.Commands transactions;
     - applies authoritative snapshots / incremental region deltas into a
       local PRESENTATION mirror (world tiles+walls, entity poses, inventory);
     - renders the mirror through the production pipeline (RenderLayers,
       Lighting, MiniMap all consume the mirror exactly as in single-player);
     - resynchronizes explicitly after a reconnect: identity -> tick ->
       relevant-region snapshot -> resume increments.

   While joined, the client does NOT drive TC.Runtime.tick: main.js routes
   fixed steps to TC.NetClient.frame(dt), which advances only presentation +
   input sampling. No enemy AI, spawning, combat or liquid simulation runs
   locally — everything observable arrives replicated from the authority. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const P = TC.NetProto;
  const STEP = 1 / 60;

  const DEF = {
    ackEveryTicks: 15,
    maxAckedPerMsg: 64,
    enemyLingerTicks: 120,     // unreported enemy mirrors fade after ~2s
    cmdRateLimit: 32           // outbound intents buffered per tick cap
  };

  let activeInstance = null;

  function NetClient(opts) {
    opts = opts || {};
    this.opts = Object.assign({}, DEF, opts);
    this.ep = null;
    this.name = opts.name || 'Player';
    this.phase = 'idle';        // idle|connecting|syncing|playing|closed
    this.sid = null; this.pid = null;
    this.seed = null;
    this.cseqInput = 0; this.cseqCmd = 0;
    this.sseqFloor = 0; this.lastSseq = 0;
    this.inbox = [];
    this.tickCount = 0;
    this.pendingAcks = [];
    this.enemyMirror = new Map();  // eid string -> {enemy, lastSeen}
    this.dropMirror = [];
    this.status = null;            // last human-readable status line key
    this.stats = {
      msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0,
      regionsApplied: 0, cellsApplied: 0, snapshotsApplied: 0,
      rejectedIn: 0, resyncsRequested: 0, reconnects: 0,
      cmdResultsOk: 0, cmdResultsFailed: 0
    };
  }

  NetClient.prototype.isActive = function () {
    return this.phase === 'syncing' || this.phase === 'playing';
  };

  // ---- connection ----
  NetClient.prototype.connect = function (ep, rejoin) {
    if (!ep) return { ok: false, error: 'no-endpoint' };
    this.ep = ep;
    this.phase = 'connecting';
    this.status = 'ui.net.connecting';
    const self = this;
    ep.onMessage(function (raw) {
      if (typeof raw === 'string' && self.inbox.length < 512) self.inbox.push(raw);
    });
    ep.onStatus(function (st) {
      if ((st === 'closed' || st === 'error') && self.isActive()) {
        self._onLinkDown();
      }
    });
    const hello = { v: P.VERSION, t: 'hello', sid: null, pid: null, cseq: 1, sseq: 0, tick: 0, p: { name: String(this.name).slice(0, 24) } };
    if (rejoin && rejoin.sid && rejoin.pid) {
      hello.p.rejoin = { sid: String(rejoin.sid), pid: String(rejoin.pid), tick: (rejoin.tick | 0) || 0 };
    }
    this._rawSend(hello);
    return { ok: true };
  };

  NetClient.prototype._rawSend = function (msg) {
    const raw = P.encode(msg);
    if (raw == null) return false;
    this.stats.msgsOut++;
    this.stats.bytesOut += raw.length;
    return !!this.ep.send(raw);
  };

  NetClient.prototype.disconnect = function (reason) {
    if (this.ep && this.isActive()) {
      this._rawSend({ v: P.VERSION, t: 'bye', sid: this.sid, pid: this.pid, cseq: 0, sseq: 0, tick: 0, p: { reason: String(reason || 'client-bye').slice(0, 64) } });
    }
    try { if (this.ep) this.ep.close(reason || 'client-bye'); } catch (e) {}
    this._teardown('ui.net.disconnected');
  };

  NetClient.prototype._teardown = function (statusKey) {
    this.phase = 'closed';
    this.status = statusKey || null;
    this._clearMirrors();
    if (activeInstance === this) activeInstance = null;
  };

  NetClient.prototype._clearMirrors = function () {
    // Remove remote player mirrors and replicated entities from the live
    // registry so nothing leaks into a later session.
    for (const rec of TC.Players.entries()) {
      if (rec.remote) TC.Players.remove(rec.id);
    }
    this.enemyMirror.clear();
    if (TC.Enemies && TC.Enemies.clear) TC.Enemies.clear();
    if (TC.Items && TC.Items.clearDrops) TC.Items.clearDrops();
  };

  NetClient.prototype._onLinkDown = function () {
    // Explicit-state transition: the client never silently keeps playing a
    // stale mirror. UI surfaces the disconnect; reconnect is user-driven or
    // retried via tryReconnect().
    this.phase = 'closed';
    this.status = 'ui.net.link_lost';
  };

  NetClient.prototype.tryReconnect = function (epFactory) {
    if (!this.sid || !this.pid) return { ok: false, error: 'nothing-to-resume' };
    const ep = epFactory ? epFactory() : null;
    if (!ep) return { ok: false, error: 'no-transport' };
    this.stats.reconnects++;
    this.sseqFloor = this.lastSseq;
    return this.connect(ep, { sid: this.sid, pid: this.pid, tick: this.tickCount });
  };

  // ---- message pump (called once per fixed step BEFORE rendering) ----
  NetClient.prototype._pump = function () {
    let n = 128;
    while (this.inbox.length && n-- > 0) {
      const raw = this.inbox.shift();
      const v = P.decode(raw);
      if (!v.ok) { this.stats.rejectedIn++; continue; }
      const m = v.msg;
      if (m.sid !== null && m.sid !== undefined && this.sid && m.sid !== this.sid) {
        this.stats.rejectedIn++; continue;          // wrong session: stale relay
      }
      if (m.sseq && m.sseq <= this.sseqFloor) {
        this.stats.rejectedIn++; continue;          // pre-resync generation
      }
      if (m.sseq) {
        if (m.sseq <= this.lastSseq) { this.stats.rejectedIn++; continue; }
        this.lastSseq = m.sseq;
      }
      this.stats.msgsIn++;
      this.stats.bytesIn += raw.length;
      this._handle(m);
    }
  };

  NetClient.prototype._handle = function (m) {
    switch (m.t) {
      case 'welcome':
        this.sid = m.sid; this.pid = m.p.you.pid; this.seed = m.p.seed;
        this.phase = 'syncing';
        break;
      case 'reject':
        this.status = 'ui.net.rejected';
        this._teardown(this.status);
        break;
      case 'snapshot': this._onSnapshot(m); break;
      case 'worldupd': this._onWorldUpd(m); break;
      case 'cmdres':
        if (m.p.ok) {
          this.stats.cmdResultsOk++;
        } else {
          this.stats.cmdResultsFailed++;
          this.lastCmdError = String((m.p && m.p.error) || 'rejected').slice(0, 64);
        }
        break;
      case 'bye':
        this.status = 'ui.net.server_closed';
        this._teardown(this.status);
        break;
      default:
        // hello/input/cmd/ack/resync never flow S->C.
        this.stats.rejectedIn++;
    }
  };

  // ---- mirror application ----
  NetClient.prototype._ensureMirrorWorld = function () {
    if (TC.world && TC.worldSeed === this.seed) return true;
    if (!TC.Runtime || !TC.Runtime.createWorld) return false;
    TC.Runtime.createWorld(this.seed == null ? 1337 : this.seed);
    return !!TC.world;
  };

  NetClient.prototype._ensureOwnPlayer = function () {
    if (!TC.player) {
      const w = TC.world, gen = w ? { spawnX: Math.floor(w.width / 2), spawnY: w.surfaceY ? w.surfaceY[Math.floor(w.width / 2)] : 40 } : null;
      void gen;
      TC.player = new TC.Player(0, 0);
    }
    if (!TC.Players.primaryId()) TC.Players.create(TC.player, { id: this.pid || 'p1', primary: true });
  };

  NetClient.prototype._applyRegionLine = function (r) {
    const R = TC.WorldRegions;
    const w = TC.world;
    if (!w || !R) return;
    const coords = R.chunkCoords(r.idx);
    const TSZ = R.CHUNK;
    const baseX = coords.cx * TSZ, baseY = coords.cy * TSZ;
    if (r.tiles && typeof r.tiles === 'string' && r.walls && typeof r.walls === 'string') {
      // full layers
      const tiles = this._unhex(r.tiles);
      const walls = this._unhex(r.walls);
      for (let y = 0; y < TSZ; y++) {
        const wy = baseY + y;
        if (wy >= w.height) break;
        for (let x = 0; x < TSZ; x++) {
          const wx = baseX + x;
          if (wx >= w.width) break;
          const o = y * TSZ + x;
          const t = tiles[o], wl = walls[o];
          if (w.tiles[wy * w.width + wx] !== t) w.setRaw(wx, wy, t);
          if (w.walls && w.getWall(wx, wy) !== wl) w.setRawWall(wx, wy, wl);
        }
      }
      this.stats.regionsApplied++;
      this.stats.cellsApplied += TSZ * TSZ;
    } else if (Array.isArray(r.cells)) {
      const tiles = new Uint8Array(TSZ * TSZ);
      const walls = new Uint8Array(TSZ * TSZ);
      for (let y = 0; y < TSZ; y++) {
        const wy = baseY + y;
        if (wy >= w.height) break;
        for (let x = 0; x < TSZ; x++) {
          const wx = baseX + x;
          if (wx >= w.width) break;
          const o = y * TSZ + x;
          tiles[o] = w.tiles[wy * w.width + wx];
          walls[o] = w.walls ? w.walls[wy * w.width + wx] : 0;
        }
      }
      P.applyCells(tiles, walls, r.cells);
      for (let i = 0; i < r.cells.length; i++) {
        const c = r.cells[i];
        const wx = baseX + (c[0] % TSZ), wy = baseY + ((c[0] / TSZ) | 0);
        if (wx >= w.width || wy >= w.height) continue;
        const curT = w.tiles[wy * w.width + wx];
        const curW = w.walls ? w.walls[wy * w.width + wx] : 0;
        if (curT !== c[1]) w.setRaw(wx, wy, c[1]);
        if (w.walls && curW !== c[2]) w.setRawWall(wx, wy, c[2]);
      }
      this.stats.regionsApplied++;
      this.stats.cellsApplied += r.cells.length;
    }
    if (r.rev != null) {
      this.pendingAcks.push([r.idx, r.rev]);
      if (this.pendingAcks.length > this.opts.maxAckedPerMsg * 4) this._flushAcks(true);
    }
  };

  NetClient.prototype._unhex = function (s) {
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(s.substr(i * 2, 2), 16) | 0;
    }
    return out;
  };

  NetClient.prototype._applyEntitySnap = function (snap) {
    if (snap.id.charAt(0) === 'e') { this._applyEnemySnap(snap); return; }
    // player mirror
    if (this.pid && snap.id === this.pid) {
      const p = TC.player;
      if (p) {
        p.x = snap.x; p.y = snap.y; p.vx = snap.vx; p.vy = snap.vy;
        p.hp = snap.hp; p.maxHp = snap.maxHp;
        if (typeof snap.face === 'number') p.facing = snap.face;
      }
      return;
    }
    let rec = TC.Players.entry(snap.id);
    if (!rec) {
      const proxy = new TC.Player(snap.x, snap.y);
      proxy.remote = true;
      proxy.hp = snap.hp; proxy.maxHp = snap.maxHp;
      rec = TC.Players.create(proxy, { id: snap.id, remote: true, name: snap.name });
      if (!rec) return;
    }
    const pl = rec.player;
    pl.x = snap.x; pl.y = snap.y; pl.vx = snap.vx; pl.vy = snap.vy;
    pl.hp = snap.hp; pl.maxHp = snap.maxHp;
    if (typeof snap.face === 'number') pl.facing = snap.face;
  };

  NetClient.prototype._applyEnemySnap = function (snap) {
    let m = this.enemyMirror.get(snap.id);
    if (!m) {
      const def = (TC.ENEMY_DEFS && TC.ENEMY_DEFS[snap.type]) || null;
      if (!def) return;
      const e = {
        eid: snap.id.slice(1) | 0,
        type: snap.type, def: def,
        x: snap.x, y: snap.y, w: def.w, h: def.h,
        vx: snap.vx, vy: snap.vy, hp: snap.hp, maxHp: snap.maxHp,
        facing: snap.face || 1, mirror: true, flashTimer: 0
      };
      m = { enemy: e, lastSeen: this.tickCount };
      this.enemyMirror.set(snap.id, m);
      if (TC.Enemies && Array.isArray(TC.Enemies.list)) TC.Enemies.list.push(e);
    }
    const e = m.enemy;
    e.x = snap.x; e.y = snap.y; e.vx = snap.vx; e.vy = snap.vy;
    e.hp = snap.hp; e.maxHp = snap.maxHp;
    e.facing = snap.face || 1;
    m.lastSeen = this.tickCount;
  };

  NetClient.prototype._decayEnemyMirrors = function () {
    for (const [key, m] of Array.from(this.enemyMirror.entries())) {
      if (this.tickCount - m.lastSeen > this.opts.enemyLingerTicks) {
        const list = TC.Enemies && TC.Enemies.list;
        if (list) {
          const i = list.indexOf(m.enemy);
          if (i >= 0) list.splice(i, 1);
        }
        this.enemyMirror.delete(key);
      }
    }
  };

  NetClient.prototype._onSnapshot = function (m) {
    if (!this._ensureMirrorWorld()) return;
    this._ensureOwnPlayer();
    for (let i = 0; i < m.p.regions.length; i++) this._applyRegionLine(m.p.regions[i]);
    const lines = m.p.players.concat(m.p.enemies);
    for (let i = 0; i < lines.length; i++) this._applyEntitySnap(lines[i]);
    this.stats.snapshotsApplied++;
    this._flushAcks(true);
    if (m.p.reason !== 'streaming') {
      // Final snapshot packet carries the join/resync payload bundle.
      this.phase = 'playing';
      this.status = null;
      if (TC.Events && TC.Events.EVENT && TC.Events.emit) {
        try { TC.Events.emit(TC.Events.EVENT.WorldLoaded, { seed: this.seed, net: true }); } catch (e) {}
      }
    }
  };

  NetClient.prototype._onWorldUpd = function (m) {
    if (!TC.world) return;
    for (let i = 0; i < m.p.regions.length; i++) this._applyRegionLine(m.p.regions[i]);
    const lines = m.p.players.concat(m.p.enemies);
    for (let i = 0; i < lines.length; i++) this._applyEntitySnap(lines[i]);
    // authoritative self-inventory refresh: the client UI reads its own
    // slots, so the mirror must track server truth for hotbar/crafting
    if (Array.isArray(m.p.inv) && TC.player && TC.player.inventory) {
      const inv = TC.player.inventory;
      for (let i = 0; i < m.p.inv.length && i < inv.slots.length; i++) {
        const line = m.p.inv[i];
        const cur = inv.get(i);
        const want = line ? { id: line[0], count: line[1] } : null;
        if ((cur == null) !== (want == null) ||
            (cur && want && (cur.id !== want.id || cur.count !== want.count))) {
          inv.slots[i] = want;
        }
      }
    }
    this._decayEnemyMirrors();
    this._flushAcks(false);
  };

  NetClient.prototype._flushAcks = function (force) {
    if (!this.pendingAcks.length) return;
    if (!force && (this.tickCount % this.opts.ackEveryTicks) !== 0) return;
    const take = this.pendingAcks.splice(0, this.opts.maxAckedPerMsg);
    this._rawSend({
      v: P.VERSION, t: 'ack', sid: this.sid, pid: this.pid,
      cseq: 0, sseq: 0, tick: this.tickCount,
      p: { upto: { sseq: this.lastSseq, tick: this.tickCount }, regions: take }
    });
  };

  // ---- outbound: continuous input ----
  NetClient.prototype._sampleInput = function () {
    if (!this.pid || !this.ep || !this.ep.open) return;
    const inp = TC.Input;
    const axis = inp && inp.axis ? inp.axis() : { x: 0, jump: false };
    const m = inp && inp.mouse ? inp.mouse : { worldX: 0, worldY: 0, down: false };
    const p = TC.player;
    this._rawSend({
      v: P.VERSION, t: 'input', sid: this.sid, pid: this.pid,
      cseq: ++this.cseqInput, sseq: 0, tick: this.tickCount,
      p: {
        btn: [axis.x | 0, axis.jump ? 1 : 0,
              (inp && inp.down && (inp.down('KeyS') || inp.down('ArrowDown'))) ? 1 : 0],
        aimX: m.worldX, aimY: m.worldY,
        use: m.down ? 1 : 0,
        slot: p ? (p.hotbarIndex | 0) : 0
      }
    });
  };

  // ---- outbound: discrete intents ----
  NetClient.prototype.sendCmd = function (name, ctx) {
    if (!this.isActive()) return { ok: false, error: 'not-connected' };
    const safe = {};
    if (ctx) {
      for (const k in ctx) {
        const v = ctx[k];
        if (typeof v === 'number' && isFinite(v)) safe[k] = v;
        else if (typeof v === 'string') safe[k] = v.slice(0, 64);
        else if (typeof v === 'boolean') safe[k] = v ? 1 : 0;
      }
    }
    return this._rawSend({
      v: P.VERSION, t: 'cmd', sid: this.sid, pid: this.pid,
      cseq: ++this.cseqCmd, sseq: 0, tick: this.tickCount,
      p: { name: name, ctx: safe }
    }) ? { ok: true } : { ok: false, error: 'encode-failed' };
  };

  // Real-input convenience intents (used by the developer join flow): mine /
  // place proposals derived from the held item and cursor, mirroring what the
  // local player-intent system produces in single-player. The server still
  // validates reach, tool, occupancy and payment authoritatively.
  NetClient.prototype.sendCursorIntents = function () {
    const p = TC.player, inp = TC.Input;
    if (!p || !inp || !inp.mouse || !inp.mouse.down) return;
    const sel = p.selectedSlot ? p.selectedSlot() : null;
    const d = sel ? (TC.ITEM_DEFS && TC.ITEM_DEFS[sel.id]) : null;
    if (!d) return;
    const tx = Math.floor(inp.mouse.worldX / TC.CONST.TS);
    const ty = Math.floor(inp.mouse.worldY / TC.CONST.TS);
    if (d.kind === 'pick' || d.kind === 'axe') {
      this.sendCmd(d.kind === 'pick' ? 'MineTile' : 'MineTile', {
        tx: tx, ty: ty, toolPower: d.power || 1, tool: d.kind, dt: STEP
      });
    } else if (d.tile != null) {
      this.sendCmd('PlaceTile', { tx: tx, ty: ty, item: sel.id, slot: p.hotbarIndex });
    } else {
      this.sendCmd('UseItem', { slot: p.hotbarIndex, aimX: inp.mouse.worldX, aimY: inp.mouse.worldY, dt: STEP });
    }
  };

  // ---- fixed-step driver (main.js routes ticks here while joined) ----
  NetClient.prototype.frame = function (dt) {
    if (this.phase === 'idle' || this.phase === 'closed') return;
    this.tickCount++;
    this._pump();          // handshake traffic must flow before 'playing'
    this._sampleInput();
    if (this.phase !== 'playing') return;
    if (this.tickCount % 3 === 0) this.sendCursorIntents();

    // presentation-only advancement of the mirror
    if (TC.Sky) TC.Sky.update(dt);
    if (TC.Biomes) TC.Biomes.update(dt);
    if (TC.world) TC.world.update(dt);
    if (TC.Lighting) TC.Lighting.update(dt, TC.camera);
    if (TC.MiniMap) TC.MiniMap.update(dt);
    if (TC.Particles) TC.Particles.update(dt);
    if (TC.UI) TC.UI.update(dt);

    // camera follow (mirrors runtime.updateCamera without touching it)
    const cam = TC.camera;
    const canvas = TC.canvas;
    const p = TC.player;
    if (cam && TC.world && p) {
      const viewW = (canvas && canvas.width) || 800, viewH = (canvas && canvas.height) || 600;
      const TS = TC.CONST.TS;
      const wpx = TC.world.width * TS, hpx = TC.world.height * TS;
      const vw = viewW / cam.zoom, vh = viewH / cam.zoom;
      let tx = p.x + p.w / 2 - vw / 2, ty = p.y + p.h / 2 - vh / 2;
      tx = (wpx <= vw) ? (wpx - vw) / 2 : Math.max(0, Math.min(wpx - vw, tx));
      ty = (hpx <= vh) ? (hpx - vh) / 2 : Math.max(0, Math.min(hpx - vh, ty));
      cam.x += (tx - cam.x) * 0.18;
      cam.y += (ty - cam.y) * 0.18;
    }

    if (TC.Events && TC.Events.flush) TC.Events.flush();
  };

  NetClient.prototype.summary = function () {
    return {
      phase: this.phase, sid: this.sid, pid: this.pid,
      seed: this.seed, tick: this.tickCount,
      status: this.status, lastCmdError: this.lastCmdError || null,
      stats: this.stats
    };
  };

  TC.NetClient = {
    create: function (opts) { return new NetClient(opts); },
    VERSION: P.VERSION,
    // Static tick entry used by main.js's frame loop (routes to the active
    // instance; see drivesTick).
    frame: function (dt) { if (activeInstance) activeInstance.frame(dt); },
    // True while this realm must NOT run its local simulation: from the
    // moment a join attempt starts (handshake) until it ends, fixed steps
    // belong to TC.NetClient.frame (input sampling + mirror application).
    drivesTick: function () {
      const c = activeInstance;
      return !!(c && c.ep && c.phase !== 'idle' && c.phase !== 'closed');
    },
    active: function () { return activeInstance; },
    _setActive: function (c) { activeInstance = c; }
  };

  // create() self-registers the instance so main.js can route ticks and
  // query session state without extra wiring.
  const origCreate = TC.NetClient.create;
  TC.NetClient.create = function (opts) {
    const c = origCreate(opts);
    activeInstance = c;
    return c;
  };
})();

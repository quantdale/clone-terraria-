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
    cmdRateLimit: 32,          // outbound intents buffered per tick cap
    // ---- W23 latency masking ----
    interp: true,              // presentation-only remote interpolation
    interpDelayTicks: 4,       // render this far behind the newest snapshot
    interpBufferSize: 10,
    teleportDistPx: 96,        // larger gaps snap (spawn/teleport/corrections)
    predict: true,             // local locomotion prediction for SELF
    predictBlend: 0.22,        // soft reconciliation factor per frame
    predictHardSnapPx: 72      // divergence beyond this snaps outright
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
    this.enemyMirror = new Map();  // eid string -> {enemy, lastSeen, buf}
    this.playerBufs = new Map();   // remote pid -> {player, buf}
    this.dropMirror = new Map();   // 'd<did>' string -> {drop, lastSeen}
    this.selfCorr = null;          // latest authoritative self state
    this.inputHist = [];           // recent predicted inputs [{seq, x, jump, down}]
    this.status = null;            // last human-readable status line key
    this.stats = {
      msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0,
      regionsApplied: 0, cellsApplied: 0, snapshotsApplied: 0,
      rejectedIn: 0, resyncsRequested: 0, reconnects: 0,
      cmdResultsOk: 0, cmdResultsFailed: 0,
      interpTeleports: 0, predSoftCorrections: 0, predHardSnaps: 0
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
    // A dropped session invalidates container authority cleanly.
    if (TC.UI && typeof TC.UI.closeChest === 'function') {
      try { TC.UI.closeChest(); } catch (e) {}
    }
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
    this.dropMirror.clear();
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
        // W23: authoritative post-command bundle — refresh the local mirror
        // immediately, and open the production chest panel when the server
        // confirmed a canonical InteractTile chest action.
        if (m.p.ok && m.p.result) {
          const rb = m.p.result;
          if (rb.inv) this._applyInvLines(rb.inv);
          if (rb.chest) {
            this._applyChestPayload(rb.chest);
            if (rb.action === 'chest' && TC.UI && typeof TC.UI.openChest === 'function') {
              try { TC.UI.openChest(rb.chest.tx, rb.chest.ty); } catch (e) {}
            }
          }
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
    const LQ = TC.Liquids && typeof TC.Liquids.applyMirrorRegion === 'function'
      ? TC.Liquids : null;
    if (r.tiles && typeof r.tiles === 'string' && r.walls && typeof r.walls === 'string') {
      // full layers — v3 lines carry liquid truth; a dry region omits the
      // pair, and that absence is authoritative "no liquid here"
      const tiles = this._unhex(r.tiles);
      const walls = this._unhex(r.walls);
      const hasLiquid = r.ltype !== undefined && r.lamt !== undefined;
      const ltype = hasLiquid ? this._unhex(r.ltype) : null;
      const lamt = hasLiquid ? this._unhex(r.lamt) : null;
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
      if (LQ) {
        if (hasLiquid) {
          // Presentation-only mirror write; marks local WorldRegions so
          // renderer/minimap/lighting repaint. No gameplay events, no settle.
          LQ.applyMirrorRegion(baseX, baseY, TSZ, ltype, lamt);
        } else {
          LQ.applyMirrorRegion(baseX, baseY, TSZ,
            new Uint8Array(TSZ * TSZ), new Uint8Array(TSZ * TSZ));
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
      let ltype = null, lamt = null;
      if (LQ && r.cells.length && r.cells[0].length >= 5) {
        // seed delta buffers with current mirror state so unchanged cells
        // restate identically and the mirror write only repaints real diffs
        const snap = LQ.snapshotRegion(baseX, baseY, TSZ);
        ltype = snap.type; lamt = snap.amount;
      }
      P.applyCells(tiles, walls, r.cells, ltype, lamt);
      for (let i = 0; i < r.cells.length; i++) {
        const c = r.cells[i];
        const wx = baseX + (c[0] % TSZ), wy = baseY + ((c[0] / TSZ) | 0);
        if (wx >= w.width || wy >= w.height) continue;
        const curT = w.tiles[wy * w.width + wx];
        const curW = w.walls ? w.walls[wy * w.width + wx] : 0;
        if (curT !== c[1]) w.setRaw(wx, wy, c[1]);
        if (w.walls && curW !== c[2]) w.setRawWall(wx, wy, c[2]);
      }
      if (ltype && lamt) LQ.applyMirrorRegion(baseX, baseY, TSZ, ltype, lamt);
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
    if (snap.id.charAt(0) === 'd') { this._applyDropSnap(snap); return; }
    // player mirror — presence-based merge: a baselined delta may carry only
    // the fields that changed since the last acknowledged state.
    if (this.pid && snap.id === this.pid) {
      const p = TC.player;
      if (p) {
        if (snap.hp !== undefined) p.hp = snap.hp;
        if (snap.maxHp !== undefined) p.maxHp = snap.maxHp;
        if (typeof snap.face === 'number') p.facing = snap.face;
        // authoritative pose rides the prediction reconciler (WS4)
        if (this.opts.predict &&
            (snap.x !== undefined || snap.y !== undefined)) {
          this.selfCorr = {
            x: snap.x !== undefined ? snap.x : p.x,
            y: snap.y !== undefined ? snap.y : p.y,
            vx: snap.vx !== undefined ? snap.vx : null,
            vy: snap.vy !== undefined ? snap.vy : null
          };
        } else {
          if (snap.x !== undefined) p.x = snap.x;
          if (snap.y !== undefined) p.y = snap.y;
          if (snap.vx !== undefined) p.vx = snap.vx;
          if (snap.vy !== undefined) p.vy = snap.vy;
        }
      }
      return;
    }
    let rec = TC.Players.entry(snap.id);
    if (!rec) {
      // first sight requires a usable position; otherwise ignore until the
      // next keyframe carries the full line
      if (snap.x === undefined || snap.y === undefined) return;
      const proxy = new TC.Player(snap.x, snap.y);
      proxy.remote = true;
      if (snap.hp !== undefined) proxy.hp = snap.hp;
      if (snap.maxHp !== undefined) proxy.maxHp = snap.maxHp;
      rec = TC.Players.create(proxy, { id: snap.id, remote: true, name: snap.name });
      if (!rec) return;
    }
    const pl = rec.player;
    let bufRec = this.playerBufs.get(snap.id);
    if (!bufRec) {
      bufRec = { player: pl, buf: [] };
      this.playerBufs.set(snap.id, bufRec);
    }
    // hp/maxHp apply immediately; POSE goes through the interp buffer
    if (snap.hp !== undefined) pl.hp = snap.hp;
    if (snap.maxHp !== undefined) pl.maxHp = snap.maxHp;
    if (typeof snap.face === 'number') pl.facing = snap.face;
    if (!this.opts.interp) {
      if (snap.x !== undefined) pl.x = snap.x;
      if (snap.y !== undefined) pl.y = snap.y;
      if (snap.vx !== undefined) pl.vx = snap.vx;
      if (snap.vy !== undefined) pl.vy = snap.vy;
      return;
    }
    if (snap.x !== undefined || snap.y !== undefined ||
        snap.vx !== undefined || snap.vy !== undefined) {
      this._bufPush(bufRec.buf, {
        x: snap.x !== undefined ? snap.x : pl.x,
        y: snap.y !== undefined ? snap.y : pl.y,
        vx: snap.vx || 0, vy: snap.vy || 0,
        t: this.tickCount
      });
    }
  };

  // W23 explicit removals/tombstones: mirrors die immediately instead of
  // waiting out the linger timer.
  NetClient.prototype._applyRm = function (rm) {
    if (!rm) return;
    const ids = (k) => (Array.isArray(rm[k]) ? rm[k] : []);
    for (const id of ids('e')) {
      const m = this.enemyMirror.get(id);
      if (m) {
        const list = TC.Enemies && TC.Enemies.list;
        if (list) {
          const i = list.indexOf(m.enemy);
          if (i >= 0) list.splice(i, 1);
        }
        this.enemyMirror.delete(id);
      }
    }
    for (const id of ids('d')) this._removeDropMirror(id);
    for (const id of ids('p')) {
      if (id === this.pid) continue;            // never remove self
      if (TC.Players.entry(id)) TC.Players.remove(id);
      this.playerBufs.delete(id);
    }
  };

  NetClient.prototype._removeDropMirror = function (id) {
    const m = this.dropMirror.get(id);
    if (!m) return;
    const drops = (TC.Items && TC.Items.drops) || null;
    if (drops) {
      const i = drops.indexOf(m.drop);
      if (i >= 0) drops.splice(i, 1);
    }
    this.dropMirror.delete(id);
  };

  NetClient.prototype._applyDropSnap = function (snap) {
    if (!TC.Items || !Array.isArray(TC.Items.drops)) return;
    let m = this.dropMirror.get(snap.id);
    if (!m) {
      if (snap.x === undefined || snap.item === undefined) return;
      const d = {
        did: parseInt(snap.id.slice(1), 10) | 0,
        x: snap.x, y: snap.y,
        vx: 0, vy: 0,
        id: snap.item,
        count: snap.count != null ? snap.count : 1,
        age: 0, phase: 0,
        pickupDelay: 0.35, onGround: false,
        mirror: true
      };
      m = { drop: d, lastSeen: this.tickCount };
      this.dropMirror.set(snap.id, m);
      TC.Items.drops.push(d);
    }
    const d = m.drop;
    if (snap.x !== undefined) d.x = snap.x;
    if (snap.y !== undefined) d.y = snap.y;
    if (snap.count !== undefined) d.count = snap.count;
    m.lastSeen = this.tickCount;
  };

  NetClient.prototype._applyEnemySnap = function (snap) {
    let m = this.enemyMirror.get(snap.id);
    if (!m) {
      const def = (TC.ENEMY_DEFS && TC.ENEMY_DEFS[snap.type]) || null;
      if (!def) return;
      const e = {
        eid: snap.id.slice(1) | 0,
        type: snap.type, def: def,
        x: snap.x !== undefined ? snap.x : 0,
        y: snap.y !== undefined ? snap.y : 0,
        w: def.w, h: def.h,
        vx: snap.vx || 0, vy: snap.vy || 0,
        hp: snap.hp != null ? snap.hp : def.hp,
        maxHp: snap.maxHp != null ? snap.maxHp : def.hp,
        facing: snap.face || 1, mirror: true, flashTimer: 0
      };
      m = { enemy: e, lastSeen: this.tickCount, buf: [] };
      this.enemyMirror.set(snap.id, m);
      if (TC.Enemies && Array.isArray(TC.Enemies.list)) TC.Enemies.list.push(e);
    }
    const e = m.enemy;
    if (snap.hp !== undefined) e.hp = snap.hp;
    if (snap.maxHp !== undefined) e.maxHp = snap.maxHp;
    if (typeof snap.face === 'number') e.facing = snap.face;
    m.lastSeen = this.tickCount;
    if (!this.opts.interp) {
      if (snap.x !== undefined) e.x = snap.x;
      if (snap.y !== undefined) e.y = snap.y;
      if (snap.vx !== undefined) e.vx = snap.vx;
      if (snap.vy !== undefined) e.vy = snap.vy;
      return;
    }
    if (snap.x !== undefined || snap.y !== undefined ||
        snap.vx !== undefined || snap.vy !== undefined) {
      this._bufPush(m.buf, {
        x: snap.x !== undefined ? snap.x : e.x,
        y: snap.y !== undefined ? snap.y : e.y,
        vx: snap.vx || 0, vy: snap.vy || 0,
        t: this.tickCount
      });
    }
  };

  NetClient.prototype._bufPush = function (buf, pose) {
    buf.push(pose);
    if (buf.length > this.opts.interpBufferSize) buf.shift();
  };

  // Presentation interpolation: render every mirrored entity DELAY ticks
  // behind the newest snapshot. Purely visual — never feeds collision,
  // combat, inventory or world mutation (joined clients do not simulate).
  NetClient.prototype._interpolate = function () {
    if (!this.opts.interp) return;
    const delay = Math.max(1, this.opts.interpDelayTicks | 0);
    const targetT = this.tickCount - delay;
    const maxGap = this.opts.teleportDistPx;
    const step = (rec) => {
      const buf = rec.buf;
      const ent = rec.player || rec.enemy;
      if (!ent || !buf.length) return;
      let older = null, newer = null;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].t <= targetT) { older = buf[i]; newer = buf[i + 1] || null; break; }
      }
      if (!older && buf.length) older = buf[0];           // hold on spawn
      let px, py;
      if (newer && older.t <= targetT) {
        const span = newer.t - older.t;
        const k = span > 0 ? Math.min(1, Math.max(0, (targetT - older.t) / span)) : 1;
        px = older.x + (newer.x - older.x) * k;
        py = older.y + (newer.y - older.y) * k;
      } else {
        px = older.x; py = older.y;                        // no extrapolation
      }
      if (Math.abs(ent.x - px) > maxGap || Math.abs(ent.y - py) > maxGap) {
        this.stats.interpTeleports++;                      // snap, don't glide
      }
      ent.x = px; ent.y = py;
      ent.vx = newer ? newer.vx : older.vx;
      ent.vy = newer ? newer.vy : older.vy;
    };
    for (const [, rec] of this.playerBufs) step(rec);
    for (const [, m] of this.enemyMirror) step(m);
  };

  // Local locomotion prediction + bounded reconciliation (SELF only).
  // Reuses the canonical Player.update movement/collision semantics — no
  // second physics engine. Never predicts mining, loot, damage, inventory or
  // world mutation: those are server truth arriving via commands/snapshots.
  NetClient.prototype._predictSelf = function () {
    const p = TC.player;
    if (!p || typeof p.update !== 'function' || !TC.Input) return;
    const seq = ++this.cseqInput;
    void seq;
    const axis = TC.Input.axis ? TC.Input.axis() : { x: 0, jump: false };
    this.inputHist.push({ x: axis.x | 0, jump: axis.jump ? 1 : 0 });
    if (this.inputHist.length > 48) this.inputHist.shift();
    p.update(STEP);
  };

  NetClient.prototype._reconcileSelf = function () {
    const corr = this.selfCorr;
    if (!corr) return;
    this.selfCorr = null;
    const p = TC.player;
    if (!p) return;
    const dx = corr.x - p.x, dy = corr.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > this.opts.predictHardSnapPx * this.opts.predictHardSnapPx) {
      p.x = corr.x; p.y = corr.y;                     // divergent: snap
      if (corr.vx != null) p.vx = corr.vx;
      if (corr.vy != null) p.vy = corr.vy;
      this.inputHist.length = 0;
      this.stats.predHardSnaps++;
      return;
    }
    if (d2 > 0.0001) {
      // soft error: converge smoothly over the next frames
      const b = this.opts.predictBlend;
      p.x += dx * b; p.y += dy * b;
      if (corr.vx != null) p.vx += (corr.vx - p.vx) * b;
      if (corr.vy != null) p.vy += (corr.vy - p.vy) * b;
      this.stats.predSoftCorrections++;
    }
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
    // safety net alongside explicit tombstones
    for (const [key, m] of Array.from(this.dropMirror.entries())) {
      if (this.tickCount - m.lastSeen > this.opts.enemyLingerTicks) {
        this._removeDropMirror(key);
      }
    }
  };

  NetClient.prototype._onSnapshot = function (m) {
    if (!this._ensureMirrorWorld()) return;
    this._ensureOwnPlayer();
    for (let i = 0; i < m.p.regions.length; i++) this._applyRegionLine(m.p.regions[i]);
    const lines = m.p.players.concat(m.p.enemies).concat(m.p.drops || []);
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
    // removals first so a respawning id re-creates cleanly
    this._applyRm(m.p.rm);
    const lines = m.p.players.concat(m.p.enemies).concat(m.p.drops);
    for (let i = 0; i < lines.length; i++) this._applyEntitySnap(lines[i]);
    // authoritative self-inventory refresh: the client UI reads its own
    // slots, so the mirror must track server truth for hotbar/crafting
    if (Array.isArray(m.p.inv)) this._applyInvLines(m.p.inv);
    // W23: authoritative container sync into the LOCAL chest map so the
    // production chest panel reads server truth untouched.
    if (m.p.chest) this._applyChestPayload(m.p.chest);
    this._decayEnemyMirrors();
    this._flushAcks(false);
  };

  NetClient.prototype._applyInvLines = function (lines) {
    if (!TC.player || !TC.player.inventory) return;
    const inv = TC.player.inventory;
    for (let i = 0; i < lines.length && i < inv.slots.length; i++) {
      const line = lines[i];
      const cur = inv.get(i);
      const want = line ? { id: line[0], count: line[1] } : null;
      if ((cur == null) !== (want == null) ||
          (cur && want && (cur.id !== want.id || cur.count !== want.count))) {
        inv.slots[i] = want;
      }
    }
  };

  NetClient.prototype._applyChestPayload = function (cp) {
    if (!cp || !TC.Chests || typeof TC.Chests.get !== 'function') return;
    const slots = TC.Chests.get(cp.tx | 0, cp.ty | 0);
    if (!Array.isArray(slots)) return;
    for (let i = 0; i < slots.length; i++) {
      const line = (i < cp.slots.length) ? cp.slots[i] : null;
      const want = line ? { id: line[0], count: line[1] } : null;
      const cur = slots[i];
      if ((cur == null) !== (want == null) ||
          (cur && want && (cur.id !== want.id || cur.count !== want.count))) {
        slots[i] = want;
      }
    }
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
    }) ? { ok: true, pending: true } : { ok: false, error: 'encode-failed' };
  };

  // W23 intent router for canonical UI transactions while joined: maps a
  // LOCAL transaction shape onto its bounded network form and returns
  // {ok:true,pending:true} when proposed. The server's authoritative result
  // bundle corrects the mirror within one round trip.
  NetClient.prototype.sendIntent = function (name, ctx) {
    const c = ctx || {};
    switch (name) {
      case 'CraftRecipe': {
        let rid = null;
        const idx = (TC.RECIPES && c.recipe) ? TC.RECIPES.indexOf(c.recipe) : -1;
        if (idx >= 0 && TC.Registry && typeof TC.Registry.legacyToStable === 'function') {
          try { rid = TC.Registry.legacyToStable('recipe', idx); } catch (e) { rid = null; }
        }
        if (!rid) return { ok: false, error: 'no-recipe-id' };
        return this.sendCmd('CraftRecipe', { recipeId: String(rid).slice(0, 64) });
      }
      case 'ShopBuy':
        return this.sendCmd('ShopBuy', {
          npcType: String(c.npcType || '').slice(0, 32),
          itemId: String(c.itemId || '').slice(0, 64)
        });
      case 'ShopSell':
        return this.sendCmd('ShopSell', {
          npcType: String(c.npcType || '').slice(0, 32),
          slot: c.slot | 0,
          count: (c.count == null) ? undefined : (c.count | 0)
        });
      case 'ContainerMove':
        return this.sendCmd('ContainerMove', {
          tx: c.tx | 0, ty: c.ty | 0,
          from: c.from === 'inv' ? 1 : 0,
          to: c.to === 'inv' ? 1 : 0,
          fromSlot: c.fromSlot | 0,
          toSlot: (c.toSlot == null) ? undefined : (c.toSlot | 0),
          count: (c.count == null) ? undefined : (c.count | 0)
        });
      default:
        return this.sendCmd(name, c);
    }
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
      this.sendCmd('MineTile', { tx: tx, ty: ty });
    } else if (d.tile != null) {
      this.sendCmd('PlaceTile', { tx: tx, ty: ty, item: sel.id, slot: p.hotbarIndex });
    } else {
      this.sendCmd('UseItem', { slot: p.hotbarIndex, aimX: inp.mouse.worldX, aimY: inp.mouse.worldY });
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

    // W23 latency masking: predict SELF locally, then reconcile against the
    // latest authoritative state that arrived during pump().
    if (this.opts.predict) {
      this._predictSelf();
      this._reconcileSelf();
    }

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

    // remote mirrors render DELAY ticks behind newest snapshots (WS4)
    this._interpolate();

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
    // W23 intent router: canonical UI transactions propose over the network
    // while joined; returns null when no session is active (caller falls
    // back to the local transaction path).
    intent: function (name, ctx) {
      const c = activeInstance;
      return (c && c.isActive()) ? c.sendIntent(name, ctx) : null;
    },
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

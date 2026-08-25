/* netserver.js — TC.NetServer: THE authoritative multiplayer session runner
   (W22 / NET-002 + NET-003 + first NET-004 prototype).

   AUTHORITY MODEL (docs/ARCHITECTURE.md §26):
     The server owns world truth — world state, tick, players, enemies,
     projectiles, mining/placement results, inventory, loot. Clients propose
     INTENTS ONLY (continuous input samples + whitelisted command intents);
     every mutation flows through the canonical TC.Commands transactions and
     the canonical fixed-step scheduler (TC.Runtime.tick → Systems.updateAll).
     No client-declared position/damage/inventory is ever trusted.

   LIFECYCLE:
     start({seed})      create the authoritative world (headless-safe)
     attachLocal()      register the hosting player (TC.player stays primary)
     connect(ep,{name}) admit a transport endpoint; hello/welcome handshake
     tick()             ONE authoritative step: inbound → simulate → replicate
     stop([reason])     orderly teardown (bye, consumers dropped, no leaks)

   REPLICATION (NET-004 prototype on the W21 substrate):
     Every connection owns a PRIVATE TC.WorldRegions consumer ('net:<cid>') —
     renderer/lighting/minimap cursors are never touched. Interest = regions
     intersecting a square around that player's position. Join/resync sends
     full region layers; steady state sends last-ack-baselined cell deltas
     under a per-tick budget. Acks are accounting (reliable transports) and
     desync detectors; revision mismatches schedule fresh snapshots.

   SEQUENCE RULES:
     - client->server cseq strictly increasing per stream (input/cmd separate);
       duplicates/stale frames are counted and rejected;
     - server->client sseq strictly increasing; pid must match the bound
       identity on every message (spoofed ids are rejected);
     - reconnect rebinds with a cseq floor so stale old-generation packets
       cannot apply.

   Headless-safe: no DOM/Canvas references; drives TC.Runtime directly. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const STEP = 1 / 60;
  const P = TC.NetProto;

  // ---- defaults ----
  const DEF = {
    seed: 1337,
    interestRadius: 56,          // tiles around each player (region-aligned)
    budgetRegionsPerTick: 4,     // replication budget: changed regions/tick/conn
    snapshotRegionsPerMsg: 12,   // bounded initial-sync payload size
    maxInboundPerTick: 96,       // hostile-flood cap across all connections
    maxPendingCmds: 16,          // queued intents per connection
    entitySnapCap: 48,           // enemies replicated per update
    dropSnapCap: 64,
    inputStallTicks: 30,         // zero inputs after this much silence
    detachGraceTicks: 18000      // abandoned identities expire after ~5 min
  };

  let sessionCounter = 0;

  function makeSid() {
    sessionCounter++;
    return 's' + Date.now().toString(36) + '-' + sessionCounter.toString(36);
  }
  function makeCid() {
    sessionCounter++;
    return 'c' + sessionCounter.toString(36) + Math.floor((Date.now() % 1e6)).toString(36);
  }

  function NetServer(opts) {
    opts = opts || {};
    this.opts = Object.assign({}, DEF, opts);
    this.sid = makeSid();
    this.conns = new Map();        // cid -> conn
    this.detached = new Map();     // pid -> conn awaiting reconnect/resync
    this.running = false;
    this.worldOwned = false;       // true when we created TC.world ourselves
    this.localPid = null;
    this._systems = [];            // registered system names (for teardown)
    this.stats = {
      startedAt: 0,
      ticksSimulated: 0,
      msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0,
      byTypeIn: {}, byTypeOut: {},
      rejected: { version: 0, type: 0, payload: 0, staleSeq: 0, spoofedPid: 0, unknownCmd: 0, oversize: 0, beforeHello: 0 },
      cmdsAccepted: 0, cmdsRejected: 0,
      regionsSentFull: 0, regionsSentDelta: 0, regionsAcked: 0,
      snapshotsSent: 0, resyncsServed: 0, joinsAccepted: 0,
      disconnects: 0, reconnects: 0
    };
  }

  NetServer.prototype._countIn = function (t, bytes) {
    const s = this.stats;
    s.msgsIn++; s.bytesIn += bytes || 0;
    s.byTypeIn[t] = (s.byTypeIn[t] || 0) + 1;
  };
  NetServer.prototype._reject = function (conn, kind, why, refCseq) {
    this.stats.rejected[kind] = (this.stats.rejected[kind] || 0) + 1;
    if (conn && refCseq != null) {
      this._send(conn, 'cmdres', { ref: refCseq | 0, ok: false, error: String(why).slice(0, 128) });
    } else if (conn) {
      this._send(conn, 'reject', { reason: String(why).slice(0, MAX_STR_R) });
    }
  };
  const MAX_STR_R = 64;

  // ---- outbound ----
  NetServer.prototype._nextSseq = 1;
  NetServer.prototype._send = function (conn, type, payload) {
    if (!conn || !conn.ep || !conn.ep.open) return false;
    const msg = {
      v: P.VERSION, t: type,
      sid: this.sid, pid: conn.pid || null,
      cseq: 0, sseq: this._nextSseq++, tick: this._tick(),
      p: payload || {}
    };
    const raw = P.encode(msg);
    if (raw == null) return false;
    conn.ep.send(raw);
    const s = this.stats;
    s.msgsOut++; s.bytesOut += raw.length;
    s.byTypeOut[type] = (s.byTypeOut[type] || 0) + 1;
    return true;
  };

  NetServer.prototype._tick = function () {
    return (TC.Runtime && TC.Runtime.getTickCount) ? TC.Runtime.getTickCount() : 0;
  };

  // ---- lifecycle ----
  NetServer.prototype.start = function () {
    if (this.running) return { ok: false, error: 'already-running' };
    if (!TC.Runtime || !TC.Runtime.createWorld) return { ok: false, error: 'no-runtime' };

    this._registerSystems();
    const adopt = this.opts.adoptWorld && TC.world && TC.state === 'playing';
    if (!adopt) {
      const r = TC.Runtime.createWorld(this.opts.seed);
      if (!r || !TC.world) return { ok: false, error: 'world-create-failed' };
      this.worldOwned = true;
    }
    this.running = true;
    this.stats.startedAt = Date.now();
    return { ok: true, sid: this.sid, seed: TC.worldSeed, adopted: !!adopt };
  };

  NetServer.prototype.attachLocal = function (name) {
    if (!TC.world || !TC.player) return { ok: false, error: 'no-world' };
    if (this.localPid) return { ok: true, pid: this.localPid };
    const rec = TC.Players.create(TC.player, { id: 'p1', primary: true, name: name || 'Host' });
    if (!rec) return { ok: false, error: 'registry-full' };
    this.localPid = rec.id;
    return { ok: true, pid: rec.id };
  };

  NetServer.prototype.stop = function (reason) {
    if (!this.running && this.conns.size === 0) return;
    for (const conn of Array.from(this.conns.values())) {
      this._dropConn(conn, reason || 'server-stopped', true);
    }
    for (const name of this._systems) {
      if (TC.Systems && typeof TC.Systems.unregister === 'function') {
        try { TC.Systems.unregister(name); } catch (e) {}
      }
    }
    this._systems.length = 0;
    // Remote players die with the session; the local primary survives.
    const keep = [];
    if (this.localPid) keep.push(this.localPid);
    TC.Players.retainOnly(keep);
    this.conns.clear();
    this.running = false;
  };

  NetServer.prototype._dropConn = function (conn, why, sendBye) {
    if (sendBye) this._send(conn, 'bye', { reason: String(why).slice(0, 64) });
    try { if (conn.ep) conn.ep.close(why); } catch (e) {}
    conn.connected = false;
    conn.ep = null;
    this.stats.disconnects++;
    this.conns.delete(conn.cid);
    if (!conn.pid) return;
    if (why === 'client-bye' || why === 'server-stopped') {
      // Explicit departure / teardown: identity dies with the session.
      TC.Players.remove(conn.pid);
      if (conn.consumerName && TC.WorldRegions && TC.WorldRegions.forget) {
        try { TC.WorldRegions.forget(conn.consumerName); } catch (e) {}
      }
      this.detached.delete(conn.pid);
      conn.pid = null;
      conn.player = null;
    } else {
      // Transport death: park the identity for reconnect/resync. Safe input
      // defaults hold while absent; the player entity and replication state
      // (private consumer, lastSent baselines) survive untouched.
      conn.input.x = 0; conn.input.jump = 0; conn.input.down = 0; conn.input.use = 0;
      this.detached.set(conn.pid, conn);
    }
  };

  // ---- systems (registered into the canonical scheduler) ----
  // 'input' phase: remote held-use intent + hotbar selection ride the same
  // seam as the local 'player-intent' system. 'commands' phase: validated
  // network intents execute through TC.Commands.submit right AFTER core.queue
  // drains (registration order breaks ties; boot registered core.queue).
  NetServer.prototype._registerSystems = function () {
    if (!TC.Systems || typeof TC.Systems.register !== 'function') return;
    const self = this;
    if (this._systems.indexOf('net-remote-intents') < 0) {
      TC.Systems.register('input', 'net-remote-intents', {
        update: function () { self._remoteIntents(); }
      }, { when: function () { return self.running; } });
      this._systems.push('net-remote-intents');
    }
    if (this._systems.indexOf('net-commands') < 0) {
      TC.Systems.register('commands', 'net-commands', {
        update: function () { self._commandsPhase(); }
      }, { when: function () { return self.running; } });
      this._systems.push('net-commands');
    }
  };

  // Continuous remote input -> canonical UseItem queue during the input phase.
  NetServer.prototype._remoteIntents = function () {
    for (const conn of this.conns.values()) {
      if (!conn.connected || !conn.player || conn.player.dead) continue;
      const inp = conn.input;
      if (inp.slot >= 0 && conn.player.hotbarIndex !== inp.slot) {
        conn.player.hotbarIndex = inp.slot;
      }
      if (inp.use) {
        conn.player.enqueueUseIntent({
          worldX: inp.aimX, worldY: inp.aimY
        }, STEP);
      }
    }
  };

  // ---- connections ----
  NetServer.prototype.connect = function (ep, opts) {
    opts = opts || {};
    if (!this.running) return { ok: false, error: 'not-running' };
    const conn = {
      cid: makeCid(),
      ep: ep,
      name: (typeof opts.name === 'string' && opts.name) ? opts.name.slice(0, 24) : 'Client',
      connected: false,
      pid: null, player: null, inputSource: null,
      gen: 1,
      inbox: [],
      lastInputSeq: 0, lastCmdSeq: 0,
      input: { x: 0, jump: 0, down: 0, use: 0, aimX: 0, aimY: 0, slot: -1 },
      lastInputTick: 0,
      pendingCmds: [],
      consumerName: null, consumer: null,
      interest: new Set(),
      snapQueue: [],
      lastSent: new Map(),   // idx -> {rev, tiles(Uint8Array), walls(Uint8Array)}
      acked: new Map(),      // idx -> rev
      joinedTick: 0
    };
    this.conns.set(conn.cid, conn);
    this._attachEndpoint(conn, ep);
    return { ok: true, cid: conn.cid };
  };

  // Bind one endpoint to a connection record. Re-binding a reborn connection
  // onto a fresh endpoint overwrites the previous handlers (endpoints carry
  // exactly one message/status slot each).
  NetServer.prototype._attachEndpoint = function (conn, ep) {
    const self = this;
    ep.onMessage(function (raw) {
      if (typeof raw === 'string') {
        self._countIn('_wire', raw.length);
        if (conn.inbox.length < 512) conn.inbox.push(raw);
      }
    });
    ep.onStatus(function (st) {
      if (st === 'closed' || st === 'error') {
        if (self.conns.has(conn.cid)) self._dropConn(conn, 'transport-closed', false);
      }
    });
  };

  // ---- inbound processing (bounded per tick) ----
  NetServer.prototype.processInbound = function () {
    let budget = this.opts.maxInboundPerTick;
    for (const conn of Array.from(this.conns.values())) {
      while (conn.inbox.length && budget-- > 0) {
        const raw = conn.inbox.shift();
        this._handleRaw(conn, raw);
      }
      if (budget <= 0) break;
    }
    return this.opts.maxInboundPerTick - Math.max(0, budget);
  };

  NetServer.prototype._handleRaw = function (conn, raw) {
    const v = P.decode(raw);
    this._countIn(typeof v.msg === 'object' && v.msg ? v.msg.t : 'malformed', raw.length);
    if (!v.ok) {
      const e = String(v.error || '');
      const kind =
        e.indexOf('version') === 0 ? 'version' :
        e.indexOf('type') === 0 ? 'type' :
        e.indexOf('decode') === 0 ? 'payload' : 'payload';
      this._reject(conn, kind, e);
      return;
    }
    const m = v.msg;

    // Identity gate: nothing but hello may arrive before a bound pid.
    if (!conn.pid && m.t !== 'hello') {
      this._reject(conn, 'beforeHello', 'handshake-required');
      return;
    }
    // Spoof gate: a bound connection may only speak as its own pid.
    if (conn.pid && m.pid !== null && m.pid !== undefined && m.pid !== conn.pid) {
      this._reject(conn, 'spoofedPid', 'pid-mismatch');
      return;
    }

    switch (m.t) {
      case 'hello': this._onHello(conn, m); break;
      case 'input': this._onInput(conn, m); break;
      case 'cmd': this._onCmd(conn, m); break;
      case 'ack': this._onAck(conn, m); break;
      case 'resync': this._beginSnapshot(conn, 'resync-request'); this.stats.resyncsServed++; break;
      case 'bye': this._dropConn(conn, 'client-bye', false); break;
      default:
        // welcome/snapshot/worldupd/cmdres/reject are SERVER->CLIENT only.
        this._reject(conn, 'type', 'wrong-direction');
    }
  };

  NetServer.prototype._onHello = function (conn, m) {
    if (conn.pid) { this._reject(conn, 'payload', 'already-helloed'); return; }
    const p = m.p || {};
    const rj = p.rejoin;
    if (rj) {
      // Reconnect: validate session + identity, rebind generation, resync.
      if (rj.sid !== this.sid) { this._reject(conn, 'payload', 'unknown-session'); return; }
      let existing = this.detached.get(rj.pid) || null;
      if (!existing) {
        for (const c of this.conns.values()) {
          if (c.pid === rj.pid) { existing = c; break; }
        }
      }
      if (!existing) { this._reject(conn, 'payload', 'unknown-player'); return; }
      if (existing.connected) {
        this._reject(conn, 'payload', 'session-active'); return;
      }
      // Rebind: adopt the surviving player entity + replication state; raise
      // the stale-packet floor so late frames from the dead generation
      // (replayed transports, duplicated frames) cannot apply.
      existing.connected = true;
      existing.gen++;
      existing.staleFloor = existing.lastCmdSeq;
      existing.lastInputSeq = Math.max(existing.lastInputSeq + 1, rj.tick | 0);
      existing.snapQueue = [];
      existing.joinedTick = this._tick();
      existing.inbox = conn.inbox;          // adopt already-buffered frames
      existing.ep = conn.ep;
      this._attachEndpoint(existing, conn.ep);
      this.detached.delete(rj.pid);
      this.conns.set(existing.cid, existing);
      this.conns.delete(conn.cid);          // drop the shell record
      this.stats.reconnects++;
      this._ensureConsumer(existing);
      this._sendWelcome(existing, 'rejoin');
      this._beginSnapshot(existing, 'resync');
      return;
    }
    // Fresh join.
    if (!TC.world) { this._reject(conn, 'payload', 'no-world'); return; }
    const spawn = this._spawnPoint();
    const player = new TC.Player(spawn.x, spawn.y);
    if (player.giveStarterKit) player.giveStarterKit();
    const rec = TC.Players.create(player, { remote: true, clientId: conn.cid, name: p.name || conn.name });
    if (!rec) { this._reject(conn, 'payload', 'server-full'); return; }
    conn.pid = rec.id;
    conn.player = player;
    conn.connected = true;
    conn.joinedTick = this._tick();
    conn.inputSource = this._makeInputSource(conn);
    player.inputSource = conn.inputSource;
    this._ensureConsumer(conn);
    this.stats.joinsAccepted++;
    this._sendWelcome(conn, 'join');
    this._beginSnapshot(conn, 'join');
  };

  NetServer.prototype._sendWelcome = function (conn, mode) {
    this._send(conn, 'welcome', {
      tick: this._tick(),
      seed: (typeof TC.worldSeed === 'number') ? TC.worldSeed : 0,
      you: { pid: conn.pid },
      players: [],
      mode: mode
    });
  };

  NetServer.prototype._spawnPoint = function () {
    const TS = TC.CONST.TS;
    const w = TC.world;
    // Spawn near the authoritative anchor player (the host's entity, or the
    // dedicated server's dormant pawn at world spawn), spread sideways so
    // simultaneous joins do not stack inside each other.
    let tx = (TC.player && isFinite(TC.player.x))
      ? Math.floor((TC.player.x + TC.player.w / 2) / TS)
      : Math.floor(w.width / 2);
    const n = TC.Players.count();
    if (n > 1) tx = Math.max(2, Math.min(w.width - 3, tx + (n - 1) * 2));
    const ty = (w.surfaceY && w.surfaceY[tx] != null)
      ? w.surfaceY[tx]
      : Math.floor(w.height / 2);
    return {
      x: tx * TS + TS / 2 - TC.CONST.PLAYER_W / 2,
      y: ty * TS - TC.CONST.PLAYER_H
    };
  };

  NetServer.prototype._makeInputSource = function (conn) {
    const server = this;
    return {
      _conn: conn,
      axis: function () {
        const i = server._liveInput(conn);
        return { x: i.x, jump: !!i.jump };
      },
      down: function (code) {
        const i = server._liveInput(conn);
        if (code === 'KeyS' || code === 'ArrowDown') return !!i.down;
        return false;
      },
      pressed: function () { return false; } // edges are server-side only
    };
  };

  NetServer.prototype._liveInput = function (conn) {
    // Safe default after silence: a disconnected/stalled client stops moving.
    if (this._tick() - conn.lastInputTick > this.opts.inputStallTicks) {
      return { x: 0, jump: 0, down: 0 };
    }
    return conn.input;
  };

  NetServer.prototype._onInput = function (conn, m) {
    const p = m.p;
    const seq = m.cseq;
    if (seq <= conn.lastInputSeq) {
      this.stats.rejected.staleSeq++;
      return;                       // duplicate or out-of-order sample: ignore
    }
    conn.lastInputSeq = seq;
    const live = (this._tick() - conn.lastInputTick <= this.opts.inputStallTicks + 1);
    conn.input.x = p.btn[0];
    conn.input.jump = p.btn[1];
    conn.input.down = p.btn[2];
    conn.input.use = p.use || 0;
    conn.input.aimX = p.aimX;
    conn.input.aimY = p.aimY;
    if (p.slot !== undefined) conn.input.slot = p.slot;
    conn.lastInputTick = this._tick();
    void live;
  };

  NetServer.prototype._onCmd = function (conn, m) {
    const seq = m.cseq;
    if (seq <= (conn.staleFloor || 0) || seq <= conn.lastCmdSeq) {
      this.stats.rejected.staleSeq++;
      this._send(conn, 'cmdres', { ref: seq, ok: false, error: 'stale-sequence' });
      return;
    }
    if (conn.pendingCmds.length >= this.opts.maxPendingCmds) {
      this._send(conn, 'cmdres', { ref: seq, ok: false, error: 'flood' });
      return;
    }
    conn.lastCmdSeq = seq;
    conn.pendingCmds.push({ seq: seq, name: m.p.name, ctx: m.p.ctx });
  };

  // Executed in the canonical commands phase AFTER core.queue drains:
  // validated network intents go through TC.Commands.submit exactly like
  // local ones. Registration order places this after boot-time registrations.
  NetServer.prototype.processCommands = function () {
    for (const conn of this.conns.values()) {
      let n = 0;
      while (conn.pendingCmds.length && n++ < 8) {
        const job = conn.pendingCmds.shift();
        const res = this._execCommand(conn, job);
        this._send(conn, 'cmdres', {
          ref: job.seq, ok: !!res.ok,
          error: res.ok ? undefined : String(res.error || 'rejected').slice(0, 128)
        });
      }
    }
  };

  NetServer.prototype._execCommand = function (conn, job) {
    if (!TC.Commands || typeof TC.Commands.submit !== 'function') {
      return { ok: false, error: 'no-commands' };
    }
    const ctxP = job.ctx || {};
    const player = conn.player;
    const c = { player: player };
    const S = TC.Stats ? TC.Stats.resolve(player) : null;

    switch (job.name) {
      case 'MineTile':
      case 'MineWall': {
        c.tx = ctxP.tx | 0; c.ty = ctxP.ty | 0;
        const held = this._heldToolOf(player);
        c.tool = held.tool;
        c.toolPower = held.power * ((S && S.miningSpeed) || 1);
        // Server-owned cadence: the client cannot declare an oversized dt to
        // mine faster than the canonical fixed-step allows.
        c.dt = STEP;
        break;
      }
      case 'PlaceTile':
      case 'PlaceWall': {
        c.tx = ctxP.tx | 0; c.ty = ctxP.ty | 0;
        c.item = String(ctxP.item || '').slice(0, 64);
        if (ctxP.slot !== undefined) c.slot = ctxP.slot | 0;
        break;
      }
      case 'MoveItem': {
        // Both ends resolve to the ACTING player's inventory: the protocol
        // can never select another player's inventory.
        c.fromInv = player.inventory;
        c.toInv = player.inventory;
        c.fromSlot = ctxP.fromSlot | 0;
        c.toSlot = ctxP.toSlot | 0;
        if (ctxP.count !== undefined) c.count = ctxP.count | 0;
        break;
      }
      case 'EquipItem': {
        c.item = String(ctxP.item || '').slice(0, 64);
        if (ctxP.slot !== undefined) c.slot = ctxP.slot | 0;
        break;
      }
      case 'InteractTile': {
        c.tx = ctxP.tx | 0; c.ty = ctxP.ty | 0;
        break;
      }
      case 'UseItem': {
        c.slot = (ctxP.slot !== undefined) ? ctxP.slot | 0 : player.hotbarIndex;
        c.aimX = +ctxP.aimX || 0;
        c.aimY = +ctxP.aimY || 0;
        c.dt = STEP;
        break;
      }
      default:
        this.stats.rejected.unknownCmd++;
        return { ok: false, error: 'unknown-command' };
    }

    const r = TC.Commands.submit(job.name, c);
    if (r && r.ok) this.stats.cmdsAccepted++;
    else this.stats.cmdsRejected++;
    return r || { ok: false, error: 'no-result' };
  };

  NetServer.prototype._heldToolOf = function (player) {
    const sel = player.selectedSlot ? player.selectedSlot() : null;
    const d = sel ? (TC.ITEM_DEFS && TC.ITEM_DEFS[sel.id]) : null;
    // Tool defs carry kind:'tool' + a `tool` variant ('pick'|'axe'); power
    // and target hardness are validated server-side by the transaction.
    if (d && (d.tool === 'pick' || d.tool === 'axe')) {
      return { tool: d.tool, power: d.power || 1 };
    }
    return { tool: null, power: 0 };
  };

  NetServer.prototype._onAck = function (conn, m) {
    const regs = m.p.regions;
    if (!regs) return;
    for (let i = 0; i < regs.length; i++) {
      const idx = regs[i][0], rev = regs[i][1];
      conn.acked.set(idx, rev);
      this.stats.regionsAcked++;
      const cur = TC.WorldRegions && TC.WorldRegions.revision ? TC.WorldRegions.revision(idx) : rev;
      if (rev > cur) {
        // Client claims a future we never sent: force a fresh snapshot.
        this._queueSnapshots(conn, [idx]);
      }
    }
  };

  // ---- replication (NET-004 prototype) ----

  NetServer.prototype._ensureConsumer = function (conn) {
    if (conn.consumer || !TC.WorldRegions || !TC.WorldRegions.consume) return;
    conn.consumerName = 'net:' + conn.cid;
    conn.consumer = TC.WorldRegions.consume(conn.consumerName);
  };

  NetServer.prototype._interestOf = function (px, py) {
    const w = TC.world;
    const R = TC.WorldRegions;
    if (!w || !R || !R.CHUNK) return [];
    const TS = TC.CONST.TS;
    const x0 = px - this.opts.interestRadius * TS, x1 = px + this.opts.interestRadius * TS;
    const y0 = py - this.opts.interestRadius * TS, y1 = py + this.opts.interestRadius * TS;
    const tx0 = Math.max(0, (x0 / TS) | 0), ty0 = Math.max(0, (y0 / TS) | 0);
    const tx1 = Math.min(w.width - 1, (x1 / TS) | 0), ty1 = Math.min(w.height - 1, (y1 / TS) | 0);
    const out = [];
    const cx0 = (tx0 / R.CHUNK) | 0, cy0 = (ty0 / R.CHUNK) | 0;
    const cx1 = (tx1 / R.CHUNK) | 0, cy1 = (ty1 / R.CHUNK) | 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx < R.chunksX && cy < R.chunksY) out.push(cy * R.chunksX + cx);
      }
    }
    return out;
  };

  NetServer.prototype._regionLayers = function (idx) {
    const R = TC.WorldRegions;
    const w = TC.world;
    const coords = R.chunkCoords(idx);
    const TSZ = R.CHUNK;
    const tiles = new Uint8Array(TSZ * TSZ);
    const walls = new Uint8Array(TSZ * TSZ);
    const baseX = coords.cx * TSZ, baseY = coords.cy * TSZ;
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
    return { tiles: tiles, walls: walls };
  };

  NetServer.prototype._queueSnapshots = function (conn, idxs) {
    for (let i = 0; i < idxs.length; i++) {
      if (conn.snapQueue.indexOf(idxs[i]) < 0) conn.snapQueue.push(idxs[i]);
    }
  };

  NetServer.prototype._beginSnapshot = function (conn, reason) {
    conn.snapQueue = [];
    this._ensureConsumer(conn);
    if (conn.player) {
      this._queueSnapshots(conn, this._interestOf(
        conn.player.x + conn.player.w / 2, conn.player.y + conn.player.h / 2));
    }
    void reason;
  };

  NetServer.prototype._snapshotStep = function (conn) {
    if (!conn.snapQueue.length) return false;
    const take = Math.min(this.opts.snapshotRegionsPerMsg, conn.snapQueue.length);
    const regions = [];
    for (let i = 0; i < take; i++) {
      const idx = conn.snapQueue.shift();
      const rev = TC.WorldRegions.revision(idx);
      const layers = this._regionLayers(idx);
      regions.push(P.buildFullRegion(idx, rev, layers.tiles, layers.walls));
      conn.lastSent.set(idx, { rev: rev, tiles: layers.tiles, walls: layers.walls });
      this.stats.regionsSentFull++;
      if (conn.consumer) conn.consumer.observe(idx);
    }
    const more = conn.snapQueue.length > 0 ? 1 : 0;
    this._send(conn, 'snapshot', {
      reason: more ? 'streaming' : 'complete',
      seed: (typeof TC.worldSeed === 'number') ? TC.worldSeed : 0,
      you: { pid: conn.pid },
      regions: regions,
      players: more ? [] : this._playerSnaps(conn),
      enemies: more ? [] : this._enemySnaps(conn),
      drops: more ? [] : this._dropSnaps(conn)
    });
    this.stats.snapshotsSent++;
    return true;
  };

  NetServer.prototype._inInterest = function (conn, x, y) {
    if (!conn.player) return false;
    const dx = x - (conn.player.x + conn.player.w / 2);
    const dy = y - (conn.player.y + conn.player.h / 2);
    const r = this.opts.interestRadius * TC.CONST.TS;
    return dx * dx + dy * dy <= r * r;
  };

  NetServer.prototype._playerSnaps = function () {
    const snaps = [];
    for (const rec of TC.Players.entries()) {
      const pl = rec.player;
      if (!pl) continue;
      snaps.push({
        id: rec.id, name: rec.name,
        x: pl.x, y: pl.y, vx: pl.vx, vy: pl.vy,
        hp: Math.max(0, pl.hp | 0), maxHp: pl.maxHp | 0,
        face: pl.facing >= 0 ? 1 : -1
      });
    }
    return snaps;
  };

  NetServer.prototype._enemySnaps = function (conn) {
    const list = (TC.Enemies && TC.Enemies.list) || [];
    const snaps = [];
    for (let i = 0; i < list.length && snaps.length < this.opts.entitySnapCap; i++) {
      const e = list[i];
      if (!e || (conn && !this._inInterest(conn, e.x, e.y))) continue;
      snaps.push({
        id: 'e' + e.eid, type: String(e.type),
        x: e.x, y: e.y, vx: e.vx, vy: e.vy,
        hp: Math.max(0, e.hp | 0), maxHp: e.maxHp | 0,
        face: e.facing >= 0 ? 1 : -1
      });
    }
    return snaps;
  };

  NetServer.prototype._dropSnaps = function (conn) {
    const drops = (TC.Items && TC.Items.drops) || [];
    const snaps = [];
    for (let i = 0; i < drops.length && snaps.length < this.opts.dropSnapCap; i++) {
      const d = drops[i];
      if (!d || (conn && !this._inInterest(conn, d.x, d.y))) continue;
      snaps.push({
        id: String(d.id), x: d.x, y: d.y,
        vx: 0, vy: 0, hp: 1, maxHp: 1, count: d.count | 0
      });
    }
    return snaps;
  };

  NetServer.prototype._invOf = function (player) {
    const inv = player && player.inventory;
    if (!inv || !Array.isArray(inv.slots)) return [];
    const out = [];
    for (let i = 0; i < inv.slots.length && i < 50; i++) {
      const s = inv.get(i);
      out.push(s ? [String(s.id).slice(0, 64), s.count | 0] : null);
    }
    return out;
  };

  NetServer.prototype.replicate = function () {
    if (!this.running || !TC.world) return;
    // Expire abandoned identities past their reconnect grace so long-lived
    // servers cannot accumulate ghosts (players + private consumers freed).
    if (this.detached.size && this._tick() % 150 === 0) {
      for (const [pid, conn] of Array.from(this.detached.entries())) {
        if (this._tick() - conn.joinedTick > this.opts.detachGraceTicks) {
          TC.Players.remove(pid);
          if (conn.consumerName && TC.WorldRegions && TC.WorldRegions.forget) {
            try { TC.WorldRegions.forget(conn.consumerName); } catch (e) {}
          }
          this.detached.delete(pid);
        }
      }
    }
    for (const conn of Array.from(this.conns.values())) {
      if (!conn.connected || !conn.player) continue;
      // 1. finish any pending initial/resync snapshot stream first
      if (this._snapshotStep(conn)) continue;
      // 2. refresh the interest set around the player's current position
      const interest = new Set(this._interestOf(
        conn.player.x + conn.player.w / 2, conn.player.y + conn.player.h / 2));
      conn.interest = interest;
      // 3. encode up to budget changed interested regions as baselined deltas
      if (!conn.consumer) continue;
      const dirty = conn.consumer.dirtyRegions();
      const regions = [];
      for (let i = 0; i < dirty.length && regions.length < this.opts.budgetRegionsPerTick; i++) {
        const idx = dirty[i];
        if (!interest.has(idx)) continue;         // stay queued for later
        const rev = TC.WorldRegions.revision(idx);
        const prev = conn.lastSent.get(idx);
        const layers = this._regionLayers(idx);
        let line;
        if (!prev) {
          line = P.buildFullRegion(idx, rev, layers.tiles, layers.walls);
        } else {
          line = {
            idx: idx, rev: rev,
            cells: P.diffRegion(prev.tiles, prev.walls, layers.tiles, layers.walls)
          };
        }
        conn.lastSent.set(idx, { rev: rev, tiles: layers.tiles, walls: layers.walls });
        conn.consumer.observe(idx);
        regions.push(line);
        this.stats.regionsSentDelta++;
      }
      this._send(conn, 'worldupd', {
        regions: regions,
        players: this._playerSnaps(),
        enemies: this._enemySnaps(conn),
        drops: this._dropSnaps(conn),
        // periodic authoritative inventory refresh keeps the client's own
        // UI (hotbar/crafting) truthful without trusting client claims
        inv: (this._tick() % 30 === 0) ? this._invOf(conn.player) : undefined
      });
    }
  };

  // ---- main entry: one authoritative step ----
  NetServer.prototype.tick = function () {
    if (!this.running) return;
    this.processInbound();
    // Canonical simulation step. Network command intents execute inside the
    // scheduler's commands phase via the registered 'net-commands' system
    // (registration order places it after core.queue's drain), so they share
    // the exact validation and ordering path as local queued intents.
    TC.Runtime.tick(STEP);
    this.stats.ticksSimulated++;
    this.replicate();
  };

  // commands-phase hook: runs after core.queue drain within Runtime.tick.
  NetServer.prototype._commandsPhase = function () {
    this.processCommands();
  };

  // Standalone driver (Node host): wall-clock fixed stepping without rAF.
  NetServer.prototype.runForever = function () {
    if (this._driver) return;
    let acc = 0, last = Date.now();
    const self = this;
    this._driver = setInterval(function () {
      const now = Date.now();
      acc += Math.min(0.25, (now - last) / 1000);
      last = now;
      while (acc >= STEP) {
        self.tick();
        acc -= STEP;
      }
    }, 1000 / 60);
  };
  NetServer.prototype.haltDriver = function () {
    if (this._driver) { clearInterval(this._driver); this._driver = null; }
  };

  NetServer.prototype.summary = function () {
    return {
      sid: this.sid,
      running: this.running,
      tick: this._tick(),
      players: TC.Players.count(),
      conns: this.conns.size,
      stats: this.stats
    };
  };

  // Factory + singleton accessor for browser-host usage.
  TC.NetServer = {
    create: function (opts) { return new NetServer(opts); },
    VERSION: P.VERSION
  };
})();

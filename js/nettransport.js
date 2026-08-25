/* nettransport.js — TC.NetTransport: the byte-mover boundary (W22 / NET-002).

   Transport moves opaque strings between two endpoints. It knows NOTHING
   about game truth (simulation's job) or validity (protocol's job).

   Endpoint contract (both implementations):
     .send(str)            queue/frame one message
     .onMessage(fn)        fn(str) per delivered inbound message
     .onStatus(fn)         fn('open'|'closed'|'error', detail)
     .close([reason])      orderly teardown; further sends are no-ops
     .label                human-readable name for diagnostics

   loopbackPair(opts):
     Deterministic in-process duplex pair. Frames move ONLY when a side is
     pumped, so protocol/session tests fully control ordering, and hostile
     scenarios (drop / duplicate / reorder / stale generation) are injected
     without any network. opts.auto pumps synchronously inside send()
     (used by live host/join UI where no test harness drives pumps).

   websocket(url):
     Real local-network client transport over the platform WebSocket
     (browser native or Node >= 22 global). Reliable-ordered semantics;
     outbound frames sent while connecting are buffered up to a small cap. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  function endpointBase(label) {
    return {
      label: label,
      _msg: null, _status: null,
      onMessage: function (fn) { this._msg = fn; },
      onStatus: function (fn) { this._status = fn; },
      _deliver: function (s) { if (this._msg) try { this._msg(s); } catch (e) {} },
      _emitStatus: function (st, d) { if (this._status) try { this._status(st, d); } catch (e) {} }
    };
  }

  // ---- loopback ----
  function makeLoopbackSide(label, wire) {
    const ep = endpointBase('loopback:' + label);
    ep.open = false;
    ep.pending = wire;          // frames awaiting THIS side's pump (inbound)
    ep._outbox = [];            // frames this side sent, awaiting peer pump
    ep._dropNext = false;
    ep._dupNext = false;
    ep._swapNext = false;
    ep._swapArm = -1;

    ep.send = function (s) {
      if (!ep.open || typeof s !== 'string') return false;
      const frame = String(s);
      if (ep._dropNext) { ep._dropNext = false; return true; }       // swallowed
      if (ep._swapArm >= 0) {
        // second of a swapped pair: inserted BEFORE the held first frame
        ep._outbox.splice(ep._swapArm, 0, frame);
        ep._swapArm = -1;
      } else if (ep._swapNext) {
        ep._swapNext = false;
        ep._swapArm = ep._outbox.push(frame) - 1;
      } else {
        ep._outbox.push(frame);
      }
      if (ep._dupNext) { ep._outbox.push(frame); ep._dupNext = false; }
      return true;
    };

    ep.close = function () {
      if (!ep.open) return;
      ep.open = false;
      ep._emitStatus('closed');
    };

    // Move frames the PEER sent into our inbound queue (one hop of the wire).
    ep.pumpIn = function () {
      let n = 0;
      const out = (ep.peer && ep.peer._outbox) || [];
      while (out.length) { wire.push(out.shift()); n++; }
      return n;
    };

    // Deliver every queued inbound frame to this side's handlers.
    ep.flushIn = function () {
      let n = 0;
      while (wire.length) {
        const s = wire.shift();
        ep._deliver(s);
        n++;
      }
      return n;
    };

    ep.dropNext = function () { ep._dropNext = true; };
    ep.dupNext = function () { ep._dupNext = true; };
    ep.swapNext = function () { ep._swapNext = true; };
    return ep;
  }

  function loopbackPair(opts) {
    opts = opts || {};
    const wireA = [];   // frames destined for A
    const wireB = [];   // frames destined for B
    const a = makeLoopbackSide('a', wireA);
    const b = makeLoopbackSide('b', wireB);
    a.peer = b; b.peer = a;

    // Wire hops: when either side pumps, both wires advance one hop.
    function hop(fromSide) {
      fromSide.pumpIn();
      const other = fromSide === a ? b : a;
      other.pumpIn();
    }

    if (opts.auto) {
      // Live mode: send() completes the full wire hop synchronously so the
      // host/join UI behaves like an ordinary socket without a driver.
      const wrapSend = function (ep) {
        const orig = ep.send.bind(ep);
        ep.send = function (s) {
          const r = orig(s);
          hop(ep);
          ep.flushIn();
          ep.peer.flushIn();
          return r;
        };
      };
      wrapSend(a); wrapSend(b);
    }

    a.open = b.open = true;
    return { a: a, b: b, hop: hop };
  }

  // ---- impaired loopback (W23 latency/jitter harness) ----
  // Deterministic virtual-time wire: frames depart on send(), arrive when
  // pump() advances the virtual clock past their scheduled delivery time.
  // Impairments are driven by a seeded PRNG so failure traces reproduce.
  //   opts.latencyMs      one-way base delay
  //   opts.jitterMs       +- uniform jitter
  //   opts.dropRate       0..1 fraction of frames swallowed
  //   opts.dupRate        0..1 fraction duplicated
  //   opts.reorderChance  0..1 chance a frame swaps with its predecessor
  //   opts.seed           PRNG seed (deterministic traces)
  // Manual controls: pump(dtMs), stall(ms), resume(), plus per-side
  // close() honoring the endpoint contract.
  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeImpairedSide(label, q) {
    const ep = endpointBase('impaired:' + label);
    ep.open = true;
    ep._q = q;
    ep.send = function (s) {
      if (!ep.open || typeof s !== 'string') return false;
      q.push(String(s));
      return true;
    };
    ep.close = function () {
      if (!ep.open) return;
      ep.open = false;
      ep.qOut.length = 0;
      ep._emitStatus('closed');
    };
    ep.qOut = [];
    return ep;
  }

  function impairedPair(opts) {
    const o = Object.assign({
      latencyMs: 60, jitterMs: 15, dropRate: 0,
      dupRate: 0, reorderChance: 0, seed: 1
    }, opts || {});
    const rng = mulberry(o.seed | 0);
    let now = 0;
    let stallUntil = -1;

    function mkDir(peerSide) {
      const flight = [];              // [{at, frame}]
      let lastSched = -1;             // per-direction FIFO floor (TCP-like)
      return {
        peer: peerSide,
        flight: flight,
        depart(frame) {
          if (rng() < o.dropRate) return;            // swallowed
          const copies = (rng() < o.dupRate) ? 2 : 1;
          for (let c = 0; c < copies; c++) {
            let at = now + Math.max(0, o.latencyMs +
              (o.jitterMs > 0 ? (rng() * 2 - 1) * o.jitterMs : 0));
            if (copies > 1) at += 8 * (c + 1);       // duplicates trail
            // reliable-ordered semantics: jitter delays a frame but never
            // moves it ahead of an older one unless reorderChance says so.
            if (at < lastSched && !(flight.length && rng() < o.reorderChance)) {
              at = lastSched;
            }
            lastSched = at;
            flight.push({ at: at, frame: frame });
          }
        },
        deliverDue() {
          if (!this.peer || !this.peer.open) { flight.length = 0; return 0; }
          if (now < stallUntil) return 0;
          let n = 0;
          let guard = 4096;
          while (flight.length && guard-- > 0) {
            let minI = -1, minAt = Infinity;
            for (let i = 0; i < flight.length; i++) {
              if (flight[i].at < minAt) { minAt = flight[i].at; minI = i; }
            }
            if (minI < 0 || minAt > now) break;
            const f = flight.splice(minI, 1)[0];
            this.peer._deliver(f.frame);
            n++;
          }
          return n;
        }
      };
    }

    const aToB = mkDir(null), bToA = mkDir(null);
    const a = makeImpairedSide('a', null);
    const b = makeImpairedSide('b', null);
    aToB.peer = b; bToA.peer = a;
    a.dir = aToB; b.dir = bToA;
    // send() routes straight into the wire model
    a.send = function (s) {
      if (!a.open || typeof s !== 'string') return false;
      aToB.depart(String(s));
      return true;
    };
    b.send = function (s) {
      if (!b.open || typeof s !== 'string') return false;
      bToA.depart(String(s));
      return true;
    };
    a.close = function () {
      if (!a.open) return;
      a.open = false; aToB.flight.length = 0; a._emitStatus('closed');
    };
    b.close = function () {
      if (!b.open) return;
      b.open = false; bToA.flight.length = 0; b._emitStatus('closed');
    };

    return {
      a: a, b: b,
      time: function () { return now; },
      inflight: function () { return aToB.flight.length + bToA.flight.length; },
      pump: function (dtMs) {
        now += Math.max(0, dtMs | 0);
        return aToB.deliverDue() + bToA.deliverDue();
      },
      stall: function (ms) { stallUntil = now + Math.max(0, ms | 0); },
      resume: function () { stallUntil = -1; }
    };
  }

  // ---- WebSocket client ----
  function websocket(url, opts) {
    opts = opts || {};
    const ep = endpointBase('ws:' + url);
    const WS = (typeof WebSocket !== 'undefined') ? WebSocket : null;
    if (!WS) {
      // defer the error so callers can attach onStatus first
      setTimeout(function () { ep._emitStatus('error', 'WebSocket unavailable'); }, 0);
      ep.send = function () { return false; };
      ep.close = function () {};
      return ep;
    }
    let ws;
    try { ws = new WS(url); } catch (e) {
      setTimeout(function () { ep._emitStatus('error', String(e && e.message || e)); }, 0);
      ep.send = function () { return false; };
      ep.close = function () {};
      return ep;
    }
    const MAX_BACKLOG = 64;
    let backlog = [];
    ep.open = false;
    ep._ws = ws;
    ep.send = function (s) {
      if (!ep.open) {
        if (backlog.length < MAX_BACKLOG) backlog.push(String(s));
        return ep.open ? true : backlog.length < MAX_BACKLOG;
      }
      if (ws.readyState !== 1) return false;
      ws.send(String(s));
      return true;
    };
    ep.close = function (reason) {
      try { ws.close(1000, reason ? String(reason).slice(0, 100) : ''); } catch (e) {}
    };
    ws.onopen = function () {
      ep.open = true;
      const q = backlog; backlog = [];
      for (let i = 0; i < q.length; i++) { try { ws.send(q[i]); } catch (e) {} }
      ep._emitStatus('open');
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') ep._deliver(ev.data);
    };
    ws.onclose = function () {
      ep.open = false;
      ep._emitStatus('closed');
    };
    ws.onerror = function () {
      ep._emitStatus('error', 'socket error');
    };
    return ep;
  }

  TC.NetTransport = {
    loopbackPair: loopbackPair,
    impairedPair: impairedPair,
    websocket: websocket
  };
})();

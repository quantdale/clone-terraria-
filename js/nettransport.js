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
    websocket: websocket
  };
})();

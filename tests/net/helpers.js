/* tests/net/helpers.js — shared utilities for the W22 multiplayer suites.
   Drivers are honest protocol participants: they speak ONLY validated JSON
   messages over an endpoint contract identical to a real transport, so every
   assertion exercises the same fail-closed path a network client hits. */

const path = require("path");
const { loadGame } = require(path.join("..", "..", "tests", "helpers", "load-game.js"));

// A minimal endpoint + captured outbox. `feed(msg)` is the driver's upstream:
// it pushes one protocol message toward whoever attached (the server).
function makeDriver(label) {
  const outbox = [];
  let inbound = null;
  const ep = {
    label: label || "driver",
    open: true,
    send(s) {
      if (!this.open) return false;
      outbox.push(JSON.parse(s));
      return true;
    },
    close() { this.open = false; },
    onMessage(fn) { inbound = fn; },
    onStatus() {},
    feed(msg) {
      if (!inbound) throw new Error("no listener attached");
      inbound(JSON.stringify(msg));
    },
    feedRaw(raw) {
      if (!inbound) throw new Error("no listener attached");
      inbound(raw);
    }
  };
  return { ep, outbox };
}

function msg(type, p, extra) {
  const body = Object.assign({
    v: 4, t: type, sid: null, pid: null,
    cseq: 0, sseq: 0, tick: 0,
    p: p || {}
  }, extra || {});
  // W25 protocol v4: hello/welcome REQUIRE pack-set identity. Tests that do
  // not care pass the empty (base) set; negative tests override explicitly.
  if ((type === 'hello' || type === 'welcome') && body.p && body.p.packs === undefined) {
    body.p.packs = { fp: '', list: [] };
  }
  return body;
}

// Join flow against a running server: returns {pid, welcome} after pumping.
function joinDriver(TC, server, driver, name) {
  const connected = server.connect(driver.ep, { name });
  if (!connected.ok) throw new Error("connect failed: " + connected.error);
  driver.ep.feed(msg("hello", { name: name || "Driver" }));
  TC.Runtime.advanceTicks(1); // processInbound runs inside server.tick? No —
  // drivers call server.processInbound()+tick() themselves; this helper is
  // only used by suites that drive ticks manually afterwards.
  const welcome = driver.outbox.find((m) => m.t === "welcome");
  const reject = driver.outbox.find((m) => m.t === "reject");
  return { ok: !!welcome, pid: welcome ? welcome.p.you.pid : null, welcome, reject };
}

// Send N input samples with strictly increasing cseq.
function sendInput(driver, seq, btn, aim, use, slot) {
  driver.ep.feed(msg("input", {
    btn: btn || [0, 0, 0],
    aimX: (aim && aim.x) || 0, aimY: (aim && aim.y) || 0,
    use: use ? 1 : 0,
    slot: slot == null ? undefined : slot
  }, { sid: driver.sid || null, pid: driver.pid || null, cseq: seq }));
}

function sendCmd(driver, seq, name, ctx) {
  driver.ep.feed(msg("cmd", { name, ctx: ctx || {} }, {
    sid: driver.sid || null, pid: driver.pid || null, cseq: seq
  }));
}

// First solid tile scan near (tx,ty), spiral-free simple ring search.
function findTileNear(world, pred, tx, ty, maxR) {
  maxR = maxR || 40;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (x < 1 || y < 1 || x >= world.width - 1 || y >= world.height - 1) continue;
        if (pred(world.get(x, y))) return { tx: x, ty: y };
      }
    }
  }
  return null;
}

module.exports = { loadGame, makeDriver, msg, joinDriver, sendInput, sendCmd, findTileNear };

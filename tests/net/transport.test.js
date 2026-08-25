/* tests/net/transport.test.js — transport boundary (W22 §7):
   loopback determinism + hostile injection + a REAL WebSocket round-trip
   through the dependency-free Node shim using the platform client. */

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const nodePath = require("path");
const { loadGame } = require("./helpers.js");
const wsShim = require(nodePath.join(__dirname, "..", "..", "tools", "net", "wsserver.js"));

const TC = loadGame({ hash: "" }).TC;

test("transport: loopback delivers in FIFO order under manual pumping", () => {
  const pair = TC.NetTransport.loopbackPair();
  const gotA = [], gotB = [];
  pair.a.onMessage((s) => gotA.push(s));
  pair.b.onMessage((s) => gotB.push(s));

  pair.a.send("b1"); pair.a.send("b2"); pair.b.send("a1");
  assert.strictEqual(gotB.length, 0, "nothing moves until pumped");

  pair.b.pumpIn();            // move A's frames onto B's wire
  pair.b.flushIn();
  assert.deepEqual(gotB, ["b1", "b2"], "FIFO to B");
  pair.a.pumpIn(); pair.a.flushIn();
  assert.deepEqual(gotA, ["a1"], "FIFO to A");
});

test("transport: hostile injection (drop/duplicate/swap) is controllable", () => {
  const pair = TC.NetTransport.loopbackPair();
  const got = [];
  pair.b.onMessage((s) => got.push(s));
  pair.a.dropNext(); pair.a.send("lost");
  pair.a.dupNext(); pair.a.send("twice");
  pair.a.swapNext(); pair.a.send("first"); pair.a.send("second");
  pair.b.pumpIn(); pair.b.flushIn();
  assert.deepEqual(got, ["twice", "twice", "second", "first"],
    "drop swallowed one, dup doubled one, swap reversed the last two");
});

test("transport: closed endpoints refuse sends", () => {
  const pair = TC.NetTransport.loopbackPair();
  pair.a.close();
  assert.strictEqual(pair.a.send("x"), false);
});

test("transport: REAL WebSocket server shim echoes through the platform client", async () => {
  if (typeof WebSocket === "undefined") {
    console.log("skip: platform WebSocket unavailable");
    return;
  }
  const server = http.createServer();
  const wss = wsShim.attach(server);
  const seenByServer = [];
  let serverEp = null;
  wss.onConnection((ep) => {
    serverEp = ep;
    ep.onMessage((s) => {
      seenByServer.push(s);
      ep.send('{"echo":' + s + '}');
    });
  });
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  const got = [];
  await new Promise((resolveAll, rejectAll) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timeout = setTimeout(() => rejectAll(new Error("ws echo timed out")), 5000);
    ws.onopen = () => {
      ws.send('"hello-ws"');
      ws.send('"hello-ws-2"');
    };
    ws.onmessage = (ev) => {
      got.push(ev.data);
      if (got.length >= 2) {
        clearTimeout(timeout);
        ws.close();
        resolveAll();
      }
    };
    ws.onerror = () => { clearTimeout(timeout); rejectAll(new Error("socket error")); };
  });

  assert.deepStrictEqual(seenByServer, ['"hello-ws"', '"hello-ws-2"'], "server saw both frames");
  assert.strictEqual(got.length, 2, "client got both echoes");
  for (const raw of got) {
    const parsed = JSON.parse(raw);
    assert.ok(parsed.echo, "echo envelope present");
  }
  await new Promise((res) => server.close(res));
});

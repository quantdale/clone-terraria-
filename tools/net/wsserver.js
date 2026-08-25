/* tools/net/wsserver.js — minimal RFC 6455 WebSocket server shim (W22).
   Zero dependencies: implements exactly what the game protocol needs over
   Node's http upgrade path — handshake, masked client frames, unmasked text
   frames back, ping/pong, close. Fragmentation is reassembled; everything
   else fails closed. Endpoint contract matches TC.NetTransport
   (onMessage/onStatus/send/close), so TC.NetServer.connect(ep) consumes it. */
'use strict';
const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 1 << 20; // 1 MiB hard cap per assembled message

function encodeText(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function makeEndpoint(socket, label) {
  const ep = {
    label: label || "ws-client",
    open: true,
    _msg: null,
    _status: null,
    _buf: Buffer.alloc(0),
    _frags: null,
    onMessage(fn) { this._msg = fn; },
    onStatus(fn) { this._status = fn; },
    send(s) {
      if (!this.open || socket.destroyed) return false;
      try { socket.write(encodeText(String(s))); return true; } catch (e) { return false; }
    },
    close(reason) {
      if (!this.open) return;
      this.open = false;
      try {
        const code = Buffer.alloc(2);
        code.writeUInt16BE(1000, 0);
        const r = Buffer.from(String(reason || "").slice(0, 120), "utf8").slice(0, 123);
        const h = Buffer.from([0x88, Math.min(125, r.length + 2)]);
        socket.write(Buffer.concat([h, code, r]));
      } catch (e) {}
      try { socket.end(); } catch (e) {}
      if (this._status) try { this._status("closed", reason); } catch (e) {}
    },
    _emit(st, d) { if (this._status) try { this._status(st, d); } catch (e) {} },
    // ---- incremental frame parse (client frames are always masked) ----
    _feed(chunk) {
      this._buf = Buffer.concat([this._buf, chunk]);
      for (;;) {
        const buf = this._buf;
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const op = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(MAX_MESSAGE)) { this.close('frame-too-large'); return; }
          len = Number(big); off = 10;
        }
        if (len > MAX_MESSAGE) { this.close('frame-too-large'); return; }
        const maskLen = masked ? 4 : 0;
        if (!masked && op === 0x1) { this.close('unmasked-client-frame'); return; }
        if (buf.length < off + maskLen + len) return;
        let payload = buf.slice(off + maskLen, off + maskLen + len);
        if (masked) {
          const mask = buf.slice(off, off + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        this._buf = buf.slice(off + maskLen + len);
        this._frame(op, fin, payload);
      }
    },
    _frame(op, fin, payload) {
      switch (op) {
        case 0x0: // continuation
          if (!this._frags) { this.close('unexpected-continuation'); return; }
          this._frags.push(payload);
          if (fin) this._finishFrags();
          return;
        case 0x1: // text
        case 0x2: // binary — protocol is JSON text; binary fails closed later
          if (!fin) { this._frags = [payload]; return; }
          this._deliver(op, payload);
          return;
        case 0x8: // close
          this.close('peer-close');
          return;
        case 0x9: // ping -> pong
          try {
            const h = Buffer.from([0x8a, Math.min(125, payload.length)]);
            this._socket.write(Buffer.concat([h, payload]));
          } catch (e) {}
          return;
        case 0xA: // unsolicited pong: ignore
          return;
        default:
          this.close('bad-opcode');
      }
    },
    _finishFrags() {
      const parts = this._frags;
      this._frags = null;
      if (!parts) return;
      let total = 0;
      for (const p of parts) total += p.length;
      if (total > MAX_MESSAGE) { this.close('message-too-large'); return; }
      this._deliver(0x1, Buffer.concat(parts));
    },
    _deliver(op, payload) {
      if (op !== 0x1) { this.close('binary-unsupported'); return; }
      if (this._msg) {
        try { this._msg(payload.toString("utf8")); } catch (e) {}
      }
    },
  };
  ep._socket = socket;
  return ep;
}

// Attach to an http.Server: handles GET /ws-style upgrades. Returns {count}
// handle with an onConnection(fn(endpoint)) hook for the host tool.
function attach(httpServer) {
  const handle = { _conn: null, onConnection(fn) { this._conn = fn; } };
  httpServer.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const want = req.headers.upgrade && /websocket/i.test(req.headers.upgrade);
    if (!key || !want || req.headers["sec-websocket-version"] !== "13") {
      try { socket.destroy(); } catch (e) {}
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    const headers =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;
    socket.write(headers);
    socket.setNoDelay(true);
    const ep = makeEndpoint(socket);
    socket.on("data", (c) => { try { ep._feed(c); } catch (e) { ep.close('parse-error'); } });
    socket.on("close", () => ep.close('transport-closed'));
    socket.on("error", () => ep.close('socket-error'));
    if (handle._conn) handle._conn(ep);
  });
  return handle;
}

module.exports = { attach, encodeText };

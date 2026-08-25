/* netproto.js — TC.NetProto: THE versioned authoritative-multiplayer protocol
   (W22 / NET-002).

   Envelope (every message):
     {
       v:    1                  protocol version (integer, exact match required)
       t:    '<TypeName>'       message type (see TYPES)
       sid:  '<sessionId>|null' session identity where applicable
       pid:  '<playerId>|null'  acting player id (server-assigned; never trusted
                             before the server binds it to the connection)
       cseq: <uint>             client monotonic sequence (client->server msgs)
       sseq: <uint>             server monotonic sequence (server->client msgs)
       tick: <uint>             authoritative simulation tick
       p:    { ... }            type-specific payload
     }

   DESIGN RULES (enforced here, tested hostilely):
     - fail closed: any malformed envelope or payload is rejected whole — an
       invalid message NEVER reaches a mutation API;
     - unknown protocol versions are rejected explicitly;
     - only whitelisted command names may ride 'cmd' messages;
     - all numbers must be finite and within declared ranges; strings bounded;
     - no code, no functions, no arbitrary nested objects cross the wire;
     - deterministic codecs: identical state -> identical bytes.

   TRANSPORT-AGNOSTIC: pure data in/out, zero DOM/Canvas/socket references —
   the loopback transport, the WebSocket transport and Node hosts all share it. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const VERSION = 2;

  // Maximum serialized message size accepted by decode() (bytes of JSON).
  // Region snapshots are the largest legitimate messages by far; a full
  // region encodes to well under 8 KB, so this cap bounds abuse, not play.
  const MAX_MESSAGE_BYTES = 512 * 1024;
  const MAX_STR = 64;
  const MAX_NAME = 24;

  const TYPES = Object.freeze({
    hello: 'hello',           // C->S  open a connection (or rejoin)
    welcome: 'welcome',       // S->C  accepted: identity + join snapshot ref
    reject: 'reject',         // S->C  refused: {reason}
    snapshot: 'snapshot',     // S->C  initial/resync authoritative state
    input: 'input',           // C->S  continuous per-tick sampled input
    cmd: 'cmd',               // C->S  discrete gameplay intent
    cmdres: 'cmdres',         // S->C  authoritative command outcome
    worldupd: 'worldupd',     // S->C  incremental region + entity updates
    ack: 'ack',               // C<->S delivery/revision acknowledgement
    resync: 'resync',         // C->S request | S->C grant {reason}
    bye: 'bye'                // both  orderly disconnect {reason}
  });

  // Network-callable commands (NET-002 whitelist; W23 adds craft/shop/
  // container transactions). Anything else is rejected before it can reach
  // TC.Commands.
  const COMMAND_WHITELIST = Object.freeze([
    'MineTile', 'MineWall', 'PlaceTile', 'PlaceWall',
    'UseItem', 'MoveItem', 'EquipItem', 'InteractTile',
    'CraftRecipe', 'ShopBuy', 'ShopSell', 'ContainerMove'
  ]);

  // Bounded per-command intent schemas (W23). Only these primitive keys are
  // accepted inside a 'cmd' payload's ctx object — anything else rejects
  // before reaching transaction validation. Endpoints for ContainerMove:
  // 0 = chest container, 1 = acting player's inventory.
  const CTX_SCHEMAS = {
    MineTile: { tx: 'u21', ty: 'u21' },
    MineWall: { tx: 'u21', ty: 'u21' },
    PlaceTile: { tx: 'u21', ty: 'u21', item: 's64', slot: 'slot' },
    PlaceWall: { tx: 'u21', ty: 'u21', item: 's64', slot: 'slot' },
    UseItem: { slot: 'slot', aimX: 'f', aimY: 'f' },
    MoveItem: { fromSlot: 'slot', toSlot: 'slot', count: 'u21' },
    EquipItem: { item: 's64', slot: 'slot' },
    InteractTile: { tx: 'u21', ty: 'u21' },
    CraftRecipe: { recipeId: 's64' },
    ShopBuy: { npcType: 's32', itemId: 's64' },
    ShopSell: { npcType: 's32', slot: 'slot', count: 'u21' },
    ContainerMove: {
      tx: 'u21', ty: 'u21', from: 'endpoint', to: 'endpoint',
      fromSlot: 'slot', toSlot: 'slot', count: 'u21'
    }
  };

  function validCtx(name, ctx) {
    const sch = CTX_SCHEMAS[name];
    if (!sch) return false;
    for (const k in ctx) {
      const kind = sch[k];
      if (!kind) return false;                    // unknown field: fail closed
      const v = ctx[k];
      if (kind === 'u21') { if (!uint(v, 0x200000)) return false; }
      else if (kind === 'slot') {
        if (v === undefined) continue;
        if (!uint(v, 255)) return false;
      } else if (kind === 'f') {
        if (!num(v, -1e7, 1e7)) return false;
      } else if (kind === 's32') { if (!str(v, 32)) return false; }
      else if (kind === 's64') { if (!str(v, MAX_STR)) return false; }
      else if (kind === 'endpoint') { if (v !== 0 && v !== 1) return false; }
      else return false;
    }
    return true;
  }

  // ---- primitive validators ----
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && (v | 0) === v; }
  function uint(v, max) {
    return isInt(v) && v >= 0 && (max == null || v <= max);
  }
  function num(v, lo, hi) {
    return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
  }
  function str(v, max) {
    return typeof v === 'string' && v.length <= max;
  }
  function strArr(v, maxLen, maxStr) {
    if (!Array.isArray(v) || v.length > maxLen) return false;
    for (let i = 0; i < v.length; i++) if (!str(v[i], maxStr)) return false;
    return true;
  }

  function err(where, why) { return { ok: false, error: where + ': ' + why }; }
  function ok(msg) { return { ok: true, msg: msg }; }

  // ---- payload schemas ----
  // Each validator receives p (already proven an object) and returns null or
  // an error string. Unknown payload keys are rejected (fail closed).
  const PAYLOAD_KEYS = {
    hello: ['name', 'rejoin'],
    welcome: ['tick', 'seed', 'you', 'players', 'mode'],
    reject: ['reason'],
    snapshot: ['reason', 'seed', 'you', 'regions', 'players', 'enemies', 'drops'],
    input: ['btn', 'aimX', 'aimY', 'use', 'slot'],
    cmd: ['name', 'ctx'],
    cmdres: ['ref', 'ok', 'error', 'result'],
    worldupd: ['regions', 'players', 'enemies', 'drops', 'inv', 'chest', 'rm'],
    ack: ['upto', 'regions'],
    resync: ['reason'],
    bye: ['reason']
  };

  // btn: [x (-1..1 int), jump(0/1), down(0/1)]
  function validBtn(b) {
    return Array.isArray(b) && b.length === 3 &&
      num(b[0], -1, 1) && (b[0] | 0) === b[0] &&
      (b[1] === 0 || b[1] === 1) && (b[2] === 0 || b[2] === 1);
  }

  // A replicated entity/player snapshot line: bounded primitives only.
  // Full form (snapshot msgs / first send): all numeric fields required.
  function validSnap(o, withName) {
    if (!isObj(o)) return false;
    if (!str(o.id, MAX_STR)) return false;
    if (!num(o.x, -1e7, 1e7) || !num(o.y, -1e7, 1e7)) return false;
    if (!num(o.vx, -1e5, 1e5) || !num(o.vy, -1e5, 1e5)) return false;
    if (!uint(o.hp, 1e6) || !uint(o.maxHp, 1e6)) return false;
    if (withName && !str(o.name, MAX_NAME)) return false;
    if (o.face !== undefined && o.face !== -1 && o.face !== 1) return false;
    if (o.type !== undefined && !str(o.type, MAX_STR)) return false;
    if (o.count !== undefined && !uint(o.count, 999999)) return false;
    return true;
  }

  // W23 delta line: id required; every other field optional-but-bounded so a
  // baselined update can carry only what changed. Unknown keys already fail
  // via PAYLOAD_KEYS at the envelope level; per-key bounds hold here.
  function validSnapDelta(o) {
    if (!isObj(o)) return false;
    if (!str(o.id, MAX_STR)) return false;
    if ((o.x !== undefined && !num(o.x, -1e7, 1e7)) ||
        (o.y !== undefined && !num(o.y, -1e7, 1e7))) return false;
    if ((o.vx !== undefined && !num(o.vx, -1e5, 1e5)) ||
        (o.vy !== undefined && !num(o.vy, -1e5, 1e5))) return false;
    if (o.hp !== undefined && !uint(o.hp, 1e6)) return false;
    if (o.maxHp !== undefined && !uint(o.maxHp, 1e6)) return false;
    if (o.face !== undefined && o.face !== -1 && o.face !== 1) return false;
    if (o.type !== undefined && !str(o.type, MAX_STR)) return false;
    if (o.name !== undefined && !str(o.name, MAX_NAME)) return false;
    if (o.count !== undefined && !uint(o.count, 999999)) return false;
    return true;
  }

  // Region update line: either a full layer pair (hex strings) or a delta
  // cell list [[cellIdx, tile, wall], ...] within one 32x32 region.
  function validRegion(r) {
    if (!isObj(r)) return false;
    if (!uint(r.idx, 1 << 24)) return false;
    if (!uint(r.rev, 0xffffffff)) return false;
    const fullT = str(r.tiles, 4096) || r.tiles === undefined;
    const fullW = str(r.walls, 4096) || r.walls === undefined;
    if (!fullT || !fullW) return false;
    if (r.tiles === undefined && r.walls === undefined && !Array.isArray(r.cells)) return false;
    if (Array.isArray(r.cells)) {
      if (r.cells.length > 1024) return false;
      for (let i = 0; i < r.cells.length; i++) {
        const c = r.cells[i];
        if (!Array.isArray(c) || c.length !== 3 ||
            !uint(c[0], 1023) || !uint(c[1], 255) || !uint(c[2], 255)) return false;
      }
    }
    return true;
  }

  function validRegions(a, maxN) {
    if (!Array.isArray(a) || a.length > maxN) return false;
    for (let i = 0; i < a.length; i++) if (!validRegion(a[i])) return false;
    return true;
  }

  function validSnaps(a, maxN, withName) {
    if (!Array.isArray(a) || a.length > maxN) return false;
    for (let i = 0; i < a.length; i++) if (!validSnap(a[i], withName)) return false;
    return true;
  }

  function validSnapDeltas(a, maxN) {
    if (!Array.isArray(a) || a.length > maxN) return false;
    for (let i = 0; i < a.length; i++) if (!validSnapDelta(a[i])) return false;
    return true;
  }

  // W23 explicit removals/tombstones: {p:[ids], e:[ids], d:[ids]} bounded.
  function validRm(rm) {
    if (!isObj(rm)) return false;
    for (const k in rm) {
      if (!(k === 'p' || k === 'e' || k === 'd')) return false;
      if (!strArr(rm[k], 256, MAX_STR)) return false;
    }
    return true;
  }

  function emptyOrAbsent(p, key) {
    return p[key] === undefined || p[key] === null ||
      (Array.isArray(p[key]) && p[key].length === 0);
  }

  // Inventory slot list: array of null | [id(<=64), count] — bounded.
  function validSlots(a, maxN) {
    if (!Array.isArray(a) || a.length > (maxN || 64)) return false;
    for (let i = 0; i < a.length; i++) {
      const line = a[i];
      if (line === null) continue;
      if (!Array.isArray(line) || line.length !== 2 ||
          !str(line[0], MAX_STR) || !uint(line[1], 999999)) return false;
    }
    return true;
  }

  // Authoritative container sync: {tx, ty, slots:[null|[id,count]] x<=20}.
  function validChest(c) {
    if (!isObj(c)) return false;
    if (!uint(c.tx, 0x200000) || !uint(c.ty, 0x200000)) return false;
    if (!Array.isArray(c.slots) || c.slots.length > 20) return false;
    return validSlots(c.slots, 20);
  }

  // Bounded command-result bundle riding cmdres: an action tag plus optional
  // authoritative inventory/container mirrors.
  function validResult(r) {
    if (!isObj(r)) return false;
    for (const k in r) {
      if (!(k === 'action' || k === 'inv' || k === 'chest')) return false;
    }
    if (r.action !== undefined && !str(r.action, 16)) return false;
    if (r.inv !== undefined && !validSlots(r.inv)) return false;
    if (r.chest !== undefined && !validChest(r.chest)) return false;
    return true;
  }

  const SCHEMA = {
    hello(p) {
      if (p.name !== undefined && !str(p.name, MAX_NAME)) return 'bad name';
      if (p.rejoin !== undefined) {
        const r = p.rejoin;
        if (!isObj(r) || !str(r.sid, MAX_STR) || !str(r.pid, MAX_STR) ||
            !uint(r.tick, 0xffffffff)) return 'bad rejoin';
      }
      return null;
    },
    welcome(p) {
      if (!uint(p.tick, 0xffffffff)) return 'bad tick';
      if (!isInt(p.seed)) return 'bad seed';
      if (!isObj(p.you) || !str(p.you.pid, MAX_STR)) return 'bad you';
      return null;
    },
    reject(p) { return str(p.reason, MAX_STR) ? null : 'bad reason'; },
    snapshot(p) {
      if (p.reason !== undefined && !str(p.reason, MAX_STR)) return 'bad reason';
      if (!isInt(p.seed)) return 'bad seed';
      if (!isObj(p.you) || !str(p.you.pid, MAX_STR)) return 'bad you';
      if (!validRegions(p.regions, 4096)) return 'bad regions';
      if (!validSnaps(p.players, 8, true)) return 'bad players';
      if (!validSnapDeltas(p.enemies, 256)) return 'bad enemies';
      if (!validSnapDeltas(p.drops, 256)) return 'bad drops';
      return null;
    },
    input(p) {
      if (!validBtn(p.btn)) return 'bad btn';
      if (!num(p.aimX, -1e7, 1e7) || !num(p.aimY, -1e7, 1e7)) return 'bad aim';
      if (p.use !== undefined && (p.use !== 0 && p.use !== 1)) return 'bad use';
      if (p.slot !== undefined && !uint(p.slot, 9)) return 'bad slot';
      return null;
    },
    cmd(p) {
      if (!str(p.name, 32) || COMMAND_WHITELIST.indexOf(p.name) < 0) {
        return 'unknown command';
      }
      if (!isObj(p.ctx)) return 'bad ctx';
      if (!validCtx(p.name, p.ctx)) return 'bad ctx fields';
      return null;
    },
    cmdres(p) {
      if (!uint(p.ref, 0xffffffff)) return 'bad ref';
      if (typeof p.ok !== 'boolean') return 'bad ok';
      if (p.error !== undefined && !str(p.error, 128)) return 'bad error';
      if (p.result !== undefined && !validResult(p.result)) return 'bad result';
      return null;
    },
    worldupd(p) {
      if (!validRegions(p.regions, 64)) return 'bad regions';
      if (!validSnapDeltas(p.players, 8)) return 'bad players';
      if (!validSnapDeltas(p.enemies, 128)) return 'bad enemies';
      if (!validSnapDeltas(p.drops, 160)) return 'bad drops';
      if (p.inv !== undefined && !validSlots(p.inv)) return 'bad inv';
      if (p.chest !== undefined && !validChest(p.chest)) return 'bad chest';
      if (p.rm !== undefined && !validRm(p.rm)) return 'bad rm';
      return null;
    },
    ack(p) {
      if (!isObj(p.upto) || !uint(p.upto.sseq, 0xffffffff) ||
          !uint(p.upto.tick, 0xffffffff)) return 'bad upto';
      if (p.regions !== undefined) {
        if (!Array.isArray(p.regions) || p.regions.length > 512) return 'bad regions';
        for (let i = 0; i < p.regions.length; i++) {
          const r = p.regions[i];
          if (!Array.isArray(r) || r.length !== 2 ||
              !uint(r[0], 1 << 24) || !uint(r[1], 0xffffffff)) return 'bad region ack';
        }
      }
      return null;
    },
    resync(p) { return str(p.reason, MAX_STR) ? null : 'bad reason'; },
    bye(p) { return str(p.reason, MAX_STR) ? null : 'bad reason'; }
  };

  // Full fail-closed envelope + payload validation.
  function validate(m) {
    if (!isObj(m)) return err('envelope', 'not an object');
    for (const k in m) {
      if (!(k === 'v' || k === 't' || k === 'sid' || k === 'pid' ||
            k === 'cseq' || k === 'sseq' || k === 'tick' || k === 'p')) {
        return err('envelope', 'unknown field "' + k + '"');
      }
    }
    if (m.v !== VERSION) return err('version', 'expected ' + VERSION + ', got ' + String(m.v));
    if (!str(m.t, 16) || !TYPES[m.t]) return err('type', 'unknown "' + String(m.t) + '"');
    if (m.sid !== null && m.sid !== undefined && !str(m.sid, MAX_STR)) return err('sid', 'bad');
    if (m.pid !== null && m.pid !== undefined && !str(m.pid, MAX_STR)) return err('pid', 'bad');
    if (!uint(m.cseq, 0xffffffff)) return err('cseq', 'must be uint');
    if (!uint(m.sseq, 0xffffffff)) return err('sseq', 'must be uint');
    if (!uint(m.tick, 0xffffffff)) return err('tick', 'must be uint');
    if (!isObj(m.p)) return err('payload', 'not an object');
    const keys = PAYLOAD_KEYS[m.t];
    for (const k in m.p) {
      if (keys.indexOf(k) < 0) return err('payload.' + m.t, 'unknown field "' + k + '"');
    }
    const why = SCHEMA[m.t](m.p);
    if (why) return err(m.t, why);
    return ok(m);
  }

  function encode(m) {
    const v = validate(m);
    if (!v.ok) return null;
    let out = null;
    try { out = JSON.stringify(m); } catch (e) { return null; }
    if (typeof out !== 'string' || out.length > MAX_MESSAGE_BYTES) return null;
    return out;
  }

  function decode(raw) {
    if (typeof raw !== 'string' || !raw.length) return err('decode', 'empty frame');
    if (raw.length > MAX_MESSAGE_BYTES) return err('decode', 'frame too large');
    let m;
    try { m = JSON.parse(raw); } catch (e) { return err('decode', 'invalid JSON'); }
    return validate(m);
  }

  // ---- region codec ----
  // Full layers as hex pairs (deterministic; compact enough for the slice),
  // deltas as [cellIdx, tile, wall] triples relative to the last ACKED copy.
  function hexBytes(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  }

  function buildFullRegion(idx, rev, tiles, walls) {
    return { idx: idx, rev: rev, tiles: hexBytes(tiles), walls: hexBytes(walls) };
  }

  function diffRegion(prevTiles, prevWalls, curTiles, curWalls) {
    const cells = [];
    const n = Math.min(curTiles.length, 1024);
    for (let i = 0; i < n; i++) {
      const t = curTiles[i], w = curWalls[i];
      const pt = prevTiles ? prevTiles[i] : -1;
      const pw = prevWalls ? prevWalls[i] : -1;
      if (t !== pt || w !== pw) cells.push([i, t, w]);
    }
    return cells;
  }

  function applyCells(tiles, walls, cells) {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      tiles[c[0]] = c[1];
      walls[c[0]] = c[2];
    }
  }

  // ---- deterministic digests (tests + resync verification) ----
  // FNV-1a over canonical gameplay bytes ONLY: tiles, walls, player/enemy/
  // drop essentials. Presentation caches are excluded by construction.
  function fnv(h, u8) {
    for (let i = 0; i < u8.length; i++) {
      h ^= u8[i];
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function fnvStr(h, s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h ^= c & 0xff; h = (h * 0x01000193) >>> 0;
      h ^= (c >> 8) & 0xff; h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function fnvNum(h, n) {
    // little-endian 4-byte mix of a finite integer-ish value
    const v = isFinite(n) ? (n | 0) : 0;
    h ^= v & 0xff; h = (h * 0x01000193) >>> 0;
    h ^= (v >>> 8) & 0xff; h = (h * 0x01000193) >>> 0;
    h ^= (v >>> 16) & 0xff; h = (h * 0x01000193) >>> 0;
    h ^= (v >>> 24) & 0xff; h = (h * 0x01000193) >>> 0;
    return h >>> 0;
  }

  function digestWorld(world) {
    if (!world || !world.tiles) return 0;
    let h = 0x811c9dc5;
    h = fnv(h, world.tiles);
    if (world.walls) h = fnv(h, world.walls);
    return h >>> 0;
  }

  function digestPlayers(list) {
    let h = 0x811c9dc5;
    const sorted = list.slice().sort(function (a, b) {
      return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    for (const p of sorted) {
      h = fnvStr(h, String(p.id));
      h = fnvNum(h, p.x); h = fnvNum(h, p.y);
      h = fnvNum(h, p.hp); h = fnvNum(h, p.maxHp);
      h = fnvNum(h, p.vx); h = fnvNum(h, p.vy);
    }
    return h >>> 0;
  }

  function digestInventory(inv) {
    let h = 0x811c9dc5;
    const slots = inv.slots.length;
    h = fnvNum(h, slots);
    for (let i = 0; i < slots; i++) {
      const s = inv.get(i);
      if (!s) { h = fnvNum(h, 0); continue; }
      h = fnvStr(h, String(s.id));
      h = fnvNum(h, s.count);
    }
    return h >>> 0;
  }

  const NetProto = {
    VERSION: VERSION,
    TYPES: TYPES,
    COMMAND_WHITELIST: COMMAND_WHITELIST,
    MAX_MESSAGE_BYTES: MAX_MESSAGE_BYTES,
    validate: validate,
    encode: encode,
    decode: decode,
    buildFullRegion: buildFullRegion,
    diffRegion: diffRegion,
    applyCells: applyCells,
    hexBytes: hexBytes,
    digestWorld: digestWorld,
    digestPlayers: digestPlayers,
    digestInventory: digestInventory
  };

  TC.NetProto = NetProto;
  NetProto.CTX_SCHEMAS = CTX_SCHEMAS;
})();

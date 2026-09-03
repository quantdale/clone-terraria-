/* tests/helpers/load-game.js — headless loader that executes the REAL game
   scripts (index.html order, including main.js) inside a vm context with
   browser stubs. Returns { TC, ctx, storage, listeners } for simulation. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");

// ---- canvas 2D context stub: every method no-ops, every property is benign ----
function makeCtx2D(canvas) {
  const target = {
    canvas,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "10px sans-serif",
    textAlign: "left",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: true,
    shadowBlur: 0,
    shadowColor: "transparent",
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      // method calls
      switch (prop) {
        case "measureText":
          return () => ({ width: 0 });
        case "createLinearGradient":
        case "createRadialGradient":
          return () => ({ addColorStop() {} });
        case "createPattern":
          return () => ({});
        case "getImageData":
          return (x, y, w, h) => ({
            data: new Uint8ClampedArray(w * h * 4),
            width: w,
            height: h,
          });
        case "createImageData":
          return (w, h) => ({
            data: new Uint8ClampedArray((w || 1) * (h || 1) * 4),
            width: w,
            height: h,
          });
        case "putImageData":
        case "drawImage":
        case "fillRect":
        case "strokeRect":
        case "clearRect":
        case "beginPath":
        case "closePath":
        case "moveTo":
        case "lineTo":
        case "arc":
        case "ellipse":
        case "rect":
        case "fill":
        case "stroke":
        case "clip":
        case "save":
        case "restore":
        case "translate":
        case "rotate":
        case "scale":
        case "setTransform":
        case "transform":
        case "setLineDash":
        case "fillText":
        case "strokeText":
        case "quadraticCurveTo":
        case "bezierCurveTo":
        case "arcTo":
        case "roundRect":
          return () => {};
        default:
          return undefined;
      }
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  });
}

function makeCanvas(w, h) {
  const canvas = {
    width: w || 300,
    height: h || 150,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: (this && this.width) || 300,
      height: 150,
    }),
  };
  canvas.getContext = () => makeCtx2D(canvas);
  return canvas;
}

function makeStorage() {
  const map = new Map();
  return {
    _map: map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

// Script order is DERIVED from index.html (the single source of truth), so a
// production script added there can never silently miss the headless suites.
// Local scripts outside js/ (e.g. declarative pack fixtures under packs/)
// ride along with their repo-relative path.
const INDEX_HTML = path.join(ROOT, "index.html");
function scriptOrderFromIndex() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const names = [];
  const re = /<script\s+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (/^js\/.+\.js$/.test(src)) names.push(src); // kept verbatim; loader resolves ROOT-relative
    else if (/^[a-z0-9_][a-z0-9_.\/-]*\.js$/i.test(src) && !/^https?:/.test(src)) {
      names.push(src); // repo-relative (e.g. declarative pack fixtures)
    }
  }
  if (!names.length)
    throw new Error("load-game: no js/<name>.js scripts found in index.html");
  return names;
}
const SCRIPT_ORDER = scriptOrderFromIndex();

function loadGame(opts) {
  opts = opts || {};
  const storage = opts.storage || makeStorage();
  const listeners = {};
  let rafCallback = null;
  let simTime = 0; // single synthetic clock (ms)

  const mainWindowCanvas = makeCanvas(1280, 720);
  const documentStub = {
    getElementById: () => mainWindowCanvas,
    createElement: (tag) =>
      tag === "canvas" ? makeCanvas() : { style: {}, appendChild() {} },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const a = listeners[type];
      if (a) {
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      }
    },
    body: { style: {} },
  };

  // W27 WS2: minimal Path2D stand-in. Construction/mutation methods are
  // pure JS geometry with no rasterizer traffic, so they no-op untallied —
  // mirroring real browsers, where the canvas-op counters wrap
  // CanvasRenderingContext2D.prototype only (ctx.fill(path) still tallies
  // exactly 1 there and here). Lets headless suites exercise the same
  // Path2D fast paths production uses instead of silently covering only
  // the no-Path2D fallbacks.
  const Path2DStub = class Path2DStub {
    constructor() {}
    moveTo() {}
    lineTo() {}
    closePath() {}
    arc() {}
    ellipse() {}
    rect() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    addPath() {}
  };

  const sandbox = {
    console,
    Path2D: Path2DStub,
    performance: { now: () => simTime },
    Math,
    Date,
    JSON,
    Object,
    Array,
    Map,
    Set,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Float32Array,
    Number,
    String,
    Boolean,
    Symbol,
    Promise,
    Error,
    isFinite,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    // W22: host-backed timers — net modules schedule work from inside the
    // VM realm (transport error deferral, standalone server driver).
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: documentStub,
    localStorage: storage,
    location: { hash: opts.hash || "" },
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    requestAnimationFrame(cb) {
      rafCallback = cb;
      return 1;
    },
    cancelAnimationFrame() {
      rafCallback = null;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const a = listeners[type];
      if (a) {
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      }
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  const names = (opts.scripts || SCRIPT_ORDER)
    .filter((n) => !(opts.omitScripts || []).some((pat) => n === pat || n.indexOf(pat) === 0));
  for (const name of names) {
    // Bare names are js/<name>.js (test subset syntax); anything containing a
    // slash is the repo-relative src recorded from index.html verbatim.
    const rel = name.indexOf("/") >= 0
      ? name
      : name.endsWith(".js") ? name : path.join("js", name + ".js");
    const file = path.join(ROOT, rel);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, {
      filename: rel.split(path.sep).join("/"),
    });
  }

  const TC = sandbox.TC;
  return {
    TC,
    ctx,
    storage,
    listeners,
    scriptOrderRun: names,
    startFrameLoop() {
      // run frames manually: step the captured rAF callback N times at 60fps.
      // Timestamps come from the same synthetic clock as performance.now(),
      // so main.js's dt math sees clean 1/60 steps from frame one.
      for (let i = 0; i < (opts.frames || 1); i++) {
        if (typeof rafCallback !== "function") break;
        simTime += 1000 / 60;
        const cb = rafCallback;
        rafCallback = null;
        cb(simTime);
      }
      return rafCallback; // non-null => loop wants to continue
    },
    getRaf: () => rafCallback,
  };
}

module.exports = { loadGame };

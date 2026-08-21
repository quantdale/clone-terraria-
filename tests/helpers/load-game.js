/* tests/helpers/load-game.js — headless loader that executes the REAL game
   scripts (index.html order, including main.js) inside a vm context with
   browser stubs. Returns { TC, ctx, storage, listeners } for simulation. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

// ---- canvas 2D context stub: every method no-ops, every property is benign ----
function makeCtx2D(canvas) {
  const target = {
    canvas,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent'
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      // method calls
      switch (prop) {
        case 'measureText': return () => ({ width: 0 });
        case 'createLinearGradient':
        case 'createRadialGradient': return () => ({ addColorStop() {} });
        case 'createPattern': return () => ({});
        case 'getImageData': return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
        case 'putImageData': case 'drawImage': case 'fillRect': case 'strokeRect':
        case 'clearRect': case 'beginPath': case 'closePath': case 'moveTo':
        case 'lineTo': case 'arc': case 'ellipse': case 'rect': case 'fill':
        case 'stroke': case 'clip': case 'save': case 'restore': case 'translate':
        case 'rotate': case 'scale': case 'setTransform': case 'transform':
        case 'setLineDash': case 'fillText': case 'strokeText': return () => {};
        default: return undefined;
      }
    },
    set(t, prop, v) { t[prop] = v; return true; }
  });
}

function makeCanvas(w, h) {
  const canvas = {
    width: w || 300, height: h || 150, style: {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: this && this.width || 300, height: 150 })
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
    get length() { return map.size; }
  };
}

// Script order mirrored from index.html (single source of truth for tests).
const SCRIPT_ORDER = [
  'constants', 'utils', 'registry', 'events', 'systems', 'commands', 'savecore',
  'liquids', 'progression', 'tiles', 'worldgen', 'world', 'loot', 'lighting',
  'sky', 'biomes', 'input', 'audio', 'music', 'particles', 'items', 'player',
  'accessories', 'stats', 'magic', 'fishing', 'enemies', 'npcs', 'projectiles',
  'combat', 'crafting', 'save', 'minimap', 'ui', 'gear', 'debug', 'main',
  'wiring'
];

function loadGame(opts) {
  opts = opts || {};
  const storage = makeStorage();
  const listeners = {};
  let rafCallback = null;

  const mainWindowCanvas = makeCanvas(1280, 720);
  const documentStub = {
    getElementById: () => mainWindowCanvas,
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {}, appendChild() {} }),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    },
    body: { style: {} }
  };

  const sandbox = {
    console,
    performance: { now: () => Date.now() },
    Math, Date, JSON, Object, Array, Map, Set, Uint8Array, Uint8ClampedArray,
    Int16Array, Float32Array, Number, String, Boolean, Symbol, Promise, Error,
    isFinite, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    document: documentStub,
    localStorage: storage,
    location: { hash: opts.hash || '' },
    innerWidth: 1280, innerHeight: 720,
    devicePixelRatio: 1,
    requestAnimationFrame(cb) { rafCallback = cb; return 1; },
    cancelAnimationFrame() { rafCallback = null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  const names = opts.scripts || SCRIPT_ORDER;
  for (const name of names) {
    const file = path.join(ROOT, 'js', name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'js/' + name + '.js' });
  }

  const TC = sandbox.TC;
  return {
    TC, ctx, storage, listeners,
    scriptOrderRun: names,
    startFrameLoop() {
      // run frames manually: step the captured rAF callback N times at 60fps dt
      let t = 0;
      for (let i = 0; i < (opts.frames || 1); i++) {
        if (typeof rafCallback !== 'function') break;
        t += 1000 / 60;
        const cb = rafCallback;
        rafCallback = null;
        cb(t);
      }
      return rafCallback; // non-null => loop wants to continue
    },
    getRaf: () => rafCallback
  };
}

module.exports = { loadGame, SCRIPT_ORDER, makeCanvas, makeStorage };

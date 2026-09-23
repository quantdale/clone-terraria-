'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

const METHODS = new Set([
  'measureText', 'createLinearGradient', 'createRadialGradient', 'createPattern',
  'getImageData', 'createImageData', 'putImageData', 'drawImage', 'fillRect',
  'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc',
  'ellipse', 'rect', 'fill', 'stroke', 'clip', 'save', 'restore', 'translate',
  'rotate', 'scale', 'setTransform', 'transform', 'setLineDash', 'fillText',
  'strokeText', 'quadraticCurveTo', 'bezierCurveTo', 'arcTo', 'roundRect',
]);
const STATE = new Set([
  'fillStyle', 'strokeStyle', 'globalAlpha', 'globalCompositeOperation',
]);

function countingContext(source) {
  const ops = [];
  const ctx = new Proxy(source, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || !METHODS.has(prop)) return value;
      return (...args) => {
        ops.push(prop);
        return value.apply(target, args);
      };
    },
    set(target, prop, value) {
      if (STATE.has(prop) && target[prop] !== value) ops.push('set:' + prop);
      target[prop] = value;
      return true;
    },
  });
  return { ctx, ops };
}

function statefulContext(source) {
  const stack = [];
  return new Proxy(source, {
    get(target, prop) {
      if (prop === 'save') {
        return () => stack.push({
          globalAlpha: target.globalAlpha,
          strokeStyle: target.strokeStyle,
          lineWidth: target.lineWidth,
        });
      }
      if (prop === 'restore') {
        return () => {
          const state = stack.pop();
          if (!state) return;
          for (const [key, value] of Object.entries(state)) target[key] = value;
        };
      }
      return Reflect.get(target, prop, target);
    },
  });
}

function drawSky(TC, ctx) {
  TC.Sky.draw(ctx, TC.camera, 1280, 720);
}

test('sky render stays within the W27 operation budget and preserves alpha state', () => {
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  TC.Runtime.reset();
  TC.Runtime.createWorld(4242);
  TC.camera.zoom = 2;

  const counted = countingContext(TC.canvas.getContext('2d'));
  TC.Sky.reset();
  drawSky(TC, counted.ctx);
  drawSky(TC, counted.ctx);
  counted.ops.length = 0;
  drawSky(TC, counted.ctx);
  const dayOps = counted.ops.length;
  assert.ok(dayOps <= 20, `day sky uses ${dayOps} operations`);

  TC.Sky.time = TC.CONST.DAY_LENGTH + TC.CONST.NIGHT_LENGTH * 0.5;
  drawSky(TC, counted.ctx);
  drawSky(TC, counted.ctx);
  counted.ops.length = 0;
  drawSky(TC, counted.ctx);
  const nightOps = counted.ops.length;
  assert.ok(nightOps <= 20, `night sky uses ${nightOps} operations`);

  counted.ctx.globalAlpha = 0.37;
  TC.Sky.reset();
  drawSky(TC, counted.ctx);
  assert.strictEqual(counted.ctx.globalAlpha, 0.37);
  TC.Sky.time = TC.CONST.DAY_LENGTH + TC.CONST.NIGHT_LENGTH * 0.5;
  drawSky(TC, counted.ctx);
  assert.strictEqual(counted.ctx.globalAlpha, 0.37);
});

test('sky no-document fallback preserves painted stroke state', () => {
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  TC.Runtime.reset();
  TC.Runtime.createWorld(4242);
  TC.camera.zoom = 2;
  const cycle = TC.CONST.DAY_LENGTH + TC.CONST.NIGHT_LENGTH;
  TC.Sky.time = cycle * 2 + TC.CONST.DAY_LENGTH + TC.CONST.NIGHT_LENGTH * 0.5;
  const ctx = statefulContext(TC.canvas.getContext('2d'));
  const document = g.ctx.document;
  ctx.strokeStyle = '#123456';
  ctx.lineWidth = 3;
  try {
    g.ctx.document = undefined;
    drawSky(TC, ctx);
    assert.strictEqual(ctx.strokeStyle, '#123456');
    assert.strictEqual(ctx.lineWidth, 3);
  } finally {
    g.ctx.document = document;
  }
});

/* tests/browser/helpers.js — shared real-browser harness utilities.
   Every journey boots the REAL game (actual index.html script order, actual
   Canvas, actual DOM, actual LocalStorage) and asserts zero console errors
   and zero uncaught page errors unless a test explicitly expects otherwise. */

const { expect } = require('@playwright/test');

// Collect console errors + uncaught exceptions for one page.
function trackErrors(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  return { consoleErrors, pageErrors };
}

function assertNoErrors(errors, label) {
  const errs = errors.consoleErrors.map((e) => '[console.error] ' + e)
    .concat(errors.pageErrors.map((e) => '[uncaught] ' + e));
  expect(errs, (label || 'browser') + ' must run without errors').toEqual([]);
}

// Boot the game page. `hash` may be '#test' to enable window.__TEST__ hooks.
async function openGame(page, hash) {
  const errors = trackErrors(page);
  await page.goto('/' + (hash || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.TC && window.TC.state === 'title'));
  return errors;
}

// Start a deterministic new world through the real service layer.
async function newWorld(page, seed, frames) {
  await page.evaluate(([s, f]) => {
    if (!window.__TEST__) throw new Error('window.__TEST__ missing — boot with #test');
    const r = window.__TEST__.newWorld(s == null ? undefined : s);
    if (!r || !r.ok) throw new Error('newWorld failed: ' + JSON.stringify(r));
    window.__frames = f || 30;
  }, [seed, frames]);
  await runFrames(page);
  await expectGameState(page, 'playing');
}

// Advance the real rAF loop by evaluating frame counts via the live loop.
// The main loop runs continuously in the browser; we simply wait until the
// requested number of animation frames has elapsed.
async function runFrames(page, n) {
  await page.evaluate((frames) => new Promise((resolve) => {
    let left = frames;
    (function tick() {
      if (left-- <= 0) return resolve();
      requestAnimationFrame(tick);
    })();
  }), n || 30);
}

async function gameState(page) {
  return page.evaluate(() => ({
    state: window.TC.state,
    seed: window.TC.worldSeed,
    hasWorld: !!window.TC.world,
    hasPlayer: !!window.TC.player,
    playerPos: window.TC.player ? { x: window.TC.player.x, y: window.TC.player.y } : null,
    hp: window.TC.player ? window.TC.player.hp : null,
    enemies: window.TC.Enemies ? window.TC.Enemies.list.length : -1,
    drops: window.TC.Items ? window.TC.Items.drops.length : -1,
    fps: window.TC.fps,
  }));
}

async function expectGameState(page, want) {
  const st = await gameState(page);
  expect(st.state).toBe(want);
  return st;
}

// Canvas render-path liveness: the Debug 'frame' sample ring grows over a
// real 400ms window (draw() executed repeatedly) AND the framebuffer holds
// varied (non-blank) content. Pixel-identity between adjacent frames is NOT
// required — a calm daytime scene can legitimately repeat.
async function canvasIsAnimating(page) {
  return page.evaluate(() => {
    function sample() {
      const c = document.getElementById('game');
      const ctx = c.getContext('2d');
      const seen = new Set();
      let samples = 0;
      for (let y = 4; y < c.height; y += 53) {
        for (let x = 4; x < c.width; x += 59) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          seen.add(d[0] + ',' + d[1] + ',' + d[2]);
          samples++;
        }
      }
      return { distinctColors: seen.size, samples: samples };
    }
    const t0 = window.TC.Debug ? window.TC.Debug.stats('frame').samples : -1;
    const pix0 = sample();
    return new Promise((resolve) => setTimeout(() => {
      const t1 = window.TC.Debug ? window.TC.Debug.stats('frame').samples : -1;
      const pix1 = sample();
      resolve({
        framesAdvanced: t1 === -1 ? null : (t1 - t0),
        distinctColors: Math.max(pix0.distinctColors, pix1.distinctColors),
        sampledPixels: pix1.samples,
      });
    }, 400));
  });
}

module.exports = {
  trackErrors, assertNoErrors, openGame, newWorld,
  runFrames, gameState, expectGameState, canvasIsAnimating,
};

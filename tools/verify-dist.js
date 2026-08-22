/* tools/verify-dist.js - production launch gate.
   Serves the assembled dist/ tree (DEV_ROOT override of tools/dev-server.js),
   boots the REAL built page in Chromium and validates the release path:

     - zero console/page errors on boot
     - title screen reached
     - New Game works (world + player + animated canvas)
     - Save & Quit -> Continue works on the production build
   Exit code 0 = releasable. */

'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.VERIFY_PORT || 8129);
const BASE = 'http://127.0.0.1:' + PORT;

function waitForServer(url, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get(url, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : retry();
      });
      req.on('error', retry);
      function retry() {
        if (Date.now() - t0 > timeoutMs) reject(new Error('dev-server timeout'));
        else setTimeout(ping, 150);
      }
    })();
  });
}

async function main() {
  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'tools', 'dev-server.js')],
    { env: { ...process.env, DEV_ROOT: DIST, PORT: String(PORT) }, stdio: 'ignore' }
  );
  try {
    await waitForServer(BASE + '/index.html', 10000);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push('[console] ' + m.text()));
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

    // ---- boot ----
    await page.goto(BASE + '/#test', { waitUntil: 'load' });
    await page.waitForFunction(() => window.TC && window.TC.state === 'title', null, { timeout: 20000 });

    // ---- new game through the real service layer ----
    await page.evaluate(() => {
      const r = window.__TEST__.newWorld(424242);
      if (!r || !r.ok) throw new Error('newGame failed: ' + JSON.stringify(r));
    });
    await page.waitForFunction(() => window.TC.state === 'playing');
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          let n = 45;
          (function tick() {
            if (--n <= 0) return resolve();
            requestAnimationFrame(tick);
          })();
        })
    );

    const live = await page.evaluate(() => {
      const c = document.getElementById('game');
      const ctx = c.getContext('2d');
      const seen = new Set();
      for (let y = 4; y < c.height; y += 61)
        for (let x = 4; x < c.width; x += 67) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          seen.add(d[0] + ',' + d[1] + ',' + d[2]);
        }
      return {
        world: !!window.TC.world,
        player: !!window.TC.player,
        distinctColors: seen.size,
      };
    });
    if (!live.world || !live.player) throw new Error('production new game incomplete: ' + JSON.stringify(live));
    if (live.distinctColors < 8) throw new Error('canvas looks blank: ' + JSON.stringify(live));

    // ---- save & quit -> Continue on the production build ----
    await page.evaluate(() => {
      if (!window.TC.Save.save()) throw new Error('save failed');
      window.TC.quitToTitle();
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.TC && window.TC.state === 'title');
    await page.evaluate((i) => {
      const w = window.innerWidth,
        h = window.innerHeight;
      const by = Math.max(h * 0.44, h / 2 - 100);
      window.__pt = { x: w / 2, y: by + i * (48 + 14) + 24 };
    }, 2); // 'Continue World'
    const pt = await page.evaluate(() => window.__pt);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForFunction(() => window.TC.state === 'playing', null, { timeout: 30000 });

    const continued = await page.evaluate(() => ({
      world: !!window.TC.world,
      player: !!window.TC.player,
      seed: window.TC.worldSeed,
    }));
    if (!continued.world || !continued.player || continued.seed !== 424242)
      throw new Error('production continue failed: ' + JSON.stringify(continued));

    if (errors.length) {
      console.error('VERIFY-DIST FAILED - browser errors:');
      for (const e of errors) console.error('  ' + e);
      process.exitCode = 1;
    } else {
      console.log(
        'verify-dist OK - production output boots, renders, new-game and continue work, zero browser errors'
      );
    }
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error('VERIFY-DIST FAILED:', e.message || e);
  process.exit(1);
});

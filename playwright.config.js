//@ts-check
/* playwright.config.js — real-browser validation gate.
   Serves the repository root (the actual game, actual index.html script
   order, actual Canvas/DOM/LocalStorage) via tools/dev-server.js and runs
   the journey specs in tests/browser/. Traces/screenshots/videos are kept
   on failure only and are git-ignored. */

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/browser',
  timeout: 90 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false,        // journeys share nothing, but keep ordering deterministic
  workers: 1,
  retries: 0,                  // a flaky pass is a defect signal, not a pass
  reporter: [['list']],
  outputDir: 'test-results/',
  use: {
    baseURL: 'http://127.0.0.1:8123',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node tools/dev-server.js',
    port: 8123,
    reuseExistingServer: false,
    timeout: 30 * 1000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});

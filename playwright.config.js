//@ts-check
/* playwright.config.js — real-browser validation gate.
   Serves the repository root (the actual game, actual index.html script
   order, actual Canvas/DOM/LocalStorage) via tools/dev-server.js and runs
   the journey specs in tests/browser/.

   DESKTOP ISOLATION POLICY (non-negotiable):
     - headless Chromium ONLY: no window is ever shown, the user's physical
       mouse/keyboard/focus are untouched (Playwright drives synthetic input
       inside its own browser process)
     - no persistent profile, no connectOverCDP, no kiosk/fullscreen: every
       run uses a fresh temporary browser context
     - traces + failure screenshots provide diagnostics; video stays off by
       default to keep overnight runs light */

const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests/browser",
  timeout: 90 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false, // journeys share nothing, but keep ordering deterministic
  workers: 1, // bounded resource use alongside the user's desktop workload
  retries: 0, // a flaky pass is a defect signal, not a pass
  reporter: [["list"]],
  outputDir: "test-results/",
  use: {
    baseURL: "http://127.0.0.1:8123",
    headless: true, // never launch headed during automated validation
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "node tools/dev-server.js",
    port: 8123,
    reuseExistingServer: false,
    timeout: 30 * 1000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

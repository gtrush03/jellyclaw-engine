/**
 * Phase 08 T3-03 — Playwright config for the web-TUI smoke.
 *
 * Deliberately minimal: one browser, no retries, screenshots captured on
 * failure. Snapshots live under `__screenshots__/` sibling to the specs.
 * The e2e suite is gated by `JELLYCLAW_WEB_TUI_E2E=1` at the spec level —
 * this config does not read that env so the config itself always parses.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    headless: true,
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
});

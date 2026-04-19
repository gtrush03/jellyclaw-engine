/**
 * Phase 08 T3-03 — web TUI E2E smoke.
 *
 * Gated by:
 *   JELLYCLAW_WEB_TUI_E2E=1 — opt-in (CI and unrelated test runs skip it).
 *   docker daemon reachable — helpers test `docker info`. Missing daemon
 *     emits a SKIP banner and no-ops the suite.
 *
 * Covers:
 *   - `/`     → landing page renders the jellyclaw wordmark.
 *   - `/tui/` → ttyd serves the xterm.js canvas within 10s.
 */

import { expect, test } from "@playwright/test";

import { buildImage, dockerAvailable, runContainer } from "./docker-helpers.js";

const TAG = "jellyclaw-web-tui-smoke";
const PORT = 4380 + Math.floor(Math.random() * 400);
const E2E_ENABLED = process.env.JELLYCLAW_WEB_TUI_E2E === "1";

test.describe("web TUI e2e", () => {
  test.skip(!E2E_ENABLED, "JELLYCLAW_WEB_TUI_E2E!=1 — smoke disabled by default");

  let teardown: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    if (!(await dockerAvailable())) {
      // Print a SKIP banner that the shell wrapper greps for.
      console.log("SKIP: T3-03 docker daemon not reachable — run `colima start` or Docker Desktop, then retry.");
      test.skip(true, "docker daemon not reachable");
      return;
    }
    await buildImage(TAG);
  });

  test.beforeEach(async () => {
    const handle = await runContainer(
      TAG,
      {
        JELLYCLAW_TOKEN: "e2e-smoke-token",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "sk-ant-e2e-placeholder",
        JELLYCLAW_TUI_AUTH: "optional", // no OTP gate for the smoke
      },
      PORT,
    );
    teardown = handle.stop;
  });

  test.afterEach(async () => {
    if (teardown !== null) {
      await teardown();
      teardown = null;
    }
  });

  test("landing page renders", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    // The hero h1 is an <img> wordmark — assert on its alt text + page title.
    await expect(page).toHaveTitle(/jellyclaw/i);
    const wordmark = page.locator("h1 img").first();
    await expect(wordmark).toHaveAttribute("alt", /jellyclaw/i);
    await expect(page).toHaveScreenshot("landing.png", { maxDiffPixelRatio: 0.05 });
  });

  test("tui renders xterm canvas", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/tui/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("canvas", { timeout: 10_000 });
    await expect(page).toHaveScreenshot("web-tui.png", { maxDiffPixelRatio: 0.1 });
  });
});

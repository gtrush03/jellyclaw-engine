/**
 * End-to-end smoke test.
 *
 * PRECONDITION: backend AND frontend both running. Start the full stack with:
 *
 *   cd dashboard && ./start.sh
 *
 * Then in another terminal:
 *
 *   cd dashboard && npm run test:e2e
 *
 * Playwright will launch a headless Chromium and walk the UI. If any step fails,
 * a trace.zip is written under `test-results/` for debugging.
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.JC_DASHBOARD_URL ?? 'http://127.0.0.1:5173';

test.describe('dashboard smoke', () => {
  test('loads sidebar with at least 20 phases, opens a prompt, copies it', async ({
    page,
    context,
  }) => {
    // Grant clipboard access so `navigator.clipboard.readText()` works in-page.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto(BASE, { waitUntil: 'networkidle' });

    // --- Sidebar: 20 phases ---------------------------------------------------
    // We don't assume a specific DOM structure — the polish agent may iterate.
    // Use role-based + text-based matchers with a generous wait.
    const phaseItems = page.locator('[data-phase], [data-testid^="phase-"]');
    await expect
      .poll(async () => await phaseItems.count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(20);

    // --- Pick the first prompt card and click it -----------------------------
    const promptCard = page
      .locator('[data-prompt], [data-testid^="prompt-"]')
      .first();
    await expect(promptCard).toBeVisible({ timeout: 15_000 });
    await promptCard.click();

    // --- Right pane: assembled prompt renders --------------------------------
    const detailPane = page.locator(
      '[data-testid="prompt-detail"], [data-pane="detail"]',
    );
    await expect(detailPane).toBeVisible({ timeout: 10_000 });
    // Markdown rendered → at least one heading element inside the pane.
    await expect(detailPane.locator('h1, h2, h3').first()).toBeVisible();

    // --- Copy button: clipboard captures the full assembled text -------------
    const copyButton = page.getByRole('button', { name: /copy/i }).first();
    await expect(copyButton).toBeVisible();
    await copyButton.click();

    // Give the clipboard write a tick.
    await page.waitForTimeout(200);

    const clip = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    });
    expect(clip.length).toBeGreaterThan(100);
    // The assembled prompt starts with the STARTUP template which (per
    // repo convention) begins with a `# Phase` heading after substitution.
    expect(clip).toMatch(/#\s*Phase\s+\d{2}/);
  });

  test('header shows a LIVE indicator once SSE is connected', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const live = page.getByText(/live/i).first();
    await expect(live).toBeVisible({ timeout: 10_000 });
  });
});

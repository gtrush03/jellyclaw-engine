import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the dashboard E2E suite.
 *
 * The backend + frontend are NOT started by Playwright — run `./start.sh`
 * in another terminal first. We deliberately don't use Playwright's `webServer`
 * config because the launcher script is the source of truth for how the
 * stack starts (proxy wiring, PID file, OS-specific browser open).
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.JC_DASHBOARD_URL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

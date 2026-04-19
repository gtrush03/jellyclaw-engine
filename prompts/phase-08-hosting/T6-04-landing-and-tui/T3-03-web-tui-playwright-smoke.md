---
id: T3-03-web-tui-playwright-smoke
tier: 3
title: "Playwright E2E smoke against ephemeral container"
scope:
  - engine/test/e2e/web-tui.spec.ts
  - engine/test/e2e/docker-helpers.ts
  - package.json
depends_on_fix:
  - T3-02-container-entrypoint-supervisor
tests:
  - name: docker-build
    kind: shell
    description: "docker build succeeds"
    command: "docker build -t jellyclaw-web-tui-smoke . 2>&1 | tail -20"
    expect_exit: 0
    timeout_sec: 600
  - name: e2e-smoke
    kind: shell
    description: "Playwright smoke: / shows landing, /tui shows xterm canvas"
    command: "JELLYCLAW_WEB_TUI_E2E=1 bun run test:e2e:web-tui"
    expect_exit: 0
    timeout_sec: 300
human_gate: false
max_turns: 40
max_cost_usd: 12
max_retries: 2
estimated_duration_min: 30
---

# T3-03 — Web TUI Playwright smoke

## Context
T3-01 + T3-02 produced a buildable container. This prompt adds an E2E
Playwright test that:
1. Builds the image fresh (or re-uses a cached tag).
2. Runs it on an ephemeral port with `JELLYCLAW_TOKEN` + `ANTHROPIC_API_KEY`.
3. Hits `/` → landing HTML renders, wordmark visible.
4. Hits `/tui` → xterm canvas appears; basic interaction smoke (type `help`
   Enter, see a response within 10s).
5. Screenshot both; commit to `engine/test/e2e/__screenshots__/`.
6. Tear down cleanly.

## Work

### 1. `engine/test/e2e/docker-helpers.ts`
Helpers:
- `buildImage(tag: string): Promise<void>` — spawns `docker build -t <tag> .`
  with stdio inherited; rejects on non-zero.
- `runContainer(tag, env, port): Promise<{id: string, url: string, stop: () => Promise<void>}>`
  — spawns `docker run -d -p <port>:80 -e ... <tag>`; polls
  `curl <url>/v1/health` until ready (60s budget); returns the container id
  and a teardown fn.
- `stopContainer(id)` — `docker kill` + `docker rm -f`.

### 2. `engine/test/e2e/web-tui.spec.ts`
```ts
import { test, expect } from '@playwright/test';
import { buildImage, runContainer } from './docker-helpers';

const TAG = 'jellyclaw-web-tui-smoke';
const PORT = 4380 + Math.floor(Math.random() * 400);

test.describe('web TUI e2e', () => {
  test.beforeAll(async () => { await buildImage(TAG); });

  let teardown: () => Promise<void>;
  test.beforeEach(async () => {
    const r = await runContainer(TAG, {
      JELLYCLAW_TOKEN: 'e2e-smoke-token',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
      JELLYCLAW_TUI_AUTH: 'optional', // no OTP for smoke
    }, PORT);
    teardown = r.stop;
  });
  test.afterEach(async () => { await teardown(); });

  test('landing page renders', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await expect(page.locator('h1')).toContainText(/jellyclaw/i);
    await expect(page).toHaveScreenshot('landing.png', { maxDiffPixelRatio: 0.05 });
  });

  test('tui renders xterm canvas', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/tui/`);
    await page.waitForSelector('canvas', { timeout: 10_000 });
    await expect(page).toHaveScreenshot('web-tui.png', { maxDiffPixelRatio: 0.10 });
  });
});
```

### 3. `package.json`
Add:
```json
"test:e2e:web-tui": "playwright test engine/test/e2e/web-tui.spec.ts --config=engine/test/e2e/playwright.config.ts"
```
Gate by `JELLYCLAW_WEB_TUI_E2E=1` so CI doesn't run it without docker.

### 4. Playwright config (minimal)
`engine/test/e2e/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  retries: 0,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
});
```

### 5. Bail fast if docker daemon missing
Before running the test, check `docker info` — if it fails:
```
SKIP: T3-03 docker daemon not reachable — run `colima start` or Docker Desktop, then retry.
```
This is a deferred-completion: emit a `SKIP:` line instead of `FAIL:` — the
orchestrator will still advance (check run.sh — if SKIP isn't supported,
emit `FAIL:` with that reason and document manually).

## Acceptance criteria
- With docker running + real ANTHROPIC_API_KEY set, both Playwright tests pass.
- Without docker, test is skipped cleanly (exit 0 with SKIP message).
- Screenshots committed to `engine/test/e2e/__screenshots__/`.

## Out of scope
- CI wiring for this E2E — too hardware-dependent for GH actions.
- Load testing the ttyd connection — future tier.

## Verification the worker should self-run before finishing
```bash
docker info > /dev/null 2>&1 && {
  docker build -t jellyclaw-web-tui-smoke .
  JELLYCLAW_WEB_TUI_E2E=1 bun run test:e2e:web-tui
} || echo "docker not available — SKIP"
echo "DONE: T3-03-web-tui-playwright-smoke"
```

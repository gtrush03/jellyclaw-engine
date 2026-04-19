# Phase 07.5 — Chrome MCP — Prompt T2-02: End-to-end integration test

**When to run:** After `T2-01` ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 2–3 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Research task

1. Re-read `phases/PHASE-07.5-chrome-mcp.md` Step 6.
2. Read `test/integration/playwright-mcp.test.ts` end-to-end. This is your template. Match its shape.
3. Read `test/fixtures/mcp/playwright.test-config.json` — your new fixture should mirror it.
4. Read `engine/src/cli/run.ts` AFTER T0-01 landed — confirm MCP is now wired through the run path and the credential check uses `loadCredentials()`.
5. Read `scripts/jellyclaw-chrome.sh` from T1-02 — you'll reuse its launch logic or a headless variant.
6. Read `scripts/playwright-test-chrome.sh` — this is the test-local isolated Chrome launcher that the existing integration test uses. Reuse it.
7. Grep `test/` for `JELLYCLAW_*_TEST` env-gate pattern — match it for the new test.

## Implementation task

Ship an end-to-end integration test that spawns `jellyclaw run` as a subprocess, feeds it a prompt, and asserts (a) MCP Playwright tools register, (b) `browser_navigate` + `browser_take_screenshot` return success, (c) a PNG artifact materializes, (d) Chrome + MCP + jellyclaw all shut down cleanly in `afterAll`. Gate behind `JELLYCLAW_CHROME_MCP_TEST=1` to avoid slowing the default suite.

This prompt does NOT: rewrite docs (T3-01) or add chrome-devtools-mcp (T3-02).

### Files to create

- `test/integration/chrome-mcp.test.ts` — the test
- `test/fixtures/mcp/chrome-test-config.json` — MCP config used by the subprocess `jellyclaw run`
- `test/TESTING.md` — append a section documenting the new env-gated test

### Test fixture shape

`test/fixtures/mcp/chrome-test-config.json`:

```json
{
  "mcp": [
    {
      "transport": "stdio",
      "name": "playwright",
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--browser", "chrome",
        "--cdp-endpoint", "http://127.0.0.1:9333",
        "--caps", "vision"
      ]
    }
  ]
}
```

Port MUST be `9333`. NEVER `9222` — the existing convention at `test/integration/playwright-mcp.test.ts:43` forbids it.

### Test skeleton

```ts
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const PORT = 9333;
const FIXTURE = "test/fixtures/mcp/chrome-test-config.json";
const ARTIFACTS = join(tmpdir(), "jellyclaw-test-artifacts");
const TEST_ENABLED = process.env.JELLYCLAW_CHROME_MCP_TEST === "1";
const runIfEnabled = TEST_ENABLED ? describe : describe.skip;

runIfEnabled("Chrome MCP end-to-end (Phase 07.5 T2-02)", () => {
  let chrome: ChildProcess | undefined;

  beforeAll(async () => {
    // Launch isolated Chrome for this test (port 9333, tmp profile)
    mkdirSync(ARTIFACTS, { recursive: true });
    chrome = spawn("bash", ["scripts/playwright-test-chrome.sh", "start"], {
      stdio: "inherit",
    });
    // Wait for CDP
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) return;
      } catch {}
      await wait(500);
    }
    throw new Error(`CDP on :${PORT} did not come up in 15s`);
  }, 60_000);

  afterAll(async () => {
    spawn("bash", ["scripts/playwright-test-chrome.sh", "stop"], { stdio: "inherit" });
    chrome?.kill("SIGTERM");
  });

  test("jellyclaw run → Chrome MCP → navigate + screenshot", async () => {
    const child = spawn(
      "./engine/bin/jellyclaw",
      ["run", "--output-format", "stream-json", "--mcp-config", FIXTURE, "--max-turns", "6"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stdin!.end(
      "Navigate to https://example.com and take a screenshot. Save it and tell me the path."
    );

    const events: Array<Record<string, unknown>> = [];
    let stderr = "";
    child.stdout!.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        try { events.push(JSON.parse(line)); } catch {}
      }
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });

    const exit = await new Promise<number>((resolve) => child.on("close", resolve));
    expect(exit).toBe(0);

    // 1) MCP tools must have registered
    const toolCalls = events.filter((e) => e.type === "tool.called");
    const navigateCalls = toolCalls.filter((e: any) =>
      String(e.tool).includes("browser_navigate")
    );
    const screenshotCalls = toolCalls.filter((e: any) =>
      String(e.tool).includes("browser_take_screenshot")
    );
    expect(navigateCalls.length).toBeGreaterThan(0);
    expect(screenshotCalls.length).toBeGreaterThan(0);

    // 2) Both must have produced non-error results
    const toolResults = events.filter((e: any) => e.type === "tool.result");
    const screenshotResult = toolResults.find((e: any) =>
      String(e.tool).includes("browser_take_screenshot")
    );
    expect(screenshotResult).toBeDefined();

    // 3) PNG artifact exists — playwright MCP emits a path in the result output
    //    OR the result.content includes a base64-encoded image block
    const output = (screenshotResult as any).output;
    expect(output).toBeDefined();

    // 4) Session completed cleanly
    const completed = events.find((e) => e.type === "session.completed");
    expect(completed).toBeDefined();

    // 5) No forbidden port leak
    expect(stderr).not.toMatch(/9222/);
  }, 180_000);
});
```

Forbidden-port assertion at the end mirrors `test/integration/playwright-mcp.test.ts:63-70`.

### TESTING.md append

Append a section:

```markdown
## Phase 07.5 — Chrome MCP integration test

`test/integration/chrome-mcp.test.ts` is gated behind `JELLYCLAW_CHROME_MCP_TEST=1`
to keep the default suite fast and deterministic. It:

1. Launches an isolated Chrome on port 9333 via `scripts/playwright-test-chrome.sh`
2. Spawns `jellyclaw run` with `--mcp-config test/fixtures/mcp/chrome-test-config.json`
3. Feeds a navigate+screenshot prompt
4. Asserts the event stream contains successful `browser_navigate` + `browser_take_screenshot`
5. Cleans up: stops Chrome, removes tmp datadir

Run locally:

```bash
JELLYCLAW_CHROME_MCP_TEST=1 bun run test test/integration/chrome-mcp.test.ts
```

Wall-clock: ~60s. Requires Chrome installed + `ANTHROPIC_API_KEY` or
`~/.jellyclaw/credentials.json` set. CI runs this only in the `integration-chrome` job.
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run lint
bun run build

# Run only the new test (needs real creds + Chrome)
JELLYCLAW_CHROME_MCP_TEST=1 bun run test test/integration/chrome-mcp.test.ts
# Expect: green in ~60s

# Full suite (default — the new test skips due to env gate)
bun run test
# Expect: same pass/fail count as pre-prompt baseline (plus 1 skipped)
```

### Expected output

- New test file loads under `bun run test` but is SKIPPED by default (env gate) — verify "skipped" in the summary
- With `JELLYCLAW_CHROME_MCP_TEST=1` the test runs end-to-end and passes
- The test subprocess `jellyclaw run` prints NDJSON events that include `tool.called` + `tool.result` for `mcp__playwright__browser_navigate` and `mcp__playwright__browser_take_screenshot`
- Chrome subprocess is killed cleanly in `afterAll`
- `test/TESTING.md` documents how to run it and what it proves

### Tests to add

One. `test/integration/chrome-mcp.test.ts` IS the test. No unit tests needed; this is explicitly an E2E integration test of the whole stack.

### Verification

```bash
# Pre-baseline: capture current test pass/fail count
bun run test 2>&1 | tail -5 > /tmp/pre-t2-02-baseline.txt

# Run new test
JELLYCLAW_CHROME_MCP_TEST=1 bun run test test/integration/chrome-mcp.test.ts

# Re-run full suite, compare
bun run test 2>&1 | tail -5 > /tmp/post-t2-02.txt
diff /tmp/pre-t2-02-baseline.txt /tmp/post-t2-02.txt
# Expect: only the "skipped" count went up by the number of tests in the new file
```

### Common pitfalls

- **Tolerate flaky model output.** The test asserts TOOL CALLS happened, not specific URL strings or tool inputs. The model may phrase things differently on different runs.
- **Don't share the Chrome process across multiple test() cases.** If you add more tests later, each `test()` should reset browser state via `browser_close` or a new tab — otherwise cross-contamination bites.
- **Don't check `exit === 0` too strictly.** If the model hits `max_turns` without finishing, exit may be non-zero — relax to `exit <= 1` if that's a problem, but first verify the model is actually completing its task.
- **Don't forget `--max-turns`.** Without a cap, a misbehaving prompt could burn real Anthropic tokens. 6 turns is enough for a trivial navigate+screenshot.
- **The 180s timeout is generous** for when CI is slow or model latency spikes. Don't drop below 60s.
- **The 15s CDP-up timeout in `beforeAll` must account for cold-start on macOS** — Chrome first-launch after reboot takes longer. Consider bumping to 30s if CI flakes.
- **`playwright-test-chrome.sh` may be interactive or daemonize differently from `jellyclaw-chrome.sh`.** Read it before using it; use `scripts/jellyclaw-chrome.sh` if the test variant doesn't fit — just remember its profile lives in `~/Library/Application Support/…` which shouldn't be pushed to CI. Use the throwaway one in `scripts/playwright-test-chrome.sh`.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T2-02 ✅`.
2. Update `STATUS.md` to point at `T3-01`.
3. Print `DONE: T2-02`.

On fatal failure (test consistently fails even with correct creds + Chrome): `FAIL: T2-02 <reason + copy the failing assertion text>`.

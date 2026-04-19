# Phase 07.5 Fix — Prompt T4-03: End-to-end Chrome demo regression test

**When to run:** After T4-02 ✅.
**Estimated duration:** 1 hour
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

T4-01 + T4-02 together should make this flow work end-to-end without any manual intervention:

```bash
# Cold start — Chrome may or may not be running; doesn't matter
echo "navigate to example.com and take a screenshot" | jellyclaw run ...
# Session ends, ~/.jellyclaw/sessions/<id>/screenshots/final-00-*.png exists
```

This prompt ships a regression test that proves it, gated on `JELLYCLAW_CHROME_DEMO_TEST=1`. The test kills any existing Chrome, runs a jellyclaw session from scratch (forcing auto-launch), then asserts a valid PNG artifact materialized.

## Research task

1. Read `test/integration/chrome-mcp.test.ts` from T2-02 for the shape of an env-gated integration test.
2. Read `scripts/jellyclaw-chrome.sh` and `scripts/jellyclaw-chrome-stop.sh` so you know how to reset state.
3. Read T4-01's `chrome-autolaunch.ts` — confirm the pre-hook fires correctly.
4. Read T4-02's `session-screenshot.ts` — confirm screenshots land at `~/.jellyclaw/sessions/<id>/screenshots/`.

## Implementation task

### Files to create / modify

- `test/integration/chrome-demo-e2e.test.ts` — **new.** Env-gated `JELLYCLAW_CHROME_DEMO_TEST=1`.
- `test/TESTING.md` — append section documenting how to run it.

### Test skeleton

```ts
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TEST_ENABLED = process.env.JELLYCLAW_CHROME_DEMO_TEST === "1";
const runIfEnabled = TEST_ENABLED ? describe : describe.skip;

runIfEnabled("Chrome demo end-to-end (T4-03)", () => {
  beforeAll(() => {
    // Ensure we start from no-Chrome state so autolaunch fires
    spawnSync("bash", ["scripts/jellyclaw-chrome-stop.sh"], { stdio: "inherit" });
    // Write minimal config
    const configPath = "/tmp/jellyclaw-demo-test-config.json";
    require("node:fs").writeFileSync(
      configPath,
      JSON.stringify({
        provider: { type: "anthropic" },
        mcp: [{
          transport: "stdio",
          name: "playwright",
          command: "npx",
          args: ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--cdp-endpoint", "http://127.0.0.1:9333"],
        }],
      }, null, 2),
    );
    process.env.JELLYCLAW_DEMO_CONFIG = configPath;
  });

  afterAll(() => {
    spawnSync("bash", ["scripts/jellyclaw-chrome-stop.sh"], { stdio: "inherit" });
  });

  test("cold start: autolaunches Chrome, navigates, screenshots land", async () => {
    const child = spawn(
      "./engine/bin/jellyclaw",
      [
        "run",
        "--output-format", "stream-json",
        "--permission-mode", "bypassPermissions",
        "--mcp-config", process.env.JELLYCLAW_DEMO_CONFIG!,
        "--max-turns", "6",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin!.end(
      "use mcp__playwright__browser_navigate to go to https://example.com, then browser_snapshot. stop after that.",
    );

    const events: Array<Record<string, unknown>> = [];
    let stderr = "";
    child.stdout!.on("data", (buf) => {
      for (const line of buf.toString().split("\n").filter(Boolean)) {
        try { events.push(JSON.parse(line)); } catch {}
      }
    });
    child.stderr!.on("data", (buf) => { stderr += buf.toString(); });

    const exit = await new Promise<number>((resolve) => child.on("close", resolve));
    expect(exit).toBe(0);

    // 1. MCP started
    expect(stderr).toContain("mcp: started 1 server(s)");
    // 2. Chrome was auto-launched
    expect(stderr).toMatch(/chrome:.*auto-launching|chrome: ready/);
    // 3. browser_navigate succeeded
    const navCall = events.find((e: any) =>
      e.type === "tool.called" && String(e.tool_name).includes("browser_navigate")
    );
    expect(navCall).toBeDefined();
    const navResult = events.find((e: any) =>
      e.type === "tool.result" && String(e.tool_name).includes("browser_navigate")
    );
    expect(navResult).toBeDefined();
    // 4. session.completed has final_screenshots with at least 1 entry
    const completed = events.find((e: any) => e.type === "session.completed") as any;
    expect(completed).toBeDefined();
    expect(completed.final_screenshots).toBeDefined();
    expect(Array.isArray(completed.final_screenshots)).toBe(true);
    expect(completed.final_screenshots.length).toBeGreaterThan(0);
    // 5. The first screenshot file exists, is > 2KB, and starts with PNG magic bytes
    const firstPath = completed.final_screenshots[0];
    expect(existsSync(firstPath)).toBe(true);
    expect(statSync(firstPath).size).toBeGreaterThan(2048);
    const header = readFileSync(firstPath).subarray(0, 8);
    expect(header.toString("hex")).toBe("89504e470d0a1a0a"); // PNG magic
  }, 180_000);

  test("warm start: Chrome already up, no re-launch", async () => {
    // First call leaves Chrome running
    // Second call: autolaunch should see CDP up + >=1 tab and skip spawn
    const child = spawn(
      "./engine/bin/jellyclaw",
      ["run", "--output-format", "stream-json", "--permission-mode", "bypassPermissions",
       "--mcp-config", process.env.JELLYCLAW_DEMO_CONFIG!, "--max-turns", "3"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin!.end("use mcp__playwright__browser_navigate to go to https://example.org. done.");
    let stderr = "";
    child.stderr!.on("data", (buf) => { stderr += buf.toString(); });
    const exit = await new Promise<number>((resolve) => child.on("close", resolve));
    expect(exit).toBe(0);
    // Should see "ready" but NOT "auto-launching"
    expect(stderr).toContain("chrome: ready on :9333");
    expect(stderr).not.toContain("auto-launching");
  }, 120_000);
});
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run build

# Run the new test
JELLYCLAW_CHROME_DEMO_TEST=1 bun run test test/integration/chrome-demo-e2e.test.ts
# Expect: 2/2 passing in ~3 minutes
```

### Expected output

- Test runs 2 cases (cold start + warm start)
- Cold start: Chrome launched by jellyclaw, screenshot PNG produced, PNG magic verified
- Warm start: no re-launch, session still produces screenshot
- `test/TESTING.md` documents the env gate

### Common pitfalls

- **`--mcp-config` arg must be absolute** (we write to /tmp/). Use `path.resolve()` if needed.
- **`afterAll` must kill Chrome** to leave the machine in a clean state for subsequent suites.
- **180s is generous for cold start** (Chrome boot ~2s + npx fetch ~30s first time + real web page ~5s + teardown screenshot ~2s). Don't tighten.
- **Don't assert on specific tool names beyond the `browser_navigate` substring match.** The model may also call snapshot or screenshot — that's fine.
- **Don't require `_disabled` absent** in the template — the test fixture we write is minimal.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T4-03 ✅` AND `Phase 07.5 fix chain COMPLETE ✓`.
2. Print `DONE: T4-03`.

On fatal failure: `FAIL: T4-03 <reason>`.

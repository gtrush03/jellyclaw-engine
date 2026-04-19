import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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
    let stdout = "";
    child.stdout!.on("data", (buf) => { stdout += buf.toString(); });
    child.stderr!.on("data", (buf) => { stderr += buf.toString(); });

    // Wait for both stdout to end and process to close
    await new Promise<void>((resolve) => child.stdout!.on("end", resolve));
    const exit = await new Promise<number>((resolve) => child.on("close", resolve));

    // Parse events after stdout is fully collected
    for (const line of stdout.split("\n").filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch {}
    }

    expect(exit).toBe(0);

    // Debug: always show stderr and completed event
    console.log("=== STDERR ===");
    console.log(stderr);
    console.log("=== COMPLETED EVENT ===");
    const c = events.find((e: any) => e.type === "session.completed");
    console.log(JSON.stringify(c, null, 2));

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

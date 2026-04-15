/**
 * Phase 10.01 — end-to-end smoke test.
 *
 * Spawns the built CLI as a child process and verifies:
 *   1. `jellyclaw run "hello"` exits 0
 *   2. At least one AgentEvent is printed on stdout
 *   3. The Phase-0 stub completes with session.completed
 *
 * Relies on `bun run build` having produced `dist/cli/main.js`.
 */

import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(new URL("../../..", import.meta.url).pathname);
const CLI_JS = resolve(REPO_ROOT, "dist/cli/main.js");

function cliExists(): boolean {
  try {
    accessSync(CLI_JS);
    return true;
  } catch {
    return false;
  }
}

interface SpawnResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnCli(args: readonly string[], stdin?: string): Promise<SpawnResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("node", [CLI_JS, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

describe("run-smoke: spawned CLI subprocess", () => {
  it.skipIf(!cliExists())('`jellyclaw run "hello world"` exits 0 and emits events', async () => {
    const r = await spawnCli(["run", "hello world", "--output-format", "stream-json"]);
    expect(r.code, `stderr:\n${r.stderr}`).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain("session.completed");
  });

  it.skipIf(!cliExists())("`echo hi | jellyclaw run` reads stdin", async () => {
    const r = await spawnCli(["run", "--output-format", "stream-json"], "hi there\n");
    expect(r.code, `stderr:\n${r.stderr}`).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const start = parsed.find((p) => p.type === "session.started");
    expect(start).toBeDefined();
    expect(String(start?.wish ?? "")).toContain("hi there");
  });

  it.skipIf(!cliExists())("`jellyclaw --help` exits 0", async () => {
    const r = await spawnCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/run/);
    expect(r.stdout).toMatch(/doctor/);
  });

  it.skipIf(!cliExists())("`jellyclaw --version` prints 0.0.1", async () => {
    const r = await spawnCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("0.0.1");
  });
});

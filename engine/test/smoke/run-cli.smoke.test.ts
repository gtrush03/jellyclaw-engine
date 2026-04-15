/**
 * Phase 99.03 live smoke — end-to-end against real Anthropic.
 *
 * Gated behind `RUN_LIVE=1` so it never fires in default CI. Run manually:
 *
 *   ANTHROPIC_API_KEY=... RUN_LIVE=1 bun test engine/test/smoke/run-cli.smoke.test.ts
 *
 * Verifies that `jellyclaw run --output-format json` returns a full transcript
 * envelope including a usage block and a session.completed turn count.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const live = process.env.RUN_LIVE === "1" && typeof process.env.ANTHROPIC_API_KEY === "string";

const cliPath = path.resolve(process.cwd(), "engine/dist/cli/main.js");

describe.skipIf(!live)("jellyclaw run — live smoke", () => {
  it("returns a json transcript with a pong message and non-zero output tokens", () => {
    const r = spawnSync(
      "node",
      [cliPath, "run", "say the single word: pong", "--output-format", "json"],
      {
        env: { ...process.env },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(r.stdout) as {
      transcript: Array<{ type: string; delta?: string; turns?: number }>;
      usage: { output_tokens: number; input_tokens: number };
    };
    expect(parsed.transcript.some((e) => e.type === "session.started")).toBe(true);
    expect(parsed.transcript.some((e) => e.type === "session.completed")).toBe(true);
    const joined = parsed.transcript
      .filter((e) => e.type === "agent.message")
      .map((e) => e.delta ?? "")
      .join("")
      .toLowerCase();
    expect(joined).toContain("pong");
    expect(parsed.usage.output_tokens).toBeGreaterThan(0);
    expect(parsed.usage.input_tokens).toBeGreaterThan(0);
  }, 60_000);

  it("--output-format stream-json emits pure NDJSON on stdout (no pino leakage)", () => {
    const r = spawnSync("node", [cliPath, "run", "say pong", "--output-format", "stream-json"], {
      env: { ...process.env },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Will throw if any line isn't valid JSON.
      JSON.parse(line);
    }
  }, 60_000);
});

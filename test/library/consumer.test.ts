/**
 * Phase 10.03 — consumer-workspace smoke.
 *
 * Spawns `bun run main.ts` inside `test/library/consumer/` against the
 * built `@jellyclaw/engine` (from `engine/dist/`). Verifies that:
 *
 *   - The package's `exports` map resolves `@jellyclaw/engine` to a real
 *     compiled JS entry.
 *   - `createEngine({})` + `engine.run(...)` + `engine.dispose()` compose
 *     without dev-time aliases.
 *   - The process exits 0 and stdout contains `"consumer OK"`.
 *
 * Two gates, both required:
 *
 *   1. `JELLYCLAW_LIB_CONSUMER_TEST=1` — opt-in, mirrors
 *      `JELLYCLAW_HTTP_E2E` and `BENCH` patterns. Default runs skip this
 *      suite entirely.
 *   2. `engine/dist/index.js` must exist. If the dist build hasn't run
 *      yet, the suite self-skips with a clear message rather than
 *      false-failing.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const GATE = process.env.JELLYCLAW_LIB_CONSUMER_TEST === "1";
const DIST_ENTRY = resolve(__dirname, "../../engine/dist/index.js");
const HAS_DIST = existsSync(DIST_ENTRY);
const CONSUMER_DIR = resolve(__dirname, "./consumer");

const describeMaybe = GATE && HAS_DIST ? describe : describe.skip;

if (!GATE) {
  console.info(
    "[consumer.test] skipped — set JELLYCLAW_LIB_CONSUMER_TEST=1 to run the consumer-workspace smoke",
  );
} else if (!HAS_DIST) {
  console.info(
    `[consumer.test] skipped — built engine not found at ${DIST_ENTRY}. Run \`bun run build\` first.`,
  );
}

interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnConsumer(): Promise<SpawnResult> {
  return new Promise((resolveFn, rejectFn) => {
    const proc = spawn("bun", ["run", "main.ts"], {
      cwd: CONSUMER_DIR,
      env: {
        ...process.env,
        // Documented protocol — see consumer/main.ts header comment.
        JELLYCLAW_HTTP_E2E: "0",
        JELLYCLAW_CONSUMER_MOCK_PROVIDER: "1",
        JELLYCLAW_LOG_LEVEL: "silent",
        // Never require a real API key for the smoke.
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "missing",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    proc.once("error", rejectFn);
    proc.once("exit", (code, signal) => {
      resolveFn({ code, signal, stdout, stderr });
    });

    // Safety: hard-kill after 30s.
    const killer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 30_000);
    killer.unref();
  });
}

describeMaybe("library consumer smoke", () => {
  it("bun run main.ts exits 0 with 'consumer OK' on stdout", async () => {
    const result = await spawnConsumer();
    if (result.code !== 0) {
      console.error("[consumer.test] consumer stderr:\n", result.stderr);
      console.error("[consumer.test] consumer stdout:\n", result.stdout);
    }
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("consumer OK");
  }, 35_000);
});

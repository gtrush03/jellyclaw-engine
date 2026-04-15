/**
 * Grep performance bench (gated by BENCH=1).
 *
 * Generates a 100k-file fixture once (cached on disk) and asserts the Grep
 * tool can scan it for `NEEDLE_TOKEN` in well under 3 seconds.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "../../engine/src/logger.js";
import { grepTool } from "../../engine/src/tools/grep.js";
import { allowAll } from "../../engine/src/tools/permissions.js";
import type { ToolContext } from "../../engine/src/tools/types.js";

const BENCH_ROOT = "/tmp/jellyclaw-grep-bench";
const NUM_DIRS = 1_000;
const FILES_PER_DIR = 100;
const NEEDLE_FILE_PROB = 0.01; // ~1000 files contain NEEDLE_TOKEN

const enabled = process.env.BENCH === "1";

function pseudoRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0xffff_ffff;
  };
}

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: "bench",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: allowAll,
  };
}

(enabled ? describe : describe.skip)("grepTool perf", () => {
  beforeAll(() => {
    if (existsSync(BENCH_ROOT)) return;
    mkdirSync(BENCH_ROOT, { recursive: true });
    const rand = pseudoRandom(42);
    const filler = "abcdefghijklmnopqrstuvwxyz0123456789 ".repeat(8);
    for (let d = 0; d < NUM_DIRS; d++) {
      const dir = join(BENCH_ROOT, `d${d}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < FILES_PER_DIR; f++) {
        const len = 100 + Math.floor(rand() * 200);
        let body = filler.slice(0, len);
        if (rand() < NEEDLE_FILE_PROB) {
          body = `${body}\nNEEDLE_TOKEN line ${f}\n`;
        }
        writeFileSync(join(dir, `f${f}.txt`), body, "utf8");
      }
    }
  }, 600_000);

  it("scans 100k files for NEEDLE_TOKEN under 3 seconds", async () => {
    const ctx = makeCtx(BENCH_ROOT);
    const start = performance.now();
    const out = await grepTool.handler(
      { pattern: "NEEDLE_TOKEN", output_mode: "files_with_matches" },
      ctx,
    );
    const elapsed = performance.now() - start;
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    console.log(`grep bench: matched ${out.files.length} files in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(3_000);
    expect(out.files.length).toBeGreaterThan(0);
  }, 60_000);
});

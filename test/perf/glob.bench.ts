/**
 * Performance bench for the Glob tool.
 *
 * Gated behind `BENCH=1`. The bench corpus is generated once at
 * `/tmp/jellyclaw-glob-bench/` and reused across runs (cheap to rebuild — just
 * delete the dir).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, it } from "vitest";

import { createLogger } from "../../engine/src/logger.js";
import { globTool } from "../../engine/src/tools/glob.js";
import { allowAll } from "../../engine/src/tools/permissions.js";
import type { ToolContext } from "../../engine/src/tools/types.js";

const BENCH_ROOT = join(tmpdir(), "jellyclaw-glob-bench");
const SUBDIRS = 100;
const FILES_PER_DIR = 100;
const TOTAL = SUBDIRS * FILES_PER_DIR;
const MD_COUNT = 100;
const BUDGET_MS = 500;

function ctx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: "bench",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: allowAll,
  };
}

function generateCorpus(): void {
  if (existsSync(BENCH_ROOT)) return;
  mkdirSync(BENCH_ROOT, { recursive: true });

  // Pick MD_COUNT distinct file indices in [0, TOTAL) to mark as `.md`.
  const mdIndices = new Set<number>();
  while (mdIndices.size < MD_COUNT) {
    mdIndices.add(Math.floor(Math.random() * TOTAL));
  }

  for (let d = 0; d < SUBDIRS; d++) {
    const dir = join(BENCH_ROOT, `dir-${d.toString().padStart(3, "0")}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_DIR; f++) {
      const flatIdx = d * FILES_PER_DIR + f;
      const ext = mdIndices.has(flatIdx) ? "md" : "txt";
      writeFileSync(join(dir, `f-${f.toString().padStart(3, "0")}.${ext}`), "x");
    }
  }
}

const enabled = process.env.BENCH === "1";

describe.skipIf(!enabled)("globTool perf", () => {
  beforeAll(() => {
    generateCorpus();
  }, 120_000);

  it(`globs **/*.md across ${TOTAL} files in <${BUDGET_MS}ms`, async () => {
    const c = ctx(BENCH_ROOT);
    const start = performance.now();
    const out = await globTool.handler({ pattern: "**/*.md" }, c);
    const elapsed = performance.now() - start;

    console.log(`glob bench: matched ${out.files.length} files in ${elapsed.toFixed(2)}ms`);

    if (out.files.length !== MD_COUNT) {
      throw new Error(`expected ${MD_COUNT} md files, got ${out.files.length}`);
    }
    if (elapsed >= BUDGET_MS) {
      throw new Error(`glob exceeded budget: ${elapsed.toFixed(2)}ms >= ${BUDGET_MS}ms`);
    }
  }, 30_000);
});

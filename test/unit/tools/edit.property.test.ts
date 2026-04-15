/**
 * Property-based tests for the Edit tool.
 *
 * These exercise two invariants across 100 random runs each:
 *   1. A unique-marker replacement produces exactly `prefix + new + suffix`.
 *   2. K repetitions of a marker yield an AmbiguousMatchError with `.count === K`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { editTool } from "../../../engine/src/tools/edit.js";
import { denyAll } from "../../../engine/src/tools/permissions.js";
import { AmbiguousMatchError, type ToolContext } from "../../../engine/src/tools/types.js";

function propertyCtx(): { ctx: ToolContext; cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "jellyclaw-edit-prop-"));
  const ctx: ToolContext = {
    cwd,
    sessionId: "prop-session",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: denyAll,
  };
  return {
    ctx,
    cwd,
    cleanup: () => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe("editTool property tests", () => {
  it("unique-marker replacement yields exactly prefix + new + suffix", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.stringMatching(/^[A-Z]{8}$/),
        fc.string(),
        async (prefix, suffix, marker, replacement) => {
          fc.pre(marker.length === 8);
          fc.pre(!prefix.includes(marker));
          fc.pre(!suffix.includes(marker));
          fc.pre(marker !== replacement);

          const { ctx, cwd, cleanup } = propertyCtx();
          try {
            const target = resolve(join(cwd, "prop.txt"));
            const content = `${prefix}${marker}${suffix}`;
            writeFileSync(target, content, "utf8");
            ctx.readCache.add(target);

            const out = await editTool.handler(
              { file_path: target, old_string: marker, new_string: replacement },
              ctx,
            );

            expect(out.occurrences_replaced).toBe(1);

            // Mirror the tool's EOF-newline preservation for the oracle.
            let expected = `${prefix}${replacement}${suffix}`;
            if (content.endsWith("\n") && !expected.endsWith("\n")) expected = `${expected}\n`;
            else if (!content.endsWith("\n") && expected.endsWith("\n"))
              expected = expected.slice(0, -1);

            expect(readFileSync(target, "utf8")).toBe(expected);
          } finally {
            cleanup();
          }
        },
      ),
      { seed: 42, numRuns: 100 },
    );
  });

  it("K repetitions yield AmbiguousMatchError with count === K", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Z]{3,10}$/),
        fc.integer({ min: 2, max: 8 }),
        async (marker, k) => {
          fc.pre(marker.trim().length > 0);

          const { ctx, cwd, cleanup } = propertyCtx();
          try {
            const target = resolve(join(cwd, "prop.txt"));
            const content = `${marker} `.repeat(k);
            writeFileSync(target, content, "utf8");
            ctx.readCache.add(target);

            try {
              await editTool.handler(
                { file_path: target, old_string: marker, new_string: "X" },
                ctx,
              );
              expect.fail("should have thrown AmbiguousMatchError");
            } catch (err) {
              expect(err).toBeInstanceOf(AmbiguousMatchError);
              expect((err as AmbiguousMatchError).count).toBe(k);
            }
          } finally {
            cleanup();
          }
        },
      ),
      { seed: 42, numRuns: 100 },
    );
  });
});

/**
 * Phase 10.03 — library API: type-surface compile check.
 *
 * We spawn `tsc --noEmit` against a tiny fixture that imports every symbol
 * the public barrel promises (values + types). If the fixture fails to
 * compile, the public surface has drifted from `engine/src/public-types.ts`.
 *
 * This test points tsc at `engine/src/index.ts` via path aliases — it does
 * NOT rely on `dist/` existing. A separate integration check (post-build)
 * can wire the real `dist/index.d.ts` once CI runs `bun run build` first.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURE_TSCONFIG = resolve(HERE, "fixtures", "tsconfig.json");

describe("library: public type surface compiles", () => {
  it("fixture typechecks against engine/src/index.ts via path alias", () => {
    // `bunx tsc` ships with the repo's pinned TypeScript. We don't use
    // `bun x` here because we want deterministic resolution from root.
    const result = spawnSync("bunx", ["tsc", "--noEmit", "--project", FIXTURE_TSCONFIG], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    if (result.status !== 0) {
      // Surface the tsc diagnostics on failure — easier than re-running.
      const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      throw new Error(`tsc --noEmit failed (exit ${result.status}):\n${out}`);
    }

    expect(result.status).toBe(0);
  }, 60_000);
});

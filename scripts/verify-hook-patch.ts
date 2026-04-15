/**
 * verify-hook-patch — regression gate for OpenCode issue #5894.
 *
 * Historically this script would grep `node_modules/opencode-ai` for a patched
 * sentinel string injected by `patches/001-subagent-hook-fire.patch`. Because
 * `opencode-ai` on npm ships a **compiled Bun-built standalone binary**, no such
 * patch exists on disk — there is nothing to grep. The original fix was therefore
 * pivoted to a first-class jellyclaw plugin at `engine/src/plugin/agent-context.ts`
 * (see `patches/README.md` and `patches/001-subagent-hook-fire.design.md`).
 *
 * This script therefore performs a two-step check:
 *
 *   1. Static surface check — the design-intent record is still present and
 *      marked `STATUS: superseded`, the replacement source file exists, and
 *      its expected public surface (`enrichHookEnvelope`, `createCachedResolver`,
 *      `MAX_AGENT_CHAIN_DEPTH`) is exported.
 *
 *   2. Dynamic behavior check — the sibling-authored integration test at
 *      `test/integration/subagent-hooks.test.ts` is spawned under vitest and
 *      must pass. This exercises the dispatcher-level event-stream behavior
 *      that the original upstream bug would have broken.
 *
 * Run this on every upstream `opencode-ai` version bump. A failure here means
 * either upstream #5894 has resurfaced or the jellyclaw dispatcher has regressed.
 *
 * Uses only standard Node/Bun APIs; no new deps.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function printLine(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

const REPO_ROOT = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");

const DESIGN_DOC = resolve(REPO_ROOT, "patches/001-subagent-hook-fire.design.md");
const PATCHES_README = resolve(REPO_ROOT, "patches/README.md");
const REPLACEMENT_SRC = resolve(REPO_ROOT, "engine/src/plugin/agent-context.ts");
const INTEGRATION_TEST = "test/integration/subagent-hooks.test.ts";

const FAIL_PREFIX =
  "[fail] jellyclaw hook-fire replacement (engine/src/plugin/agent-context.ts) has regressed";
const FAIL_SUFFIX =
  "See patches/README.md and patches/001-subagent-hook-fire.design.md. " +
  "The original upstream bug is OpenCode #5894.";

function fail(reason: string): never {
  console.error(`${FAIL_PREFIX}: ${reason}. ${FAIL_SUFFIX}`);
  process.exit(1);
}

async function staticSurfaceCheck(): Promise<void> {
  if (!existsSync(DESIGN_DOC)) {
    fail(`design-intent record missing at patches/001-subagent-hook-fire.design.md`);
  }

  const designText = readFileSync(DESIGN_DOC, "utf8");
  // The STATUS line lives at the top of the file; require it within the first ~400 chars
  // so a lone mention buried deeper in the file can't satisfy the check.
  const head = designText.slice(0, 400);
  if (!head.includes("STATUS: superseded")) {
    fail(
      "patches/001-subagent-hook-fire.design.md no longer declares `STATUS: superseded` at the top",
    );
  }

  if (!existsSync(PATCHES_README)) {
    fail("patches/README.md is missing");
  }

  if (!existsSync(REPLACEMENT_SRC)) {
    fail("engine/src/plugin/agent-context.ts does not exist");
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(REPLACEMENT_SRC).href)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`failed to dynamic-import engine/src/plugin/agent-context.ts: ${msg}`);
  }

  const required = ["enrichHookEnvelope", "createCachedResolver", "MAX_AGENT_CHAIN_DEPTH"] as const;
  for (const name of required) {
    if (!(name in mod) || mod[name] === undefined) {
      fail(`engine/src/plugin/agent-context.ts no longer exports \`${name}\``);
    }
  }

  printLine(
    "[ok] static surface: design-intent record, patches/README.md, and agent-context.ts exports verified",
  );
}

function dynamicBehaviorCheck(): Promise<void> {
  return new Promise((resolvePromise) => {
    const child = spawn("bun", ["run", "test", INTEGRATION_TEST], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      console.error(stdoutBuf);
      console.error(stderrBuf);
      console.error(
        `[fail] dynamic regression: failed to spawn vitest (${err.message}). ` +
          "This indicates upstream OpenCode #5894 has resurfaced or the jellyclaw dispatcher has regressed.",
      );
      process.exit(1);
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        process.stdout.write(stdoutBuf);
        process.stderr.write(stderrBuf);
        console.error(
          "[fail] dynamic regression: subagent-hooks test suite failed — see output above. " +
            "This indicates upstream OpenCode #5894 has resurfaced or the jellyclaw dispatcher has regressed.",
        );
        process.exit(1);
      }
      printLine(
        "[ok] dynamic behavior: test/integration/subagent-hooks.test.ts passed under vitest",
      );
      resolvePromise();
    });
  });
}

async function main(): Promise<void> {
  await staticSurfaceCheck();
  await dynamicBehaviorCheck();
  printLine("patch verified: static + dynamic");
  process.exit(0);
}

void main();

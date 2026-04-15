/**
 * verify-scrub-patch — regression gate for OpenCode tool-result secret scrubbing.
 *
 * Historically this was a patch against opencode-ai's session/prompt.ts tool-result
 * pipeline (see `patches/003-secret-scrub-tool-results.design.md`). Because
 * opencode-ai ships as a compiled Bun binary, that patch was pivoted to
 * first-class jellyclaw modules:
 *
 *   - Plugin layer:  engine/src/plugin/secret-scrub.ts (applied in the
 *                    runtime plugin shim)
 *   - Engine-wide:   engine/src/security/scrub.ts + apply-scrub.ts + secret-patterns.ts
 *                    (applied to every tool result before event emit /
 *                     hook dispatch / session persistence; wired in the
 *                     tool-result pipeline landing in Phase 10)
 *
 * This script performs a two-step check:
 *
 *   1. Static surface check — design-intent record still marked
 *      `STATUS: superseded`, both replacement modules present, and the
 *      expected public surface is exported.
 *
 *   2. Dynamic behavior check — the integration test at
 *      `test/integration/scrub-e2e.test.ts` is spawned under vitest and
 *      must pass. It proves a mock tool returning a secret is scrubbed
 *      before the result reaches the event stream, hooks, or session
 *      store.
 *
 * Run on every upstream opencode-ai version bump. A failure here means
 * either the design was reverted, the plugin shim lost its scrubber
 * call, or the engine-wide module regressed.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function printLine(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

const REPO_ROOT = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");

const DESIGN_DOC = resolve(REPO_ROOT, "patches/003-secret-scrub-tool-results.design.md");
const PATCHES_README = resolve(REPO_ROOT, "patches/README.md");
const PLUGIN_SRC = resolve(REPO_ROOT, "engine/src/plugin/secret-scrub.ts");
const ENGINE_SRC = resolve(REPO_ROOT, "engine/src/security/index.ts");
const INTEGRATION_TEST = "test/integration/scrub-e2e.test.ts";

const FAIL_PREFIX =
  "[fail] jellyclaw secret-scrub replacement (engine/src/security/ + engine/src/plugin/secret-scrub.ts) has regressed";
const FAIL_SUFFIX = "See patches/README.md and patches/003-secret-scrub-tool-results.design.md.";

function fail(reason: string): never {
  console.error(`${FAIL_PREFIX}: ${reason}. ${FAIL_SUFFIX}`);
  process.exit(1);
}

async function staticSurfaceCheck(): Promise<void> {
  if (!existsSync(DESIGN_DOC)) {
    fail("design-intent record missing at patches/003-secret-scrub-tool-results.design.md");
  }
  const designText = readFileSync(DESIGN_DOC, "utf8");
  const head = designText.slice(0, 400);
  if (!head.includes("STATUS: superseded")) {
    fail(
      "patches/003-secret-scrub-tool-results.design.md no longer declares `STATUS: superseded` at the top",
    );
  }
  if (!existsSync(PATCHES_README)) fail("patches/README.md is missing");
  if (!existsSync(PLUGIN_SRC)) fail("engine/src/plugin/secret-scrub.ts does not exist");
  if (!existsSync(ENGINE_SRC)) fail("engine/src/security/index.ts does not exist");

  let engine: Record<string, unknown>;
  try {
    engine = (await import(pathToFileURL(ENGINE_SRC).href)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`failed to dynamic-import engine/src/security/index.ts: ${msg}`);
  }
  const requiredEngine = [
    "builtInPatterns",
    "compileUserPatterns",
    "mergePatterns",
    "scrubString",
    "applyScrub",
  ] as const;
  for (const name of requiredEngine) {
    if (!(name in engine) || engine[name] === undefined) {
      fail(`engine/src/security/index.ts no longer exports \`${name}\``);
    }
  }

  let plugin: Record<string, unknown>;
  try {
    plugin = (await import(pathToFileURL(PLUGIN_SRC).href)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`failed to dynamic-import engine/src/plugin/secret-scrub.ts: ${msg}`);
  }
  if (!("scrubToolResult" in plugin)) {
    fail("engine/src/plugin/secret-scrub.ts no longer exports `scrubToolResult`");
  }

  printLine(
    "[ok] static surface: design-intent record, patches/README.md, plugin + engine scrub modules verified",
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
        `[fail] dynamic regression: failed to spawn vitest (${err.message}). The scrub pipeline has regressed.`,
      );
      process.exit(1);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        process.stdout.write(stdoutBuf);
        process.stderr.write(stderrBuf);
        console.error("[fail] dynamic regression: scrub-e2e test suite failed — see output above.");
        process.exit(1);
      }
      printLine("[ok] dynamic behavior: test/integration/scrub-e2e.test.ts passed under vitest");
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

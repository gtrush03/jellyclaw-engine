/**
 * smoke-01-boot — CLI bootability.
 *
 * CANARY test. Exercises three entry points:
 *   1. `node engine/dist/cli/main.js --help` → exit 0, stdout contains the
 *      description line.
 *   2. `node engine/dist/cli/main.js --version` → exit 0, stdout matches a
 *      semver-ish version string.
 *   3. `engine/bin/jellyclaw-serve --help` → expected to fail on pre-T0-01
 *      main because the shim dispatches to `main.js` without injecting
 *      argv[0]=serve. Documented here as the canary regression.
 */

import { spawn } from "node:child_process";

import { assert, cliJs, serveBin } from "./lib/harness.mjs";

function runProcess(cmd, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolveP) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    proc.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    proc.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    proc.on("exit", (code, signal) => {
      clearTimeout(t);
      resolveP({
        code: code ?? -1,
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(t);
      resolveP({
        code: -1,
        signal: null,
        stdout,
        stderr: stderr + String(err),
        timedOut: false,
      });
    });
  });
}

export default async function run({ log }) {
  const started = Date.now();
  const details = { steps: [] };

  // --- 1. --help -----------------------------------------------------------
  {
    const r = await runProcess(process.execPath, [cliJs(), "--help"], { timeoutMs: 5000 });
    details.steps.push({ step: "--help", code: r.code, timedOut: r.timedOut });
    log?.(`  [--help] exit=${r.code} timedOut=${r.timedOut}`);
    assert(!r.timedOut, "smoke-01: --help timed out after 5s");
    assert(r.code === 0, "smoke-01: --help exit code", `got ${r.code}, stderr=${r.stderr.slice(0, 400)}`);
    assert(
      r.stdout.includes("jellyclaw — open-source Claude Code replacement"),
      "smoke-01: --help stdout description missing",
      r.stdout.slice(0, 400),
    );
  }

  // --- 2. --version --------------------------------------------------------
  {
    const r = await runProcess(process.execPath, [cliJs(), "--version"], { timeoutMs: 5000 });
    details.steps.push({ step: "--version", code: r.code, timedOut: r.timedOut });
    log?.(`  [--version] exit=${r.code} stdout=${r.stdout.trim()}`);
    assert(!r.timedOut, "smoke-01: --version timed out after 5s");
    assert(r.code === 0, "smoke-01: --version exit code", `got ${r.code}, stderr=${r.stderr.slice(0, 400)}`);
    const trimmed = r.stdout.trim();
    assert(
      /^\d+\.\d+\.\d+/.test(trimmed),
      "smoke-01: --version stdout not semver-like",
      trimmed.slice(0, 200),
    );
  }

  // --- 3. jellyclaw-serve shim --help (CANARY — pre-T0-01 shim is broken) --
  //
  // The shim does `import("../dist/cli/main.js")` but main.js's
  // `invokedDirectly` self-call check (see main.ts) only fires when
  // `process.argv[1]` ends in `/dist/cli/main.js` or `/bin/jellyclaw`. For
  // `/bin/jellyclaw-serve` it silently no-ops — exit 0 with empty stdout —
  // so `--help` "works" by accident but prints nothing.
  //
  // Post-T0-01, the shim should rewrite argv to inject `serve` and/or call
  // `main()` directly so that `--help` actually emits help text.
  {
    const r = await runProcess(process.execPath, [serveBin(), "--help"], { timeoutMs: 5000 });
    details.steps.push({
      step: "jellyclaw-serve --help",
      code: r.code,
      timedOut: r.timedOut,
      stdoutLen: r.stdout.length,
    });
    log?.(`  [jellyclaw-serve --help] exit=${r.code} stdoutLen=${r.stdout.length}`);
    assert(!r.timedOut, "smoke-01: jellyclaw-serve --help timed out");
    assert(
      r.code === 0,
      "smoke-01 (CANARY): jellyclaw-serve --help exit code",
      `got ${r.code}; stderr=${r.stderr.slice(0, 400)}`,
    );
    // The load-bearing assertion: the shim must actually print serve help.
    // Pre-T0-01 it prints nothing, which is the bug this canary detects.
    assert(
      r.stdout.includes("HTTP server") || r.stdout.includes("jellyclaw"),
      "smoke-01 (CANARY): jellyclaw-serve --help produced no help text (pre-T0-01 shim does not dispatch to main())",
      `stdoutLen=${r.stdout.length}; stdout='${r.stdout.slice(0, 200)}'`,
    );
  }

  return {
    name: "smoke-01-boot",
    passed: true,
    duration_ms: Date.now() - started,
    details,
  };
}

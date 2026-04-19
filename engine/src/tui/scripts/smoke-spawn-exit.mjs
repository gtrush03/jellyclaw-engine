#!/usr/bin/env node
// T0-01 baseline smoke: confirm `jellyclaw tui` mounts Ink and exits cleanly.
//
// We spawn the bin under `bun` (the TUI dynamic-imports vendored TSX; node
// can't parse it). After ~3s the splash should be on screen, at which point
// we send SIGINT to the child. The CLI's own SIGINT handler in
// engine/src/cli/tui.ts settles with 130, which we treat as success along
// with a clean 0. Any other exit (or a hang past the budget) is a failure.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const BIN = join(REPO_ROOT, "engine/bin/jellyclaw");
// The TUI synchronously spawns an embedded jellyclaw server during mount.
// Under bun the server start path can take 3–6 s on a cold cache, and SIGINT
// arriving mid-spawn means the child can take a few extra seconds to drain.
// Generous windows here avoid flake without papering over a real hang.
const MOUNT_DELAY_MS = 6000;
const EXIT_BUDGET_MS = 12000;

function log(line) {
  process.stdout.write(`[smoke-spawn-exit] ${line}\n`);
}

function loadAnthropicKey() {
  const credsPath = join(homedir(), ".jellyclaw", "credentials.json");
  if (!existsSync(credsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(credsPath, "utf8"));
    return typeof parsed.anthropicApiKey === "string" ? parsed.anthropicApiKey : null;
  } catch {
    return null;
  }
}

function fail(reason) {
  log(`FAIL: ${reason}`);
  process.exit(1);
}

const apiKey = loadAnthropicKey();
if (apiKey === null || apiKey.length === 0) {
  fail("missing ~/.jellyclaw/credentials.json or anthropicApiKey");
}

const env = {
  ...process.env,
  ANTHROPIC_API_KEY: apiKey,
  TERM: "xterm-256color",
  // Skip the playwright/chrome MCP autolaunch — speeds up boot for the smoke.
  JELLYCLAW_DISABLE_CHROME_AUTOLAUNCH: "1",
};

log(`spawning: bun ${BIN} tui`);
const started = Date.now();
const child = spawn("bun", [BIN, "tui"], {
  cwd: REPO_ROOT,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBytes = 0;
let stderrBytes = 0;
child.stdout.on("data", (chunk) => {
  stdoutBytes += chunk.length;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderrBytes += chunk.length;
  process.stderr.write(chunk);
});

let exited = false;
let exitCode = null;
let exitSignal = null;
const exitPromise = new Promise((resolve) => {
  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    resolve();
  });
});

child.once("error", (err) => {
  fail(`spawn error: ${err?.message ?? String(err)}`);
});

await new Promise((r) => setTimeout(r, MOUNT_DELAY_MS));

if (exited) {
  fail(
    `TUI exited before SIGINT (code=${exitCode}, signal=${exitSignal}, stdout=${stdoutBytes}B, stderr=${stderrBytes}B)`,
  );
}

log(`mount window elapsed (${Date.now() - started}ms); sending SIGINT`);
child.kill("SIGINT");

const timeoutPromise = new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`exit budget exceeded (${EXIT_BUDGET_MS}ms)`)), EXIT_BUDGET_MS),
);

try {
  await Promise.race([exitPromise, timeoutPromise]);
} catch (err) {
  log(`escalating to SIGKILL: ${err?.message ?? String(err)}`);
  child.kill("SIGKILL");
  await exitPromise;
  fail(`TUI did not exit within ${EXIT_BUDGET_MS}ms after SIGINT`);
}

const wallMs = Date.now() - started;
log(`child exited (code=${exitCode}, signal=${exitSignal}, wall=${wallMs}ms)`);

// 0 = clean exit; 130 = SIGINT-handled exit (engine/src/cli/tui.ts contract);
// signal === 'SIGINT' = process terminated by the signal we sent (also clean —
// bun child processes sometimes report the raw signal instead of converting
// to exit code 130 even when our SIGINT handler has run).
if (exitCode === 0 || exitCode === 130 || exitSignal === "SIGINT") {
  log(`PASS: TUI accepted SIGINT and exited cleanly`);
  process.exit(0);
}

fail(`unexpected exit code ${exitCode} (signal=${exitSignal})`);

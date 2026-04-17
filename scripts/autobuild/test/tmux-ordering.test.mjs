// tmux-ordering.test.mjs — verify that:
//   1. ensureTmuxServer() exists and returns without throwing, even when no
//      tmux server is running (and even when AUTOBUILD_DRY_RUN=1 short-circuits
//      the execa call).
//   2. The spawn sequence in dispatcher.spawnWorker calls `new-session` BEFORE
//      `pipe-pane`, preventing the "no server running" error.
//
// For (2) we can't easily exercise spawnWorker in dry-run mode because dry-run
// short-circuits before the tmux calls. Instead we perform a lightweight
// static check: read dispatcher.mjs and assert the source order. This is
// fragile to refactors but catches the exact regression we just fixed.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Set AUTOBUILD_DRY_RUN so that the tmux helpers short-circuit — we don't
// actually want to poke a real tmux server during unit tests.
process.env.AUTOBUILD_DRY_RUN = "1";

const HERE = dirname(fileURLToPath(import.meta.url));
const dispatcherPath = resolve(HERE, "..", "dispatcher.mjs");
const tmuxLibPath = resolve(HERE, "..", "lib", "tmux.mjs");

const tmuxMod = await import("../lib/tmux.mjs");

test("ensureTmuxServer is exported and does not throw (dry-run)", async () => {
  assert.equal(typeof tmuxMod.ensureTmuxServer, "function");
  // In dry-run we short-circuit; the contract is just "no throw".
  const result = await tmuxMod.ensureTmuxServer();
  assert.ok(result, "ensureTmuxServer should return a truthy value");
});

test("ensureTmuxServer does not throw when tmux server is already up", async () => {
  // In dry-run this is guaranteed; in real mode `tmux start-server` is a
  // no-op against an existing daemon. We cover both via reject:false.
  delete process.env.AUTOBUILD_DRY_RUN;
  try {
    // Second call — prove idempotence.
    await tmuxMod.ensureTmuxServer();
    await tmuxMod.ensureTmuxServer();
  } catch (err) {
    assert.fail(`ensureTmuxServer threw: ${err.message}`);
  } finally {
    process.env.AUTOBUILD_DRY_RUN = "1";
  }
});

test("spawnWorker invokes new-session before pipe-pane", () => {
  // Static check on dispatcher.mjs source to guard against the P0 regression.
  // If spawnWorker ever puts a pipePane() call above newDetachedSession()
  // again, this test will fail.
  const src = readFileSync(dispatcherPath, "utf8");
  // Isolate the real-spawn block (starts at "Real spawn." comment, ends at
  // the transition to "working").
  const realSpawnStart = src.indexOf("// Real spawn.");
  assert.ok(realSpawnStart > 0, "could not locate '// Real spawn.' marker");
  const realSpawnEnd = src.indexOf("appendTransition(sdir, { to: \"working\" })", realSpawnStart);
  assert.ok(realSpawnEnd > realSpawnStart, "could not locate 'working' transition");
  const block = src.slice(realSpawnStart, realSpawnEnd);

  const pipePaneIdx = block.indexOf("pipePane(tmux, tmuxLog)");
  const newSessionIdx = block.indexOf("newDetachedSession(");
  const ensureServerIdx = block.indexOf("ensureTmuxServer(");
  assert.ok(pipePaneIdx > 0, "pipePane call missing from real-spawn block");
  assert.ok(newSessionIdx > 0, "newDetachedSession call missing from real-spawn block");
  assert.ok(ensureServerIdx > 0, "ensureTmuxServer call missing — server not started eagerly");
  assert.ok(
    ensureServerIdx < newSessionIdx,
    "ensureTmuxServer must run before newDetachedSession",
  );
  assert.ok(
    newSessionIdx < pipePaneIdx,
    "newDetachedSession must run before pipePane (this is the tmux ordering bug we just fixed)",
  );

  // There should be exactly ONE pipePane call in the real-spawn block — the
  // earlier double-call was the regression.
  const pipePaneCount = block.split("pipePane(tmux, tmuxLog)").length - 1;
  assert.equal(
    pipePaneCount,
    1,
    `expected exactly one pipePane call, found ${pipePaneCount}`,
  );
});

test("lib/tmux.mjs exports ensureTmuxServer", () => {
  const src = readFileSync(tmuxLibPath, "utf8");
  assert.ok(
    /export\s+async\s+function\s+ensureTmuxServer/.test(src),
    "ensureTmuxServer must be exported from lib/tmux.mjs",
  );
});

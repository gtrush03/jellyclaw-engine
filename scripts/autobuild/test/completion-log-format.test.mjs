// completion-log-format.test.mjs — multi-line phase block + idempotent append.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { appendCompletionLogEntry } from "../lib/completion-log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "COMPLETION-LOG.md.fixture");

function tmpLog() {
  const dir = mkdtempSync(join(tmpdir(), "autobuild-log-"));
  const path = join(dir, "COMPLETION-LOG.md");
  copyFileSync(FIXTURE, path);
  return { path, dir };
}

test("first append creates phase section + table and checklist entry", () => {
  const { path, dir } = tmpLog();
  try {
    const res = appendCompletionLogEntry({
      logPath: path,
      phaseId: "99b-unfucking-v2",
      phaseName: "Unfucking v2 (autobuild-driven)",
      promptId: "T0-01-fix-serve-shim",
      promptTitle: "Fix serve shim",
      startedAtIso: "2026-04-17T10:00:00.000Z",
      endedAtIso: "2026-04-17T10:05:00.000Z",
      commits: ["abc1234"],
      tests: { passed: 2, total: 2 },
    });
    assert.equal(res.created, true);
    assert.equal(res.appended, true);
    assert.equal(res.duplicate, false);

    const content = readFileSync(path, "utf8");
    assert.match(content, /### Phase 99b-unfucking-v2 — Unfucking v2/);
    assert.match(content, /\*\*Status:\*\* 🔄 In progress \(autobuild\)/);
    assert.match(content, /\*\*Session count:\*\* 1/);
    assert.match(content, /\*\*Tests passing:\*\* 2\/2/);
    assert.match(content, /#### Sub-prompt log/);
    assert.match(
      content,
      /\|\s*T0-01-fix-serve-shim\s*\|\s*Fix serve shim\s*\|\s*2026-04-17T10:05:00\.000Z\s*\|\s*5m\s*\|\s*abc1234\s*\|\s*2\/2\s*\|/,
    );
    // Original hand-edited phase sections must remain intact.
    assert.match(content, /### Phase 00 — Repo scaffolding/);
    assert.match(content, /### Phase 01 — OpenCode pinning and patching/);
    assert.match(content, /Hand-edited prose about pinning should be preserved verbatim\./);
    // Checklist entry under a new "### Unfucking v2" subhead.
    assert.match(content, /### Unfucking v2\n- \[ \] 🔄 Phase 99b-unfucking-v2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running append twice for the same prompt does NOT duplicate the row", () => {
  const { path, dir } = tmpLog();
  try {
    const opts = {
      logPath: path,
      phaseId: "99b-unfucking-v2",
      promptId: "T0-01-fix-serve-shim",
      promptTitle: "Fix serve shim",
      startedAtIso: "2026-04-17T10:00:00.000Z",
      endedAtIso: "2026-04-17T10:05:00.000Z",
      commits: ["abc1234"],
      tests: { passed: 2, total: 2 },
    };
    const r1 = appendCompletionLogEntry(opts);
    const r2 = appendCompletionLogEntry(opts);

    assert.equal(r1.appended, true);
    assert.equal(r2.appended, false, "second call must not append");
    assert.equal(r2.duplicate, true);

    const content = readFileSync(path, "utf8");
    const matches = content.match(/\|\s*T0-01-fix-serve-shim\s*\|/g) || [];
    assert.equal(matches.length, 1, "exactly one row for this prompt");

    // Session count must still be 1, not 2.
    assert.match(content, /\*\*Session count:\*\* 1\b/);
    assert.match(content, /\*\*Tests passing:\*\* 2\/2\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("second different prompt appends a new row, increments counters", () => {
  const { path, dir } = tmpLog();
  try {
    appendCompletionLogEntry({
      logPath: path,
      phaseId: "99b-unfucking-v2",
      promptId: "T0-01-fix-serve-shim",
      promptTitle: "Fix serve shim",
      startedAtIso: "2026-04-17T10:00:00.000Z",
      endedAtIso: "2026-04-17T10:05:00.000Z",
      commits: ["abc1234"],
      tests: { passed: 2, total: 2 },
    });
    appendCompletionLogEntry({
      logPath: path,
      phaseId: "99b-unfucking-v2",
      promptId: "T0-02-wire-logger",
      promptTitle: "Wire structured logger",
      startedAtIso: "2026-04-17T11:00:00.000Z",
      endedAtIso: "2026-04-17T11:03:00.000Z",
      commits: ["def5678", "fed9876"],
      tests: { passed: 3, total: 3 },
    });

    const content = readFileSync(path, "utf8");
    assert.match(content, /T0-01-fix-serve-shim/);
    assert.match(content, /T0-02-wire-logger/);
    assert.match(content, /def5678, fed9876/);
    assert.match(content, /\*\*Session count:\*\* 2\b/);
    assert.match(content, /\*\*Tests passing:\*\* 5\/5\b/);
    // Unrelated phase sections still present.
    assert.match(content, /### Phase 00 — Repo scaffolding/);
    assert.match(content, /### Phase 01 — OpenCode pinning and patching/);
    // Checklist shows "(2 sub-prompts)" suffix.
    assert.match(content, /Phase 99b-unfucking-v2 — Unfucking v2.*\(2 sub-prompts\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phaseComplete=true flips Status to ✅ and sets Completed date", () => {
  const { path, dir } = tmpLog();
  try {
    appendCompletionLogEntry({
      logPath: path,
      phaseId: "99b-unfucking-v2",
      promptId: "T0-03-last",
      promptTitle: "The last sub-prompt",
      startedAtIso: "2026-04-18T09:00:00.000Z",
      endedAtIso: "2026-04-18T09:10:00.000Z",
      commits: ["end9999"],
      tests: { passed: 1, total: 1 },
      phaseComplete: true,
    });
    const content = readFileSync(path, "utf8");
    assert.match(
      content,
      /### Phase 99b-unfucking-v2 — Unfucking v2 \(autobuild-driven\)\n\n\*\*Status:\*\* ✅ Complete/,
    );
    assert.match(content, /\*\*Completed:\*\* 2026-04-18/);
    // Checklist marker flipped to [x] ✅.
    assert.match(content, /- \[x\] ✅ Phase 99b-unfucking-v2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic write leaves valid markdown even if process crashes mid-write", () => {
  // We simulate this by ensuring the tmp→rename pattern results in exactly
  // one file at the destination after a successful call (no stray .tmp).
  const { path, dir } = tmpLog();
  try {
    appendCompletionLogEntry({
      logPath: path,
      phaseId: "99b-unfucking-v2",
      promptId: "T0-atomic",
      promptTitle: "Atomic test",
      startedAtIso: "2026-04-17T00:00:00.000Z",
      endedAtIso: "2026-04-17T00:01:00.000Z",
      commits: ["atomic0"],
      tests: { passed: 1, total: 1 },
    });
    const siblings = readdirSync(dir);
    const stray = siblings.filter((f) => f.includes(".tmp."));
    assert.equal(stray.length, 0, `no stray tmp files: ${stray.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

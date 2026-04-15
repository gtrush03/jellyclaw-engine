/**
 * Phase 08 Prompt 02 — tests for the single-hook runner.
 *
 * These tests exercise `runSingleHook` against real shell / node scripts,
 * not mocks. Fixtures are materialized under `test/fixtures/hooks/` in
 * `beforeAll` so the suite is hermetic and works on a fresh checkout.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSingleHook, stringifyPayload } from "./runner.js";
import type {
  CompiledHook,
  HookConfig,
  HookEvent,
  HookEventKind,
  NotificationPayload,
  PostToolUsePayload,
  PreToolUsePayload,
  SessionStartPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixture layout
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIX_DIR = path.join(REPO_ROOT, "test", "fixtures", "hooks");

function bashAvailable(): boolean {
  try {
    execSync("command -v bash", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_BASH = bashAvailable();

interface Fixture {
  readonly name: string;
  readonly body: string;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "allow.sh",
    body: `#!/usr/bin/env bash
echo '{"decision":"allow"}'
exit 0
`,
  },
  {
    name: "deny-exit2.sh",
    body: `#!/usr/bin/env bash
echo "nope" >&2
exit 2
`,
  },
  {
    name: "deny-stdout.sh",
    body: `#!/usr/bin/env bash
echo '{"decision":"deny","reason":"nope-out"}'
exit 0
`,
  },
  {
    name: "modify.sh",
    body: `#!/usr/bin/env bash
echo '{"decision":"modify","modified":{"sessionId":"s","toolName":"Bash","toolInput":{"command":"echo safe"},"callId":"c"}}'
exit 0
`,
  },
  {
    name: "sleep.sh",
    body: `#!/usr/bin/env bash
sleep 5
`,
  },
  {
    name: "malformed.sh",
    body: `#!/usr/bin/env bash
echo "not json"
exit 0
`,
  },
  {
    name: "big.sh",
    // 2 MB of 'a' via python/perl/node fallback — pure bash repeat is slow.
    // Use head to allocate 2 MB from /dev/zero then tr to 'a'.
    body: `#!/usr/bin/env bash
head -c 2097152 /dev/zero | tr '\\0' 'a'
exit 0
`,
  },
  {
    name: "nonzero.sh",
    body: `#!/usr/bin/env bash
exit 7
`,
  },
  {
    name: "neutral-empty.sh",
    body: `#!/usr/bin/env bash
exit 0
`,
  },
  {
    name: "exit2-nonblocking.sh",
    body: `#!/usr/bin/env bash
echo "should not block" >&2
exit 2
`,
  },
  {
    name: "allow-on-notification.sh",
    body: `#!/usr/bin/env bash
echo '{"decision":"allow"}'
exit 0
`,
  },
];

beforeAll(() => {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  for (const f of FIXTURES) {
    const p = path.join(FIX_DIR, f.name);
    fs.writeFileSync(p, f.body, { encoding: "utf8" });
    fs.chmodSync(p, 0o755);
  }
});

afterAll(() => {
  // Leave fixtures in place; they're hermetic and cheap. No cleanup needed.
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compile(config: HookConfig, name = "test-hook"): CompiledHook {
  return {
    config,
    name,
    match: () => true,
  };
}

function bashHook(script: string, extra: Partial<HookConfig> = {}): CompiledHook {
  const cfg: HookConfig = {
    event: "PreToolUse",
    command: path.join(FIX_DIR, script),
    ...extra,
  };
  return compile(cfg, script);
}

function preToolUseEvent(overrides: Partial<PreToolUsePayload> = {}): HookEvent & {
  readonly kind: "PreToolUse";
} {
  const payload: PreToolUsePayload = {
    sessionId: "s-1",
    toolName: "Bash",
    toolInput: { command: "echo hi" },
    callId: "c-1",
    ...overrides,
  };
  return { kind: "PreToolUse", payload };
}

function postToolUseEvent(): HookEvent & { readonly kind: "PostToolUse" } {
  const payload: PostToolUsePayload = {
    sessionId: "s-1",
    toolName: "Bash",
    toolInput: { command: "ls" },
    toolResult: "ok",
    callId: "c-1",
    durationMs: 5,
  };
  return { kind: "PostToolUse", payload };
}

function sessionStartEvent(): HookEvent & { readonly kind: "SessionStart" } {
  const payload: SessionStartPayload = {
    sessionId: "s-1",
    cwd: "/tmp",
    config: {},
  };
  return { kind: "SessionStart", payload };
}

function notificationEvent(): HookEvent & { readonly kind: "Notification" } {
  const payload: NotificationPayload = {
    sessionId: "s-1",
    level: "info",
    message: "hello",
  };
  return { kind: "Notification", payload };
}

// Skip bash-dependent tests on platforms without bash.
const bashIt = HAS_BASH ? it : it.skip;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runSingleHook — stringifyPayload", () => {
  it("produces single-line JSON with trailing newline", () => {
    const line = stringifyPayload(preToolUseEvent());
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line) as { event: HookEventKind; payload: PreToolUsePayload };
    expect(parsed.event).toBe("PreToolUse");
    expect(parsed.payload.toolName).toBe("Bash");
  });
});

describe("runSingleHook — happy path", () => {
  bashIt("allow decision on PreToolUse → allow outcome", async () => {
    const hook = bashHook("allow.sh");
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("allow");
    expect(out.exitCode).toBe(0);
    expect(out.timedOut).toBe(false);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(out.durationMs)).toBe(true);
  });

  bashIt("exit 2 on blocking event → deny with stderr reason", async () => {
    const hook = bashHook("deny-exit2.sh");
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("nope");
    expect(out.exitCode).toBe(2);
    expect(out.timedOut).toBe(false);
  });

  bashIt("deny via stdout JSON carries reason", async () => {
    const hook = bashHook("deny-stdout.sh");
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("nope-out");
    expect(out.exitCode).toBe(0);
  });

  bashIt("modify on PreToolUse returns modified payload", async () => {
    const hook = bashHook("modify.sh");
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("modify");
    expect(out.modified).toBeDefined();
    const mod = out.modified as PreToolUsePayload;
    expect(mod.toolInput).toEqual({ command: "echo safe" });
  });

  bashIt("neutral empty stdout exit 0 → neutral", async () => {
    const hook = bashHook("neutral-empty.sh");
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("neutral");
    expect(out.exitCode).toBe(0);
    expect(out.warn).toBeUndefined();
  });
});

describe("runSingleHook — downgrades & warnings", () => {
  bashIt("modify on SessionStart (non-modifiable) → neutral + warn", async () => {
    const hook: CompiledHook = compile(
      { event: "SessionStart", command: path.join(FIX_DIR, "modify.sh") },
      "modify.sh",
    );
    const out = await runSingleHook(hook, sessionStartEvent(), "s-1");
    expect(out.decision).toBe("neutral");
    expect(out.warn ?? "").toContain("modify not supported");
  });

  bashIt("exit 2 on non-blocking event (PostToolUse) → neutral + warn", async () => {
    const hook: CompiledHook = compile(
      { event: "PostToolUse", command: path.join(FIX_DIR, "exit2-nonblocking.sh") },
      "exit2-nonblocking.sh",
    );
    const out = await runSingleHook(hook, postToolUseEvent(), "s-1");
    expect(out.decision).toBe("neutral");
    expect(out.exitCode).toBe(2);
    expect(out.warn ?? "").toContain("exit 2 on non-blocking");
  });

  bashIt("allow decision on Notification (non-blocking) → neutral + warn", async () => {
    const hook: CompiledHook = compile(
      { event: "Notification", command: path.join(FIX_DIR, "allow-on-notification.sh") },
      "allow-on-notification.sh",
    );
    const out = await runSingleHook(hook, notificationEvent(), "s-1");
    expect(out.decision).toBe("neutral");
    expect(out.warn ?? "").toContain("non-blocking");
  });

  bashIt("malformed stdout on exit 0 → neutral + warn", async () => {
    const hook = bashHook("malformed.sh");
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("neutral");
    expect(out.warn ?? "").toContain("invalid JSON");
  });

  bashIt("non-zero non-2 exit → neutral + warn", async () => {
    const hook = bashHook("nonzero.sh");
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("neutral");
    expect(out.exitCode).toBe(7);
    expect(out.warn ?? "").toContain("non-zero exit 7");
  });
});

describe("runSingleHook — timeout & output caps", () => {
  bashIt(
    "timeout → neutral, timedOut=true, exitCode=null, warn includes timeout",
    async () => {
      const hook = bashHook("sleep.sh", { timeout: 300 });
      const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
      expect(out.decision).toBe("neutral");
      expect(out.timedOut).toBe(true);
      expect(out.exitCode).toBeNull();
      expect(out.warn ?? "").toContain("timeout");
    },
    10_000,
  );

  bashIt(
    "stdout cap truncates big.sh output",
    async () => {
      const hook = bashHook("big.sh");
      const out = await runSingleHook(hook, preToolUseEvent(), "s-1", {
        maxOutputBytes: 10 * 1024,
      });
      expect(out.stdoutTruncated).toBe(true);
      // big.sh emits plain 'a' bytes which aren't valid JSON → neutral + warn.
      expect(out.decision).toBe("neutral");
    },
    10_000,
  );
});

describe("runSingleHook — abort & spawn errors", () => {
  bashIt(
    "pre-aborted AbortSignal → neutral + timedOut",
    async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const hook = bashHook("sleep.sh", { timeout: 60_000 });
      const out = await runSingleHook(hook, preToolUseEvent(), "s-1", { signal: ctrl.signal });
      expect(out.decision).toBe("neutral");
      expect(out.timedOut).toBe(true);
      expect(out.exitCode).toBeNull();
    },
    10_000,
  );

  it("spawn failure on nonexistent command → neutral + warn with spawn failed", async () => {
    const hook: CompiledHook = compile(
      { event: "PreToolUse", command: "/nonexistent/definitely-not-here-xyz" },
      "nope",
    );
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("neutral");
    expect(out.exitCode).toBeNull();
    expect(out.warn ?? "").toContain("spawn failed");
  });
});

describe("runSingleHook — command path warnings & portability", () => {
  it("relative PATH-resolved command carries PATH warning", async () => {
    // Use `true` / `false` if available; fall back to node -e on Windows.
    const hook: CompiledHook = compile(
      {
        event: "PreToolUse",
        command: HAS_BASH ? "true" : process.execPath,
        args: HAS_BASH ? [] : ["-e", ""],
      },
      "relative-true",
    );
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    // Decision is neutral (no JSON), but the PATH warning must surface.
    expect(out.decision).toBe("neutral");
    if (HAS_BASH) {
      expect(out.warn ?? "").toMatch(/PATH/);
    }
  });

  it("node one-liner is shell-agnostic (runner does not require bash)", async () => {
    const hook: CompiledHook = compile(
      {
        event: "PreToolUse",
        command: process.execPath,
        args: ["-e", 'process.stdout.write(\'{"decision":"allow"}\')'],
      },
      "node-allow",
    );
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(out.decision).toBe("allow");
    expect(out.exitCode).toBe(0);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("durationMs is always a finite non-negative number", async () => {
    const hook: CompiledHook = compile(
      { event: "PreToolUse", command: "/definitely/missing/xyzzy" },
      "missing",
    );
    const out = await runSingleHook(hook, preToolUseEvent(), "s-1");
    expect(Number.isFinite(out.durationMs)).toBe(true);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });
});

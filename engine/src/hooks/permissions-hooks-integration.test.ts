/**
 * End-to-end integration test — hooks + permissions.
 *
 * Wires the real `HookRegistry` + `runHooks` + `decideWithHooks` together
 * using a tiny bash script fixture as the hook command. Confirms that
 * the three owners (runner / registry / permissions) compose correctly.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decideWithHooks } from "../permissions/engine.js";
import { compilePermissions } from "../permissions/rules.js";
import type { PermissionAuditEntry, ToolCall } from "../permissions/types.js";
import { HookRegistry, runHooks } from "./registry.js";
import type { HookConfig, HookEvent, HookRunResult } from "./types.js";

/**
 * Shell-script hook fixture. Body is inlined into a chmod+x file.
 * The script reads JSON from stdin, inspects the tool name via `jq`-free
 * text matching, and writes a decision JSON to stdout.
 */
function writeHookScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  chmodSync(path, 0o700);
  return path;
}

describe("permissions <-> hooks end-to-end", () => {
  let tmp: string;
  let denyRmScript: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jc-e2e-hooks-"));
    // Reads stdin JSON; if payload.toolName === "Bash" AND input.command
    // contains "rm ", emit deny; otherwise neutral (empty stdout).
    denyRmScript = writeHookScript(
      tmp,
      "deny-rm.sh",
      `
INPUT="$(cat)"
if echo "$INPUT" | grep -q '"toolName":"Bash"'; then
  if echo "$INPUT" | grep -qE '"command":"rm '; then
    echo '{"decision":"deny","reason":"rm blocked by policy"}'
    exit 0
  fi
fi
# neutral
exit 0
      `.trim(),
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeHookAdapter(registry: HookRegistry, sessionId: string) {
    return (call: ToolCall): Promise<HookRunResult<"PreToolUse">> => {
      const event: HookEvent & { readonly kind: "PreToolUse" } = {
        kind: "PreToolUse",
        payload: {
          sessionId,
          toolName: call.name,
          toolInput: call.input,
          callId: "c1",
        },
      };
      const hooks = registry.hooksFor(event);
      return runHooks({ event, sessionId, hooks });
    };
  }

  it("denies Bash(rm ...) via hook even when a rule allows Bash", async () => {
    const config: HookConfig = {
      event: "PreToolUse",
      command: "/bin/bash",
      args: [denyRmScript],
      name: "deny-rm",
    };
    const registry = new HookRegistry([config]);
    const entries: PermissionAuditEntry[] = [];

    const decision = await decideWithHooks({
      call: { name: "Bash", input: { command: "rm -rf tmp" } },
      permissions: compilePermissions({ mode: "default", allow: ["Bash"] }),
      sessionId: "s1",
      audit: (e) => entries.push(e),
      preToolHook: makeHookAdapter(registry, "s1"),
    });

    expect(decision).toBe("deny");
    expect(entries.at(-1)?.reason).toContain("hook:deny-rm");
  });

  it("allows a benign Bash call through the same hook", async () => {
    const config: HookConfig = {
      event: "PreToolUse",
      command: "/bin/bash",
      args: [denyRmScript],
      name: "deny-rm",
    };
    const registry = new HookRegistry([config]);
    const entries: PermissionAuditEntry[] = [];

    const decision = await decideWithHooks({
      call: { name: "Bash", input: { command: "echo safe" } },
      permissions: compilePermissions({ mode: "default", allow: ["Bash"] }),
      sessionId: "s1",
      audit: (e) => entries.push(e),
      preToolHook: makeHookAdapter(registry, "s1"),
    });

    expect(decision).toBe("allow");
  });

  it("hook deny overrides bypassPermissions mode (belt-and-suspenders)", async () => {
    const config: HookConfig = {
      event: "PreToolUse",
      command: "/bin/bash",
      args: [denyRmScript],
      name: "deny-rm",
    };
    const registry = new HookRegistry([config]);
    const entries: PermissionAuditEntry[] = [];

    const decision = await decideWithHooks({
      call: { name: "Bash", input: { command: "rm -rf /" } },
      permissions: compilePermissions({ mode: "bypassPermissions" }),
      sessionId: "s1",
      audit: (e) => entries.push(e),
      preToolHook: makeHookAdapter(registry, "s1"),
    });

    expect(decision).toBe("deny");
  });

  it("registry with no hooks = passthrough to plain decide()", async () => {
    const registry = new HookRegistry([]);
    const decision = await decideWithHooks({
      call: { name: "Read", input: { file_path: "x" } },
      permissions: compilePermissions({ mode: "default" }),
      sessionId: "s1",
      preToolHook: makeHookAdapter(registry, "s1"),
    });
    expect(decision).toBe("allow");
  });
});

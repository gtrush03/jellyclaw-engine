/**
 * Permissions-matrix dump — runnable via:
 *
 *   bun run tsx engine/scripts/permissions-matrix.ts
 *
 * Iterates every (mode × tool × rule-scenario) tuple that matters for Phase
 * 08 and prints the engine's decision + the audit reason. Doubles as a
 * manual smoke test and the artifact referenced in the phase prompt.
 */

import { decide } from "../src/permissions/engine.js";
import { compilePermissions } from "../src/permissions/rules.js";
import type {
  AskHandler,
  PermissionAuditEntry,
  PermissionMode,
  ToolCall,
} from "../src/permissions/types.js";

interface Scenario {
  readonly label: string;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly mcpTools?: Readonly<Record<string, "readonly">>;
}

const modes: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];

const calls: readonly ToolCall[] = [
  { name: "Read", input: { file_path: "a" } },
  { name: "Bash", input: { command: "ls" } },
  { name: "Bash", input: { command: "rm -rf /" } },
  { name: "Write", input: { file_path: "src/a" } },
  { name: "Write", input: { file_path: "/etc/passwd" } },
  { name: "mcp__github__get_issue", input: { number: 1 } },
  { name: "mcp__github__create_issue", input: { title: "x" } },
  { name: "WebFetch", input: { url: "https://x" } },
];

const scenarios: readonly Scenario[] = [
  { label: "empty" },
  { label: "denylist-rm", deny: ["Bash(rm *)"] },
  { label: "mixed-bash", allow: ["Bash"], deny: ["Bash(rm *)"] },
  {
    label: "plan-mcp-readonly",
    mcpTools: { mcp__github__get_issue: "readonly" },
  },
];

const denyingAsk: AskHandler = async () => "deny";

function describe(call: ToolCall): string {
  const key = call.input["command"] ?? call.input["file_path"] ?? call.input["url"] ?? "";
  return `${call.name}(${String(key)})`.slice(0, 36).padEnd(36);
}

async function main(): Promise<void> {
  const header = `${"mode".padEnd(18)}${"scenario".padEnd(22)}${"call".padEnd(38)}${"decision".padEnd(10)}reason`;
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${"-".repeat(header.length)}\n`);

  for (const mode of modes) {
    for (const scenario of scenarios) {
      const perms = compilePermissions({
        mode,
        ...(scenario.allow ? { allow: scenario.allow } : {}),
        ...(scenario.deny ? { deny: scenario.deny } : {}),
        ...(scenario.ask ? { ask: scenario.ask } : {}),
        ...(scenario.mcpTools ? { mcpTools: scenario.mcpTools } : {}),
      });

      for (const call of calls) {
        const entries: PermissionAuditEntry[] = [];
        const decision = await decide({
          call,
          permissions: perms,
          sessionId: "matrix",
          askHandler: denyingAsk,
          audit: (e) => entries.push(e),
        });
        const reason = entries[0]?.reason ?? "";
        const row = `${mode.padEnd(18)}${scenario.label.padEnd(22)}${describe(call)}  ${decision.padEnd(8)}${reason}`;
        process.stdout.write(`${row}\n`);
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(`matrix failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

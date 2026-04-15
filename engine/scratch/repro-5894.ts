#!/usr/bin/env tsx
/**
 * repro-5894.ts — phase-01 verification harness for issue #5894.
 *
 * Context. Issue #5894 reported that `tool.execute.before/after` hooks skip
 * subagent tool calls. Our research (engine/opencode-research-notes.md §3)
 * found that v1.4.5 DOES fire hooks for subagent tool calls because plugins
 * are Instance-scoped; the real gap is that the hook envelope carries no
 * `agent` / `parentSessionID` / `agentChain` identity.
 *
 * This reproducer exercises our two Phase-01 controls — `agent-context`
 * envelope enrichment and `secret-scrub` redaction — against synthetic hook
 * envelopes that mirror what opencode fires in practice. A full live
 * subagent-spawn test needs real `task` tool dispatch which lands in
 * Phase 06; Phase 01 only proves the plumbing.
 *
 * Run: `bun run engine/scratch/repro-5894.ts`
 * Expected last line: `OK: repro-5894 passed`.
 */

import { strict as assert } from "node:assert";
import {
  createCachedResolver,
  enrichHookEnvelope,
  type SessionResolver,
  type ToolHookEnvelope,
} from "../src/plugin/agent-context.js";
import { scrubToolResult } from "../src/plugin/secret-scrub.js";

type Case = { name: string; run: () => Promise<void> };

const cases: Case[] = [
  {
    name: "root call — agent present, empty chain",
    async run() {
      const resolver: SessionResolver = {
        // biome-ignore lint/suspicious/useAwait: implements Promise-returning SessionResolver interface
        async getSession(id) {
          if (id === "root") return { agentName: "general", parentSessionID: undefined };
          return undefined;
        },
      };
      const envelope: ToolHookEnvelope = { tool: "bash", sessionID: "root", callID: "c1" };
      const out = await enrichHookEnvelope(envelope, resolver);
      assert.equal(out.agent, "general");
      assert.equal(out.parentSessionID, undefined);
      assert.deepEqual(out.agentChain, []);
    },
  },
  {
    name: "two-level subagent — agent chain is root-first",
    async run() {
      const table: Record<string, { agentName: string; parentSessionID: string | undefined }> = {
        A: { agentName: "general", parentSessionID: undefined },
        B: { agentName: "reviewer", parentSessionID: "A" },
        C: { agentName: "fixer", parentSessionID: "B" },
      };
      const resolver = createCachedResolver({
        // biome-ignore lint/suspicious/useAwait: implements Promise-returning SessionResolver interface
        async getSession(id) {
          return table[id];
        },
      });
      const envelope: ToolHookEnvelope = { tool: "read", sessionID: "C", callID: "c42" };
      const out = await enrichHookEnvelope(envelope, resolver);
      assert.equal(out.agent, "fixer");
      assert.equal(out.parentSessionID, "B");
      assert.deepEqual(out.agentChain, ["A", "B"]);
    },
  },
  {
    name: "scrub — tool result with Anthropic key + env line is redacted",
    // biome-ignore lint/suspicious/useAwait: run() conforms to Case interface (Promise<void>)
    async run() {
      const toolResult = {
        output: [
          "Loaded config:",
          "ANTHROPIC_API_KEY=sk-ant-zxyw1234567890abcdefghij",
          "done.",
        ].join("\n"),
        meta: { cwd: "/tmp" },
      };
      const scrubbed = scrubToolResult(toolResult);
      assert.ok(!scrubbed.output.includes("sk-ant-zxyw1234567890abcdefghij"));
      assert.ok(scrubbed.output.includes("[REDACTED:"));
      assert.equal(scrubbed.meta.cwd, "/tmp");
    },
  },
  {
    name: "scrub — extra literal (server password) is redacted",
    async run() {
      const { scrubSecrets } = await import("../src/plugin/secret-scrub.js");
      const password = "deadbeefcafefeed".repeat(4); // 64 chars, mimics our minted token
      const blob = `auth token seen in stack trace: ${password}`;
      const out = scrubSecrets(blob, undefined, { extraLiterals: [password] });
      assert.ok(!out.includes(password));
      assert.ok(out.includes("[REDACTED:literal]"));
    },
  },
];

async function main() {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      process.stdout.write(`  ✓ ${c.name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`  ✗ ${c.name}\n`);
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  }
  if (failed > 0) {
    process.stderr.write(`FAIL: repro-5894 — ${failed}/${cases.length} cases failed\n`);
    process.exit(1);
  }
  process.stdout.write(`OK: repro-5894 passed (${cases.length}/${cases.length} cases)\n`);
}

main().catch((err) => {
  process.stderr.write(`repro-5894 crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});

/**
 * WebSearch tool — stub.
 *
 * jellyclaw does not ship a built-in web-search backend. The model still
 * expects a `WebSearch` tool to exist for parity with Claude Code, so we
 * register a stub that unconditionally throws `WebSearchNotConfiguredError`.
 * Consumers wire a real search MCP (tavily-mcp,
 * @modelcontextprotocol/server-brave-search, etc.) via `jellyclaw.json` and
 * that MCP tool shadows this stub — see docs/tools.md#websearch.
 */

import { z } from "zod";

import websearchSchema from "../../../test/fixtures/tools/claude-code-schemas/websearch.json" with {
  type: "json",
};

import { type JsonSchema, type Tool, WebSearchNotConfiguredError } from "./types.js";

export const websearchInputSchema = z.object({
  query: z.string().min(2),
  allowed_domains: z.array(z.string()).optional(),
  blocked_domains: z.array(z.string()).optional(),
});

export type WebsearchInput = z.input<typeof websearchInputSchema>;
export type WebsearchOutput = never;

export const websearchTool: Tool<WebsearchInput, WebsearchOutput> = {
  name: "WebSearch",
  description:
    "Stub for WebSearch. jellyclaw does not ship a built-in search backend — configure a search MCP (e.g. tavily-mcp, @modelcontextprotocol/server-brave-search) in your jellyclaw.json. Calling this tool always throws WebSearchNotConfiguredError so the model gets a clear actionable error.",
  inputSchema: websearchSchema as JsonSchema,
  zodSchema: websearchInputSchema as unknown as z.ZodType<WebsearchInput>,
  overridesOpenCode: true,
  // biome-ignore lint/suspicious/useAwait: Tool.handler contract is async; the stub throws synchronously.
  async handler(_input, _ctx) {
    throw new WebSearchNotConfiguredError();
  },
};

// ---------------------------------------------------------------------------
// One-time registration warning
// ---------------------------------------------------------------------------
//
// The spec calls for a single logger warning emitted the first time the
// WebSearch stub is registered/listed. We expose it as a helper rather than
// firing it at module load — that would pollute library consumers and tests
// with side effects on every `import`. The engine bootstrap (Phase 10) wires
// this up; until then we exercise it directly via tests.

let warned = false;

export function emitWebSearchRegistrationWarning(logger: {
  warn: (...args: unknown[]) => void;
}): void {
  if (warned) return;
  if (process.env.JELLYCLAW_WARN_WEBSEARCH === "false") return;
  warned = true;
  logger.warn(
    { tool: "WebSearch" },
    "WebSearch is registered as a stub. Configure a search MCP to enable.",
  );
}

/** Test helper — resets the one-shot latch. Not part of the public API. */
export function _resetWebSearchWarning(): void {
  warned = false;
}

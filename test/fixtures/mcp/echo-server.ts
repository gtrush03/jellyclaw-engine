#!/usr/bin/env bun
/**
 * Trivial stdio MCP server used by Phase 07 tests. Exposes a single tool
 * `echo` that returns whatever `{ msg: string }` it was called with.
 *
 * Runnable standalone for manual smoke:
 *   bun run test/fixtures/mcp/echo-server.ts
 *
 * The server sleeps on stdin; the `jellyclaw` stdio client connects to
 * it via `child_process.spawn`. It MUST NOT print anything on stdout
 * that is not a well-formed JSON-RPC line — any stray `console.log`
 * here will break the transport. Diagnostic output goes to stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-server", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

// MCP SDK request handlers are typed as `async` by the SDK; we return
// a resolved promise to satisfy the signature without a bare `async`.
server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "echo",
        description: "Echoes its {msg} argument back verbatim.",
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
          additionalProperties: false,
        },
      },
    ],
  }),
);

server.setRequestHandler(CallToolRequestSchema, (req) => {
  if (req.params.name !== "echo") {
    return Promise.resolve({
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
    });
  }
  const msg = (req.params.arguments as { msg?: unknown } | undefined)?.msg;
  if (typeof msg !== "string") {
    return Promise.resolve({
      isError: true,
      content: [{ type: "text", text: "missing or non-string 'msg' argument" }],
    });
  }
  return Promise.resolve({
    content: [{ type: "text", text: JSON.stringify({ msg }) }],
    structuredContent: { msg },
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Keep the process alive. The transport tracks stdin close and will
// call process.exit itself on disconnect.

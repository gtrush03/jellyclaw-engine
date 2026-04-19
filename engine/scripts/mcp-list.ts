#!/usr/bin/env bun
/**
 * Dev smoke script: connect all MCP servers declared in
 * `<cwd>/jellyclaw.json` or `~/.jellyclaw/jellyclaw.json` and print the
 * live tool list, namespaced.
 *
 *   bun run tsx engine/scripts/mcp-list.ts
 *
 * Output is intentionally stable for human eyeballing — NOT a structured
 * format. Not part of the public API.
 */

import { pino } from "pino";

import { loadMcpConfigs } from "../src/cli/mcp-config-loader.js";
import { McpRegistry } from "../src/mcp/registry.js";

const logger = pino({
  level: process.env.JELLYCLAW_LOG_LEVEL ?? "warn",
  transport: process.stdout.isTTY ? { target: "pino-pretty" } : undefined,
});

const configs = await loadMcpConfigs({ cwd: process.cwd(), logger });

if (configs.length === 0) {
  process.stderr.write("no MCP servers configured\n");
  process.exit(0);
}

// Use the registry's default factory, which dispatches to
// stdio / http / sse based on the config's `transport` discriminant.
const registry = new McpRegistry({ logger });

await registry.start(configs);

const snapshot = registry.snapshot();
process.stderr.write(
  `mcp: ${snapshot.live.length} live, ${snapshot.dead.length} dead, ${snapshot.retrying.length} retrying\n`,
);

for (const tool of registry.listTools()) {
  process.stdout.write(`${tool.namespacedName}\n`);
}

await registry.stop();

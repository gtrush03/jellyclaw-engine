#!/usr/bin/env bun
/**
 * Dev smoke script: connect all MCP servers declared in
 * `~/.jellyclaw/jellyclaw.json` (or `$JELLYCLAW_CONFIG`) and print the
 * live tool list, namespaced.
 *
 *   bun run tsx engine/scripts/mcp-list.ts
 *
 * Output is intentionally stable for human eyeballing — NOT a structured
 * format. Not part of the public API.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pino } from "pino";

import { createStdioMcpClient } from "../src/mcp/client-stdio.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { McpServerConfig, StdioMcpServerConfig } from "../src/mcp/types.js";

const logger = pino({
  level: process.env.JELLYCLAW_LOG_LEVEL ?? "warn",
  transport: process.stdout.isTTY ? { target: "pino-pretty" } : undefined,
});

const configPath =
  process.env.JELLYCLAW_CONFIG ?? resolve(homedir(), ".jellyclaw", "jellyclaw.json");

const raw = JSON.parse(await readFile(configPath, "utf8")) as {
  mcp?: Record<string, Omit<StdioMcpServerConfig, "name">>;
};

const configs: McpServerConfig[] = Object.entries(raw.mcp ?? {}).map(([name, cfg]) => ({
  ...cfg,
  name,
  transport: "stdio",
}));

if (configs.length === 0) {
  process.stderr.write(`no MCP servers configured in ${configPath}\n`);
  process.exit(0);
}

const registry = new McpRegistry({
  logger,
  clientFactory: (config, opts) => {
    if (config.transport !== "stdio") {
      throw new Error(`only stdio transport is supported in this build`);
    }
    return createStdioMcpClient(config, opts);
  },
});

await registry.start(configs);

const snapshot = registry.snapshot();
process.stderr.write(
  `mcp: ${snapshot.live.length} live, ${snapshot.dead.length} dead, ${snapshot.retrying.length} retrying\n`,
);

for (const tool of registry.listTools()) {
  process.stdout.write(`${tool.namespacedName}\n`);
}

await registry.stop();

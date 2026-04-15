/**
 * One-off smoke script: discover + load agents from the default roots,
 * print a JSON summary to stdout. Not wired into the CLI yet.
 *
 *   bun run engine/scripts/agents-dump.ts
 *
 * NOTE: This imports from `../src/agents/index.js`, a barrel module being
 * created in parallel by the registry agent for Phase 06 Prompt 01. If the
 * barrel has not landed yet, this script will fail to resolve until it does —
 * that is expected and intentional.
 */

import { AgentRegistry } from "../src/agents/index.js";

const registry = new AgentRegistry();
await registry.loadAll();

const agents = registry.list();
const summary = agents.map((a) => ({
  name: a.name,
  source: a.source,
  path: a.path,
  mode: a.frontmatter.mode,
  tools: a.frontmatter.tools ?? null,
  max_turns: a.frontmatter.max_turns,
}));

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

/**
 * Agent discovery — walks the three search roots in order and returns
 * a list of `AgentFile` entries (path + name + source). Does NOT parse
 * the files or enforce uniqueness across sources; that is the registry's
 * job. Supports both `<root>/<name>/AGENT.md` (dir-per-agent) and
 * `<root>/<name>.md` (flat). Dir-per-agent wins when both exist for
 * the same name within a single root.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentFile, AgentSource } from "./types.js";

export interface DiscoveryOptions {
  /** Overrides for test fixtures. When set, `cwd` and `home` fields are ignored. */
  readonly roots?: ReadonlyArray<{ path: string; source: AgentSource }>;
  /** Defaults to `process.cwd()`. Used to resolve project + legacy roots. */
  readonly cwd?: string;
  /** Defaults to `os.homedir()`. Used to resolve the user root. */
  readonly home?: string;
}

export function defaultRoots(
  cwd: string,
  home: string,
): ReadonlyArray<{ path: string; source: AgentSource }> {
  return [
    { path: join(home, ".jellyclaw", "agents"), source: "user" },
    { path: resolve(cwd, ".jellyclaw", "agents"), source: "project" },
    { path: resolve(cwd, ".claude", "agents"), source: "legacy" },
  ];
}

/**
 * Discover agent files across all configured roots. Returned entries are
 * deterministically sorted: first by source (input order), then by name
 * (alphabetic) within each root.
 */
export function discoverAgents(opts: DiscoveryOptions = {}): AgentFile[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const roots = opts.roots ?? defaultRoots(cwd, home);

  const out: AgentFile[] = [];
  for (const { path: rootPath, source } of roots) {
    if (!existsSync(rootPath)) continue;
    for (const entry of listAgentFiles(rootPath, source)) out.push(entry);
  }
  return out;
}

function listAgentFiles(rootPath: string, source: AgentSource): AgentFile[] {
  const seenNames = new Set<string>();
  const out: AgentFile[] = [];

  let entries: string[];
  try {
    entries = readdirSync(rootPath);
  } catch {
    return out;
  }
  entries.sort();

  // Pass 1: dir-per-agent (<root>/<name>/AGENT.md). These win on collision.
  for (const name of entries) {
    if (!isValidAgentName(name)) continue;
    const dirPath = join(rootPath, name);
    let isDir = false;
    try {
      isDir = statSync(dirPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const agentMd = join(dirPath, "AGENT.md");
    if (!existsSync(agentMd)) continue;
    out.push({ name, path: agentMd, source });
    seenNames.add(name);
  }

  // Pass 2: flat (<root>/<name>.md). Only if the name is not already claimed.
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (!isValidAgentName(name)) continue;
    if (seenNames.has(name)) continue;
    const filePath = join(rootPath, entry);
    let isFile = false;
    try {
      isFile = statSync(filePath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    out.push({ name, path: filePath, source });
    seenNames.add(name);
  }

  return out;
}

function isValidAgentName(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name);
}

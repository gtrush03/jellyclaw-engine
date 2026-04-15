/**
 * Skill discovery — walks the three search roots in order and returns
 * a list of `SkillFile` entries (path + name + source). Does NOT parse
 * the files or enforce uniqueness across sources; that is the registry's
 * job. Supports both `<root>/<name>/SKILL.md` (dir-per-skill) and
 * `<root>/<name>.md` (flat). Dir-per-skill wins when both exist for
 * the same name within a single root.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillFile, SkillSource } from "./types.js";

export interface DiscoveryOptions {
  /** Overrides for test fixtures. When set, `cwd` and `home` fields are ignored. */
  readonly roots?: ReadonlyArray<{ path: string; source: SkillSource }>;
  /** Defaults to `process.cwd()`. Used to resolve project + legacy roots. */
  readonly cwd?: string;
  /** Defaults to `os.homedir()`. Used to resolve the user root. */
  readonly home?: string;
}

export function defaultRoots(
  cwd: string,
  home: string,
): ReadonlyArray<{ path: string; source: SkillSource }> {
  return [
    { path: join(home, ".jellyclaw", "skills"), source: "user" },
    { path: resolve(cwd, ".jellyclaw", "skills"), source: "project" },
    { path: resolve(cwd, ".claude", "skills"), source: "legacy" },
  ];
}

/**
 * Discover skill files across all configured roots. Returned entries are
 * deterministically sorted: first by source (input order), then by name
 * (alphabetic) within each root.
 */
export function discoverSkills(opts: DiscoveryOptions = {}): SkillFile[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const roots = opts.roots ?? defaultRoots(cwd, home);

  const out: SkillFile[] = [];
  for (const { path: rootPath, source } of roots) {
    if (!existsSync(rootPath)) continue;
    for (const entry of listSkillFiles(rootPath, source)) out.push(entry);
  }
  return out;
}

function listSkillFiles(rootPath: string, source: SkillSource): SkillFile[] {
  const seenNames = new Set<string>();
  const out: SkillFile[] = [];

  let entries: string[];
  try {
    entries = readdirSync(rootPath);
  } catch {
    return out;
  }
  entries.sort();

  // Pass 1: dir-per-skill (<root>/<name>/SKILL.md). These win on collision.
  for (const name of entries) {
    if (!isValidSkillName(name)) continue;
    const dirPath = join(rootPath, name);
    let isDir = false;
    try {
      isDir = statSync(dirPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skillMd = join(dirPath, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    out.push({ name, path: skillMd, source });
    seenNames.add(name);
  }

  // Pass 2: flat (<root>/<name>.md). Only if the name is not already claimed.
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (!isValidSkillName(name)) continue;
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

function isValidSkillName(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name);
}

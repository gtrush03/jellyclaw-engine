/**
 * `jellyclaw skills list` — Phase 10.01.
 *
 * Loads skills via `SkillRegistry.loadAll()` using the default discovery
 * roots (user → project → legacy) and prints a simple three-column table:
 *
 *   NAME  SOURCE  DESCRIPTION
 *
 * Description is truncated to keep rows readable; the registry stores the
 * full description on each `Skill` for programmatic consumers.
 *
 * The action exits 0 even when no skills are registered — an empty
 * environment is a valid state, not a failure.
 */

import { homedir } from "node:os";
import type { DiscoveryOptions } from "../skills/discovery.js";
import { defaultRoots } from "../skills/discovery.js";
import { SkillRegistry } from "../skills/registry.js";
import type { Skill } from "../skills/types.js";

export interface SkillsListDeps {
  readonly cwd?: string;
  readonly home?: string;
  readonly roots?: DiscoveryOptions["roots"];
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  /** Injectable registry factory for tests. */
  readonly registryFactory?: () => {
    loadAll(opts?: DiscoveryOptions): Promise<void>;
    list(): Skill[];
  };
}

const NAME_WIDTH = 28;
const SOURCE_WIDTH = 8;
const DESCRIPTION_WIDTH = 80;

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function padRight(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

function formatRow(name: string, source: string, description: string): string {
  return [
    padRight(truncate(name, NAME_WIDTH), NAME_WIDTH),
    padRight(truncate(source, SOURCE_WIDTH), SOURCE_WIDTH),
    truncate(description.replace(/\s+/g, " ").trim(), DESCRIPTION_WIDTH),
  ].join("  ");
}

export async function skillsListAction(deps: SkillsListDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();

  const registry = deps.registryFactory ? deps.registryFactory() : new SkillRegistry();

  try {
    const loadOpts: DiscoveryOptions = deps.roots
      ? { roots: deps.roots }
      : { roots: defaultRoots(cwd, home) };
    await registry.loadAll(loadOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`skills list: ${message}\n`);
    return 1;
  }

  const skills = registry.list();
  if (skills.length === 0) {
    stdout.write("no skills found\n");
    return 0;
  }

  stdout.write(`${formatRow("NAME", "SOURCE", "DESCRIPTION")}\n`);
  for (const skill of skills) {
    stdout.write(`${formatRow(skill.name, skill.source, skill.frontmatter.description)}\n`);
  }
  return 0;
}

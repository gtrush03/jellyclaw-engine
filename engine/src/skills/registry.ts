/**
 * In-memory skill registry. First-wins across `user → project → legacy`
 * search roots. Duplicates within a single root are a parse error that
 * the registry drops with a warn log; duplicates across roots are a
 * shadow that the registry drops with a warn log listing the shadowed
 * path.
 *
 * Prompt 01 scope: discovery + parse + index. Progressive disclosure
 * and `$ARGUMENTS` substitution land in prompt 02; filesystem watching
 * lands in prompt 02 as well.
 */

import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger.js";
import { type DiscoveryOptions, discoverSkills } from "./discovery.js";
import { parseSkillFile } from "./parser.js";
import { type Skill, SkillLoadError } from "./types.js";

export interface LoadAllOptions extends DiscoveryOptions {
  readonly logger?: Logger;
}

export class SkillRegistry {
  #skills = new Map<string, Skill>();

  // biome-ignore lint/suspicious/useAwait: async contract is stable across prompts — prompt 02 adds chokidar watch setup here.
  async loadAll(opts: LoadAllOptions = {}): Promise<void> {
    const log = opts.logger ?? defaultLogger;
    this.#skills.clear();

    const files = discoverSkills(opts);

    for (const file of files) {
      const existing = this.#skills.get(file.name);
      if (existing) {
        log.warn(
          {
            name: file.name,
            kept: existing.path,
            shadowed: file.path,
            keptSource: existing.source,
            shadowedSource: file.source,
          },
          "skill shadowed by earlier source",
        );
        continue;
      }

      try {
        const skill = parseSkillFile({
          path: file.path,
          source: file.source,
          expectedName: file.name,
        });
        this.#skills.set(skill.name, skill);
      } catch (err) {
        if (err instanceof SkillLoadError) {
          log.warn({ path: err.path, reason: err.reason }, "skill failed to load");
          continue;
        }
        throw err;
      }
    }
  }

  list(): Skill[] {
    return [...this.#skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  /** Test-only: number of successfully loaded skills. */
  size(): number {
    return this.#skills.size;
  }
}

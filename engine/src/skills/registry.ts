/**
 * In-memory skill registry. First-wins across `user → project → legacy`
 * search roots. Duplicates within a single root are a parse error that
 * the registry drops with a warn log; duplicates across roots are a
 * shadow that the registry drops with a warn log listing the shadowed
 * path.
 *
 * Prompt 02 adds `reload()` + `subscribe()` so the filesystem watcher
 * (see `watcher.ts`) can trigger re-discovery and publish a diff to
 * consumers. The underlying `loadAll` semantics are unchanged.
 */

import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger.js";
import { type DiscoveryOptions, discoverSkills } from "./discovery.js";
import { parseSkillFile } from "./parser.js";
import { type Skill, SkillLoadError } from "./types.js";

export interface LoadAllOptions extends DiscoveryOptions {
  readonly logger?: Logger;
}

export interface SkillsChangedEvent {
  readonly added: string[];
  readonly removed: string[];
  readonly modified: string[];
}

export type SkillsListener = (event: SkillsChangedEvent) => void;

interface Snapshot {
  readonly path: string;
  readonly mtimeMs: number;
}

export class SkillRegistry {
  #skills = new Map<string, Skill>();
  #listeners = new Set<SkillsListener>();
  #lastOpts: LoadAllOptions | undefined;

  // biome-ignore lint/suspicious/useAwait: async contract is stable across prompts — prompt 02 adds chokidar watch setup here.
  async loadAll(opts: LoadAllOptions = {}): Promise<void> {
    const log = opts.logger ?? defaultLogger;
    this.#lastOpts = opts;
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

  /**
   * Re-run discovery and compute a diff versus the previous snapshot.
   * Subscribers are notified synchronously before the returned promise
   * resolves. If `loadAll` was never called, the previous snapshot is
   * treated as empty (so everything present becomes `added`).
   */
  async reload(opts?: LoadAllOptions): Promise<SkillsChangedEvent> {
    const prev = this.#snapshot();
    const effective = opts ?? this.#lastOpts ?? {};
    await this.loadAll(effective);
    const next = this.#snapshot();
    const diff = computeDiff(prev, next);
    this.#emit(diff, effective.logger ?? defaultLogger);
    return diff;
  }

  /**
   * Subscribe to post-reload diffs. Returns an unsubscribe fn. Listener
   * errors are caught + logged and never propagated to the caller of
   * `reload()`.
   */
  subscribe(listener: SkillsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
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

  #snapshot(): Map<string, Snapshot> {
    const out = new Map<string, Snapshot>();
    for (const skill of this.#skills.values()) {
      out.set(skill.name, { path: skill.path, mtimeMs: skill.mtimeMs });
    }
    return out;
  }

  #emit(event: SkillsChangedEvent, log: Logger): void {
    // Snapshot listeners so unsubscribe-during-emit does not break the loop.
    const snapshot = [...this.#listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err }, "skill registry listener threw");
      }
    }
  }
}

function computeDiff(prev: Map<string, Snapshot>, next: Map<string, Snapshot>): SkillsChangedEvent {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [name, snap] of next) {
    const prior = prev.get(name);
    if (!prior) {
      added.push(name);
      continue;
    }
    if (prior.path !== snap.path || prior.mtimeMs !== snap.mtimeMs) {
      modified.push(name);
    }
  }
  for (const name of prev.keys()) {
    if (!next.has(name)) removed.push(name);
  }

  added.sort();
  removed.sort();
  modified.sort();
  return { added, removed, modified };
}

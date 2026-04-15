/**
 * In-memory subagent registry. First-wins across `user → project → legacy`
 * search roots. Duplicates within a single root are a parse error that
 * the registry drops with a warn log; duplicates across roots are a
 * shadow that the registry drops with a warn log listing the shadowed
 * path.
 *
 * Mirrors `../skills/registry.ts` — dispatch (Prompt 02) will plug into
 * `reload()` + `subscribe()` the same way the skills watcher does.
 */

import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger.js";
import { type DiscoveryOptions, discoverAgents } from "./discovery.js";
import { parseAgentFile } from "./parser.js";
import { type Agent, AgentLoadError } from "./types.js";

export interface LoadAllOptions extends DiscoveryOptions {
  readonly logger?: Logger;
}

export interface AgentsChangedEvent {
  readonly added: string[];
  readonly removed: string[];
  readonly modified: string[];
}

export type AgentsListener = (event: AgentsChangedEvent) => void;

interface Snapshot {
  readonly path: string;
  readonly mtimeMs: number;
}

export class AgentRegistry {
  #agents = new Map<string, Agent>();
  #listeners = new Set<AgentsListener>();
  #lastOpts: LoadAllOptions | undefined;

  // biome-ignore lint/suspicious/useAwait: async contract is stable across prompts — prompt 02 adds watch setup here.
  async loadAll(opts: LoadAllOptions = {}): Promise<void> {
    const log = opts.logger ?? defaultLogger;
    this.#lastOpts = opts;
    this.#agents.clear();

    const files = discoverAgents(opts);

    for (const file of files) {
      const existing = this.#agents.get(file.name);
      if (existing) {
        log.warn(
          {
            name: file.name,
            kept: existing.path,
            shadowed: file.path,
            keptSource: existing.source,
            shadowedSource: file.source,
          },
          "agent shadowed by earlier source",
        );
        continue;
      }

      try {
        const agent = parseAgentFile({
          path: file.path,
          source: file.source,
          expectedName: file.name,
        });
        this.#agents.set(agent.name, agent);
      } catch (err) {
        if (err instanceof AgentLoadError) {
          log.warn({ path: err.path, reason: err.reason }, "agent failed to load");
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
  async reload(opts?: LoadAllOptions): Promise<AgentsChangedEvent> {
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
  subscribe(listener: AgentsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  list(): Agent[] {
    return [...this.#agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Agent | undefined {
    return this.#agents.get(name);
  }

  /** Test-only: number of successfully loaded agents. */
  size(): number {
    return this.#agents.size;
  }

  #snapshot(): Map<string, Snapshot> {
    const out = new Map<string, Snapshot>();
    for (const agent of this.#agents.values()) {
      out.set(agent.name, { path: agent.path, mtimeMs: agent.mtimeMs });
    }
    return out;
  }

  #emit(event: AgentsChangedEvent, log: Logger): void {
    // Snapshot listeners so unsubscribe-during-emit does not break the loop.
    const snapshot = [...this.#listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err }, "agent registry listener threw");
      }
    }
  }
}

function computeDiff(prev: Map<string, Snapshot>, next: Map<string, Snapshot>): AgentsChangedEvent {
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

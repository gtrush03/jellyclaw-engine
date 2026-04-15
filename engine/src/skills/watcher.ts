/**
 * Filesystem watcher that keeps a `SkillRegistry` fresh.
 *
 * Watches the PARENT of each configured skill root so that the skills
 * directory itself can be created after `start()` and still trigger a
 * reload. Events are debounced (default 250 ms) and coalesced into a
 * single `registry.reload()` call — the registry emits the diff to its
 * own subscribers.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { type DiscoveryOptions, defaultRoots } from "./discovery.js";
import type { SkillRegistry } from "./registry.js";

export interface SkillWatcherOptions {
  readonly registry: SkillRegistry;
  readonly discovery?: DiscoveryOptions;
  readonly logger?: Logger;
  readonly debounceMs?: number;
  /** chokidar awaitWriteFinish stabilityThreshold. Default 100. */
  readonly stabilityThresholdMs?: number;
}

export class SkillWatcher {
  readonly #registry: SkillRegistry;
  readonly #discovery: DiscoveryOptions | undefined;
  readonly #log: Logger;
  readonly #debounceMs: number;
  readonly #stabilityMs: number;
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(opts: SkillWatcherOptions) {
    this.#registry = opts.registry;
    this.#discovery = opts.discovery;
    this.#log = opts.logger ?? defaultLogger;
    this.#debounceMs = opts.debounceMs ?? 250;
    this.#stabilityMs = opts.stabilityThresholdMs ?? 100;
  }

  async start(): Promise<void> {
    this.#stopped = false;

    const cwd = this.#discovery?.cwd ?? process.cwd();
    const home = this.#discovery?.home ?? homedir();
    const roots = this.#discovery?.roots ?? defaultRoots(cwd, home);

    const parents: string[] = [];
    for (const { path } of roots) {
      const parent = dirname(path);
      if (!existsSync(parent)) {
        this.#log.debug({ parent, skillRoot: path }, "skill watcher: parent missing, skipping");
        continue;
      }
      parents.push(parent);
    }

    if (parents.length === 0) {
      this.#log.debug("skill watcher: no parent dirs to watch");
      return;
    }

    const watcher = chokidar.watch(parents, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: {
        stabilityThreshold: this.#stabilityMs,
        pollInterval: 20,
      },
    });

    const trigger = (): void => {
      if (this.#stopped) return;
      this.#schedule();
    };

    watcher.on("add", trigger);
    watcher.on("change", trigger);
    watcher.on("unlink", trigger);
    watcher.on("addDir", trigger);
    watcher.on("unlinkDir", trigger);
    watcher.on("error", (err) => {
      this.#log.warn({ err }, "skill watcher error");
    });

    this.#watcher = watcher;

    // Wait for chokidar's initial scan so post-start events are real changes.
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const w = this.#watcher;
    this.#watcher = undefined;
    if (w) await w.close();
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#stopped) return;
      void this.#fire();
    }, this.#debounceMs);
  }

  async #fire(): Promise<void> {
    try {
      await this.#registry.reload(this.#discovery);
    } catch (err) {
      this.#log.warn({ err }, "skill watcher: reload failed");
    }
  }
}

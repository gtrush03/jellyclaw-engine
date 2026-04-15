/**
 * Filesystem layout helpers for the session store.
 *
 * Layout:
 *   ~/.jellyclaw/
 *     sessions/
 *       <project-hash>/          project-hash = sha1(realpath(cwd)).slice(0, 12)
 *         <session-id>.jsonl     primary durable log (written by Phase 09.02)
 *         <session-id>.meta.json denormalized quick summary
 *       index.sqlite             single DB shared across all projects
 *     wishes/
 *       <wish-id>.json           idempotency ledger (Phase 09.02)
 *
 * All functions are pure (no mkdir). Callers are responsible for ensuring
 * directories exist before writing. `SessionPaths` injects `home` so tests
 * never touch the real `~/.jellyclaw`.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionPathsOptions {
  /**
   * Root home directory. Defaults to `os.homedir()`. Tests override this to
   * a temp dir. Environment override via `JELLYCLAW_HOME` takes precedence.
   */
  home?: string;
}

export class SessionPaths {
  readonly home: string;

  constructor(options: SessionPathsOptions = {}) {
    this.home = options.home ?? process.env.JELLYCLAW_HOME ?? homedir();
  }

  /** Root data dir: `<home>/.jellyclaw`. */
  root(): string {
    return join(this.home, ".jellyclaw");
  }

  /** `<home>/.jellyclaw/sessions`. */
  sessionsRoot(): string {
    return join(this.root(), "sessions");
  }

  /** `<home>/.jellyclaw/sessions/index.sqlite`. */
  indexDb(): string {
    return join(this.sessionsRoot(), "index.sqlite");
  }

  /** `<home>/.jellyclaw/sessions/<project-hash>` directory. */
  projectDir(projectHash: string): string {
    return join(this.sessionsRoot(), projectHash);
  }

  /** `<home>/.jellyclaw/sessions/<project-hash>/<session-id>.jsonl`. */
  sessionLog(projectHash: string, sessionId: string): string {
    return join(this.projectDir(projectHash), `${sessionId}.jsonl`);
  }

  /** `<home>/.jellyclaw/sessions/<project-hash>/<session-id>.meta.json`. */
  sessionMeta(projectHash: string, sessionId: string): string {
    return join(this.projectDir(projectHash), `${sessionId}.meta.json`);
  }

  /** `<home>/.jellyclaw/wishes`. */
  wishesRoot(): string {
    return join(this.root(), "wishes");
  }

  /** `<home>/.jellyclaw/wishes/<wish-id>.json`. */
  wishFile(wishId: string): string {
    return join(this.wishesRoot(), `${wishId}.json`);
  }
}

/**
 * Compute the project-hash for a given cwd. SHA-1 over the path, 12-char hex
 * prefix. SHA-1 is fine here: this is not a security-sensitive digest, it's a
 * short stable bucket key. Callers should pass `realpath(cwd)` so symlinks
 * bucket consistently.
 */
export function projectHash(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

import path from "node:path";

/**
 * Single source of truth for every absolute path the server touches.
 * All paths are absolute and rooted at the jellyclaw-engine repository.
 */
export const REPO_ROOT = "/Users/gtrush/Downloads/jellyclaw-engine";
export const PROMPTS_DIR = path.join(REPO_ROOT, "prompts");
export const PHASES_DIR = path.join(REPO_ROOT, "phases");
export const COMPLETION_LOG = path.join(REPO_ROOT, "COMPLETION-LOG.md");
export const STATUS_FILE = path.join(REPO_ROOT, "STATUS.md");
export const SESSION_STARTERS_DIR = path.join(PROMPTS_DIR, "session-starters");
export const STARTUP_TEMPLATE = path.join(
  SESSION_STARTERS_DIR,
  "STARTUP-TEMPLATE.md",
);
export const COMPLETION_TEMPLATE = path.join(
  SESSION_STARTERS_DIR,
  "COMPLETION-UPDATE-TEMPLATE.md",
);

/**
 * Path-traversal guard. Refuses any path that escapes REPO_ROOT.
 * Returns the normalized absolute path on success; throws otherwise.
 */
export function assertInsideRepo(candidate: string): string {
  const resolved = path.resolve(candidate);
  const rootResolved = path.resolve(REPO_ROOT);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Path traversal blocked: ${candidate}`);
  }
  return resolved;
}

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

// ---------- autobuild-rig paths (read-only from the dashboard's POV) ----------
// The rig owns these directories. The dashboard observes via chokidar + fs.readFile.
// Any write we do for orchestration commands goes to `.orchestrator/inbox/`,
// NEVER to `.autobuild/` or the rest of `.orchestrator/`.
export const AUTOBUILD_DIR = path.join(REPO_ROOT, ".autobuild");
export const RIG_STATE_FILE = path.join(AUTOBUILD_DIR, "state.json");
export const RIG_SESSIONS_DIR = path.join(AUTOBUILD_DIR, "sessions");
export const ORCHESTRATOR_DIR = path.join(REPO_ROOT, ".orchestrator");
export const ORCHESTRATOR_INBOX = path.join(ORCHESTRATOR_DIR, "inbox");
export const DISPATCHER_PID_FILE = path.join(
  ORCHESTRATOR_DIR,
  "dispatcher.pid",
);
export const LOGS_DIR = path.join(REPO_ROOT, "logs");
export const DISPATCHER_LOG = path.join(LOGS_DIR, "dispatcher.jsonl");
// The autobuild CLI entrypoint the daemon invokes.
export const AUTOBUILD_BIN = path.join(
  REPO_ROOT,
  "scripts",
  "autobuild",
  "bin",
  "autobuild",
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

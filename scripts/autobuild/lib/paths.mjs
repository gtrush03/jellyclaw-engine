// paths.mjs — canonical filesystem paths for the autobuild rig.
// Everything downstream resolves absolute paths via this module so tests
// can swap in a tmp root by setting AUTOBUILD_ROOT.

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/autobuild/lib → repo root is 3 levels up
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..");

export function repoRoot() {
  return process.env.AUTOBUILD_ROOT ? resolve(process.env.AUTOBUILD_ROOT) : DEFAULT_REPO_ROOT;
}

export function autobuildDir() {
  return join(repoRoot(), ".autobuild");
}

export function orchDir() {
  return join(repoRoot(), ".orchestrator");
}

export function inboxDir() {
  return join(orchDir(), "inbox");
}

export function sessionsDir() {
  return join(autobuildDir(), "sessions");
}

export function sessionDir(sessionId) {
  return join(sessionsDir(), sessionId);
}

export function stateFile() {
  return join(autobuildDir(), "state.json");
}

export function queueFile() {
  return join(autobuildDir(), "queue.json");
}

export function logsDir() {
  return join(autobuildDir(), "logs");
}

export function promptsDir() {
  return join(repoRoot(), "prompts", "phase-99b-unfucking-v2");
}

export function promptPath(promptId) {
  return join(promptsDir(), `${promptId}.md`);
}

export function completionLog() {
  return join(repoRoot(), "COMPLETION-LOG.md");
}

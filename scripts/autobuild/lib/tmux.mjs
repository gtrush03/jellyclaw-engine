// tmux.mjs — spawn / kill / pipe-pane helpers around `tmux`.
// All calls honor AUTOBUILD_DRY_RUN; when set, we log + skip without touching
// a real tmux server. That's what the smoke test relies on.

import { execa } from "execa";
import { randomBytes } from "node:crypto";

export function shortId(bytes = 2) {
  return randomBytes(bytes).toString("hex");
}

export function tmuxSessionName(promptId) {
  // tmux session name: jc-worker-<prompt-id>-<shortid>
  return `jc-worker-${promptId}-${shortId()}`;
}

function dry() {
  return process.env.AUTOBUILD_DRY_RUN === "1";
}

export async function hasTmux() {
  if (dry()) return false;
  try {
    await execa("tmux", ["-V"], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Eagerly start the tmux server so that subsequent session/pipe-pane calls
 * have something to talk to. On macOS a fresh login has no tmux daemon, and
 * `tmux pipe-pane` errors `no server running on /private/tmp/tmux-501/default`
 * before we've created our first session. `tmux start-server` is a no-op if a
 * server is already up. We use reject:false so that exotic platform errors
 * don't tank the caller — the next `new-session` will surface any real issue.
 */
export async function ensureTmuxServer() {
  if (dry()) return { dryRun: true };
  return execa("tmux", ["start-server"], { reject: false, timeout: 5000 });
}

export async function newDetachedSession(name, cwd, command) {
  if (dry()) return { dryRun: true };
  // `tmux new-session -d -s NAME -c CWD "COMMAND"`
  return execa("tmux", ["new-session", "-d", "-s", name, "-c", cwd, command]);
}

export async function pipePane(name, logPath) {
  if (dry()) return { dryRun: true };
  return execa("tmux", ["pipe-pane", "-o", "-t", name, `cat >> ${logPath}`]);
}

export async function killSession(name) {
  if (dry()) return { dryRun: true };
  try {
    return await execa("tmux", ["kill-session", "-t", name]);
  } catch (err) {
    // Already dead — not an error.
    return { alreadyDead: true, err: err.message };
  }
}

export async function sessionExists(name) {
  if (dry()) return false;
  try {
    await execa("tmux", ["has-session", "-t", name], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

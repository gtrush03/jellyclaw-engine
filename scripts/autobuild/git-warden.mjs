// git-warden.mjs — branch management + scope enforcement.
//
// Before the worker runs: cut a feature branch off main (or current branch).
// After the worker exits: diff --name-only main..HEAD and check every touched
// path against the prompt's frontmatter.scope globs using picomatch.
//
// On scope violation we DO NOT retry — the spec says "scope_violation →
// escalate immediately (non-retryable)".

import { execa } from "execa";
import picomatch from "picomatch";

export function branchName(promptId) {
  return `autobuild/${promptId}`;
}

async function git(args, opts = {}) {
  return execa("git", args, { reject: false, ...opts });
}

export async function currentBranch(cwd) {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return (r.stdout || "").trim();
}

export async function ensureBranch(promptId, { cwd, base = "main" } = {}) {
  if (process.env.AUTOBUILD_DRY_RUN === "1") {
    return { branch: branchName(promptId), created: false, dryRun: true };
  }
  const branch = branchName(promptId);
  // Create branch from base if it does not exist.
  const check = await git(["rev-parse", "--verify", branch], { cwd });
  let created = false;
  if (check.exitCode !== 0) {
    const createRes = await git(["branch", branch, base], { cwd });
    if (createRes.exitCode !== 0) {
      throw new Error(
        `git-warden: failed to create branch ${branch}: ${createRes.stderr || createRes.stdout}`,
      );
    }
    created = true;
  }
  const co = await git(["checkout", branch], { cwd });
  if (co.exitCode !== 0) {
    throw new Error(`git-warden: failed to checkout ${branch}: ${co.stderr}`);
  }
  return { branch, created };
}

export async function changedFiles({ cwd, base = "main" } = {}) {
  if (process.env.AUTOBUILD_DRY_RUN === "1") return [];
  const r = await git(["diff", "--name-only", `${base}..HEAD`], { cwd });
  if (r.exitCode !== 0) return [];
  return (r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function commitSha({ cwd } = {}) {
  if (process.env.AUTOBUILD_DRY_RUN === "1") return null;
  const r = await git(["rev-parse", "HEAD"], { cwd });
  if (r.exitCode !== 0) return null;
  return (r.stdout || "").trim();
}

/**
 * Returns { ok, violations[] }. `scopeGlobs` is the array from frontmatter.scope.
 * A path is allowed iff at least one glob matches it.
 */
export function checkScope(paths, scopeGlobs) {
  const matchers = scopeGlobs.map((g) => picomatch(g));
  const violations = [];
  for (const p of paths) {
    const allowed = matchers.some((m) => m(p));
    if (!allowed) violations.push(p);
  }
  return { ok: violations.length === 0, violations };
}

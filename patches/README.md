# Jellyclaw Patches

This directory holds unified-diff patches applied to the vendored OpenCode sources during the jellyclaw build. Patches are the right tool when:

- the change is small and localized (a function or two),
- we expect to upstream the fix eventually,
- maintaining a full fork would obscure what we actually changed versus upstream.

Larger or structural changes live in `engine/src/` as first-class jellyclaw code and replace upstream modules via the build step.

---

## How this directory works

1. Upstream OpenCode is vendored via `npm` into `node_modules/@sst/opencode` (or the pinned commit in `engine/opencode.rev`).
2. On `npm install`, the `postinstall` script runs `patch-package` (see `package.json`).
3. `patch-package` reads every `*.patch` file in this directory in **lexicographic order** and applies it against the vendored tree.
4. If any patch fails to apply, the install aborts with a loud error. Do not ignore this — a failed patch means upstream drift, and the patch must be rebased.
5. Applied patches are idempotent: re-running `npm install` is safe.

To verify after install:

```bash
npm run verify:patches
```

This re-runs `patch-package --dry-run` and confirms every hunk is already applied.

---

## Adding a new patch

1. Edit the vendored file under `node_modules/@sst/opencode/...` directly. Get the behavior you want.
2. Run `npx patch-package @sst/opencode --patch-dir patches`.
3. Rename the generated file to the next numeric prefix: `NNN-short-kebab-description.patch`.
4. Open the file and prepend a comment header (see the "Patch naming" section) explaining intent.
5. Run `npm run verify:patches` to confirm.
6. Commit both the patch and any ancillary changes in one PR.

If your change is more than ~50 lines across more than one file, reconsider: it probably belongs in `engine/src/` as a first-class override, not as a patch.

---

## Using patch-package

We use [`patch-package`](https://www.npmjs.com/package/patch-package) (the Ds/Ds variant, not the Expo one). It's declared as a regular dependency, not devDependency, so that downstream consumers who install jellyclaw via `npm` also get the patches applied.

Relevant `package.json` bits:

```json
{
  "scripts": {
    "postinstall": "patch-package --patch-dir patches --error-on-fail",
    "verify:patches": "patch-package --patch-dir patches --dry-run"
  },
  "dependencies": {
    "@sst/opencode": "1.1.10",
    "patch-package": "^8.0.0"
  }
}
```

The `--error-on-fail` flag is load-bearing. Without it, a silently-failed patch becomes a latent security regression.

---

## Upstream-contribution strategy

Patches fall into three buckets. The header of each patch declares which bucket it's in (see naming).

**`[upstream-candidate]`** — We intend to PR this to OpenCode upstream. It's a general-purpose fix that benefits everyone. Example: `001-subagent-hook-fire.patch` (bug, not Genie-specific). Once upstream merges and we bump the pin, we delete the patch.

**`[upstream-unlikely]`** — Good for jellyclaw, but upstream has a different philosophy. Example: `002-bind-localhost-only.patch` enforces a stricter default than upstream is willing to ship. We maintain this locally indefinitely.

**`[genie-specific]`** — Hooks for Genie dispatcher plumbing that have no meaning outside the Genie stack. Example: a patch that teaches the OpenCode config loader where Genie's per-user config lives. These stay local forever.

When PRing upstream, we lift the patch as-is, drop the header comment, and open a PR against `sst/opencode`. The PR description links back to the jellyclaw patch file so upstream can see our motivation and test harness.

---

## Patch naming convention

```
NNN-short-kebab-description.patch
```

- `NNN` — three-digit zero-padded sequence number, monotonic. Never reused even if a patch is deleted. This keeps lexicographic apply order stable.
- `short-kebab-description` — at most 40 chars, describes *what* not *why*.

Every patch starts with a header block (before the first `diff --git` line) that `patch-package` and `git apply` both ignore:

```
# [upstream-candidate] Fire plugin hooks for subagent tool calls
#
# Closes OpenCode #5894. Threads the parent plugin registry into the
# subagent loop in task.ts, and adjusts processor.ts to look up the
# hook chain from the subagent context rather than the (empty) root.
#
# Jellyclaw issue: SEC-002
# Upstream PR: (pending)
```

Valid tags: `[upstream-candidate]`, `[upstream-unlikely]`, `[genie-specific]`, `[security]`, `[temporary]` (for known-short-lived patches that track an upstream RC).

---

## Current patches

| File | Tag | Purpose |
|------|-----|---------|
| `001-subagent-hook-fire.patch` | upstream-candidate, security | Make `tool.execute.*` hooks fire for subagent tool calls |
| `002-bind-localhost-only.patch` | upstream-unlikely, security | Force `127.0.0.1` bind and mandatory auth token |
| `003-secret-scrub-tool-results.patch` | upstream-candidate, security | Redact credential patterns from tool results |
| `004-playwright-mcp-pin.md` | doc-only | Explains the pinned `@playwright/mcp` version |

---

## Troubleshooting

**"patch failed to apply"** — upstream OpenCode drifted. Check `opencode.rev` against the patch's target revision, rebase the patch manually, bump the target comment in the header, commit.

**"patch applied twice"** — `patch-package` detects this and no-ops. If you see it repeatedly, something is running `postinstall` outside the normal flow. Check CI.

**"changes disappear after `npm install`"** — you edited `node_modules/` without running `npx patch-package` to capture. Your edits were wiped. Re-do them and capture the patch.

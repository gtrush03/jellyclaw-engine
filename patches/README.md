# Jellyclaw Patches

> **Current state (April 2026):** this directory currently holds **zero
> active patches** against `opencode-ai`. The `patch-package` toolchain
> is retained for future non-binary dependencies, but every Phase 01
> control that was originally planned as a patch has been reimplemented
> as first-class jellyclaw code under `engine/src/`. Read "Why the pivot"
> below before adding anything here.

---

## Why the pivot — `opencode-ai` ships a compiled binary

Initial Phase 01 research assumed `opencode-ai` on npm would unpack as
TypeScript sources under `node_modules/opencode-ai/packages/opencode/src/…`,
so we could diff its handful of hot files with `patch-package` on
`postinstall` and call it done.

That assumption is wrong. The npm distribution of `opencode-ai@1.4.5` is
a **compiled Bun-built standalone binary**. There is no consumer-side
TypeScript to diff. `patch-package` has nothing to write hunks against,
and even if it did, a diff against a binary is not a thing that exists.
See `engine/opencode-research-notes.md` §1, §3.3, §5, §6.1, and §6.2 for
the full investigation and the v1.4.5 source audit that established this.

The three originally-planned patches have therefore been reimplemented as
first-class code. Nothing under `patches/` runs against `opencode-ai`
today:

| Original patch                              | Replaced by                                                        |
|---------------------------------------------|--------------------------------------------------------------------|
| `001-subagent-hook-fire.patch`              | `engine/src/plugin/agent-context.ts` (jellyclaw plugin)            |
| `002-bind-localhost-only.patch`             | `engine/src/bootstrap/opencode-server.ts` (hostname-locked spawn + `getsockname`-equivalent assertion) |
| `003-secret-scrub-tool-results.patch`       | `engine/src/plugin/secret-scrub.ts` (jellyclaw plugin)             |

The three original `.patch` files have been renamed to `.design.md` and
kept in this directory as historical design-intent records. They are no
longer applied by any tool. Each has a `STATUS: superseded` block at the
top pointing to its live implementation.

`patch-package` remains a dependency. Its `postinstall` hook still runs
on every `npm ci`, but it has nothing to apply against `opencode-ai`. It
is available for future non-binary dependencies that may legitimately
need small diffs.

---

## How patch-package still works (for future patches)

If a future non-binary dependency does need a patch:

1. Upstream source is vendored via `npm` into `node_modules/<pkg>/…`.
2. On `npm install`, the `postinstall` script runs `patch-package`
   (see `package.json`).
3. `patch-package` reads every `*.patch` file in this directory in
   **lexicographic order** and applies it against the vendored tree.
4. If any patch fails to apply, the install aborts with a loud error.
   Do not ignore this — a failed patch means upstream drift.
5. Applied patches are idempotent: re-running `npm install` is safe.

Verify after install:

```bash
npm run verify:patches
```

Relevant `package.json` bits:

```json
{
  "scripts": {
    "postinstall": "patch-package --patch-dir patches --error-on-fail",
    "verify:patches": "patch-package --patch-dir patches --dry-run"
  },
  "dependencies": {
    "patch-package": "^8.0.0"
  }
}
```

The `--error-on-fail` flag is load-bearing. Without it, a silently-failed
patch becomes a latent security regression.

---

## How to add a real patch

If and only if a future non-binary dependency needs one:

1. Edit the vendored file under `node_modules/<pkg>/...` directly. Get
   the behavior you want.
2. Run `npx patch-package <pkg> --patch-dir patches`.
3. Rename the generated file to the next numeric prefix:
   `NNN-short-kebab-description.patch`. Never reuse a number, even if a
   patch is deleted — this keeps lexicographic apply order stable.
4. Open the file and prepend a comment header declaring the taxonomy tag
   (below) and the reason.
5. Run `npm run verify:patches` to confirm.
6. Commit the patch alongside any ancillary changes in one PR.

If your change is more than ~50 lines across more than one file,
reconsider: it probably belongs in `engine/src/` as a first-class module,
not as a patch.

### Naming

```
NNN-short-kebab-description.patch
```

- `NNN` — three-digit zero-padded sequence, monotonic.
- `short-kebab-description` — at most 40 chars, describes *what* not *why*.

### Header block

```
# [upstream-candidate] Short one-line summary
#
# Longer paragraph of motivation. Link the upstream issue or PR.
#
# Jellyclaw issue: SEC-XXX
# Upstream PR: (pending)
```

---

## Upstream-contribution taxonomy

Every patch header declares one of these tags. The taxonomy is preserved
from the pre-pivot era so that when we *do* take on a real patch we
already know where it fits.

**`[upstream-candidate]`** — We intend to PR this to the upstream
project. General-purpose fix that benefits everyone. Once upstream merges
and we bump the pin, we delete the patch.

**`[upstream-unlikely]`** — Good for jellyclaw, but upstream has a
different philosophy (e.g. stricter defaults than upstream is willing to
ship). We maintain this locally indefinitely.

**`[genie-specific]`** — Hooks for Genie dispatcher plumbing that have
no meaning outside the Genie stack. These stay local forever.

Additional qualifiers that may appear alongside a primary tag:
`[security]`, `[temporary]` (tracks an upstream RC), `[doc-only]`.

---

## Historical design-intent records

These `.design.md` files document Phase 01's original patch plan, before
the compiled-binary discovery. They are no longer applied by any tool.
Retained for provenance and so the next engineer can see what we thought
we were going to build and why we changed course.

| File                                          | Superseded by                                   |
|-----------------------------------------------|--------------------------------------------------|
| `001-subagent-hook-fire.design.md`            | `engine/src/plugin/agent-context.ts`             |
| `002-bind-localhost-only.design.md`           | `engine/src/bootstrap/opencode-server.ts`        |
| `003-secret-scrub-tool-results.design.md`     | `engine/src/plugin/secret-scrub.ts`              |
| `004-playwright-mcp-pin.md`                   | (doc-only; Playwright MCP version pin rationale) |

---

## Troubleshooting

**"patch failed to apply"** — upstream source drifted against a patch
(only possible once we take on a real patch again). Check the target
revision, rebase manually, update the target comment in the header,
commit.

**"patch applied twice"** — `patch-package` detects this and no-ops. If
it recurs, something is running `postinstall` outside the normal flow.
Check CI.

**"changes disappear after `npm install`"** — you edited `node_modules/`
without running `npx patch-package` to capture. Your edits were wiped.
Re-do them and capture the patch.

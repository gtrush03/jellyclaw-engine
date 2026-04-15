# Phase 01 — OpenCode pinning and patching — Prompt 02: Implement

**When to run:** After Phase 01 Prompt 01 (`01-research.md`) has produced `engine/opencode-research-notes.md` and that session is committed.
**Estimated duration:** 4-6 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `01`
- `<phase-name>` → `OpenCode pinning and patching`
- `<sub-prompt>` → `02-implement`
<!-- END SESSION STARTUP -->

## Task

Install `opencode-ai` at the pinned version, apply the three patches (`001-subagent-hook-fire.patch`, `002-bind-localhost-only.patch`, `003-secret-scrub-tool-results.patch`) via `patch-package`, author the `opencode-server.ts` bootstrap, write the smoke test, and prove with a reproducer that the #5894 subagent-hook fix actually fires. Close Phase 01 in `COMPLETION-LOG.md`.

### Context

Phase 00 is complete. `engine/opencode-research-notes.md` exists and specifies the exact pin version and patch contents. Existing stubs live at `/Users/gtrush/Downloads/jellyclaw-engine/patches/001-subagent-hook-fire.patch`, `002-bind-localhost-only.patch`, `003-secret-scrub-tool-results.patch`. `engine/package.json` exists with jellyclaw engine scaffolding.

### Steps

1. `cd /Users/gtrush/Downloads/jellyclaw-engine && cat engine/opencode-research-notes.md` — re-read the research before touching package.json. The pin version lives in §1 there.
2. Ensure `engine/package.json` has the dependencies from `engine/SPEC.md` §15:
   - `opencode-ai` pinned to the exact patch version chosen in research
   - `@anthropic-ai/sdk` `^0.40.0` (installed here even though Phase 02 uses it — cheaper to land now)
   - `zod` `^3.23.0`
   - `patch-package` `^8.0.0`
3. Ensure the repo root `package.json` has a `postinstall` script of `patch-package --patch-dir patches` (note: patches live at repo root `patches/`, not `engine/patches/`).
4. Install from the repo root: `bun install` (or `pnpm install --frozen-lockfile` — use whatever Phase 00 settled on).
5. Verify resolved version: `node -e "console.log(require('opencode-ai/package.json').version)"`. Expected: matches research §1 exactly. If not, `bun add opencode-ai@<exact-version> --exact` inside `engine/`.
6. Verify CVE mitigation: confirm version is ≥ `1.4.4`. Print `./engine/CVE-MITIGATION.md` first section to re-anchor.
7. Review each of the three patch files at `/Users/gtrush/Downloads/jellyclaw-engine/patches/*.patch`. Confirm their diffs target the file paths called out in research §5. If any is a placeholder stub ("TODO"), author the real patch now by: (a) editing `node_modules/opencode-ai/...` in place per the research sketch, (b) running `npx patch-package opencode-ai` from the repo root, (c) verifying the emitted patch file overwrites the stub.
8. Nuke and reinstall to prove reapplication: `rm -rf node_modules engine/node_modules && bun install`. Expected log lines: `opencode-ai@<ver> ✔` three times (one per patch), or one consolidated line if patches were combined.
9. Author `engine/src/bootstrap/opencode-server.ts` per `phases/PHASE-01-opencode-pinning.md` Step 8. Additionally: confirm the returned URL is `http://127.0.0.1:<port>` (never `0.0.0.0`, never `localhost`); throw `BindError` if otherwise.
10. Author `engine/src/bootstrap/opencode-server.test.ts` per Step 9. Add an extra assertion: `POST /session` returns `401` without `Authorization: Bearer <token>`, and `200` with it.
11. Author `engine/scratch/repro-5894.ts` that spawns the server, registers a `PreToolUse` plugin that appends to `/tmp/jellyclaw-5894-hook.log`, dispatches a `Task` tool call that itself invokes `Read`, and asserts the log contains the nested-tool entry. Add this path to `.gitignore` after the test succeeds.
12. Run `bun run --filter @jellyclaw/engine test`. All tests green.
13. Run the reproducer: `bun tsx engine/scratch/repro-5894.ts`. Expected stdout: `OK: hook fired inside subagent at depth 1`.
14. Update `patches/README.md` with: exact OpenCode version, SHA of `opencode-ai-<ver>.tgz` from npm, one paragraph per patch explaining WHAT and WHY, and how to refresh if upstream ships its own fix.
15. Commit and update `COMPLETION-LOG.md`. Mark Phase 01 ✅.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — pin updates.
- `/Users/gtrush/Downloads/jellyclaw-engine/package.json` — `postinstall: "patch-package --patch-dir patches"` if not already present.
- `/Users/gtrush/Downloads/jellyclaw-engine/patches/001-subagent-hook-fire.patch` — real diff (replace stub).
- `/Users/gtrush/Downloads/jellyclaw-engine/patches/002-bind-localhost-only.patch` — real diff.
- `/Users/gtrush/Downloads/jellyclaw-engine/patches/003-secret-scrub-tool-results.patch` — real diff.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/bootstrap/opencode-server.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/bootstrap/opencode-server.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/scratch/repro-5894.ts` (+ `.gitignore` entry)
- `/Users/gtrush/Downloads/jellyclaw-engine/patches/README.md` — expanded documentation.
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — Phase 01 ✅.

### Verification

- `bun install` after `rm -rf node_modules` reapplies all three patches (stdout proof captured).
- `bun run --filter @jellyclaw/engine test` exits 0 with the smoke test passing.
- `curl -s http://127.0.0.1:<port>/config` with no auth returns 401; with the token returns 200.
- `curl -s http://0.0.0.0:<port>/config` fails to connect (proves localhost-only bind).
- Reproducer `repro-5894.ts` prints the "OK" line and `/tmp/jellyclaw-5894-hook.log` has at least one entry tagged `depth=1`.
- `grep -q 'opencode-ai' pnpm-lock.yaml || grep -q 'opencode-ai' bun.lock` returns a hit with the pinned version.
- `COMPLETION-LOG.md` shows Phase 01 ✅ with commit SHA and today's date.

### Common pitfalls

- **Editing `node_modules` but forgetting `patch-package`.** Your changes vanish on the next install. Always `npx patch-package opencode-ai` after editing, and commit the resulting `.patch` file.
- **Patch fuzz on minor upstream bumps.** If research picked a version and npm has since published a patch, `patch-package` may warn about fuzz. Re-generate patches against the exact pinned version; bump the pin if needed (but not above `<2`).
- **`postinstall` infinite loop.** `patch-package` inside a workspace can try to reinstall. Pin `patch-package --patch-dir patches` with the absolute-safe form and confirm it does not re-trigger install.
- **Kernel-picked port race.** `startOpenCode()` reads the bound port from stdout; if the upstream log format changes, the regex breaks. Assert the regex matches within 5s; if not, throw with the full captured stdout for debuggability.
- **Leaked server processes on test failure.** Always `kill` in `finally`. Add a Vitest global teardown that `pkill -f 'opencode serve'` (scoped to ports in the 49152-65535 range) as belt-and-braces.
- **Hardcoding the token in logs.** Never `console.log(h.token)`. The logger's redact list must include `token`, `password`, `apiKey`, `OPENCODE_SERVER_PASSWORD`.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `01`
- `<phase-name>` → `OpenCode pinning and patching`
- `<sub-prompt>` → `02-implement`
- Mark Phase 01 as ✅ Complete in `COMPLETION-LOG.md`.
<!-- END SESSION CLOSEOUT -->

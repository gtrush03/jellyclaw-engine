# Phase 06 — Subagent system — Prompt 03: Verify the subagent hook-fire patch

**When to run:** After Phase 06 prompt 02 (Task tool + dispatch) is ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 2–3 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 06.02 not ✅. -->
<!-- END paste -->

## Research task

1. Read the patch itself: `/Users/gtrush/Downloads/jellyclaw-engine/patches/001-subagent-hook-fire.patch`. Understand what file(s) in OpenCode it modifies and what behavior it restores.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/patches/README.md` — patch application workflow.
3. Read Phase 01 completion notes in `COMPLETION-LOG.md` — how were patches applied (postinstall script? `patch-package`? hand-applied?).
4. Read upstream OpenCode issue **#5894** (referenced in the phase doc) if any notes exist in `docs/` or `integration/`. This is the "hooks don't fire inside subagents" bug. If no local notes, search the codebase with `Grep` for `5894`.
5. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-06-subagents.md` — Step 5 (hook propagation test).
6. Read `engine/src/hooks/` if anything exists (Phase 08 is full hook engine; here we just need `PreToolUse` / `PostToolUse` wiring enough to write a regression test — stub is fine if the full engine isn't built yet).

## Implementation task

Write a **regression-locking test suite** that FAILS if upstream OpenCode's subagent-hooks bug (issue #5894) returns — i.e. if the patch is reverted or an upstream update silently removes the fix. No new runtime code; only tests and a CI gate.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/hooks/test-harness.ts` — minimal `PreToolUse` + `PostToolUse` hook recorder (in-memory, for tests only; NOT the Phase 08 engine).
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/subagent-hooks.test.ts` — the regression test.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/fixtures/agents/hook-probe/AGENT.md` — fixture agent that deliberately calls `Bash("echo probe")` once.
- `/Users/gtrush/Downloads/jellyclaw-engine/scripts/verify-hook-patch.ts` — standalone script that can be run in CI; exits 0 if hooks fire inside subagent, 1 otherwise; emits a clear error.
- `/Users/gtrush/Downloads/jellyclaw-engine/package.json` — add script `"test:hook-patch": "bun run scripts/verify-hook-patch.ts"`.
- Wire `test:hook-patch` into the existing test workflow (or mention in CI section of `docs/development.md`).

### Regression test logic

```
Arrange:
  - Register an in-process hook recorder that pushes {event, toolName, subagentSessionId, parentSessionId} to an array on PreToolUse and PostToolUse.
  - Load the hook-probe agent from the fixture dir.
  - Build an engine with the recorder attached.

Act:
  - Run: engine.run({ prompt: "Use the Task tool to dispatch the hook-probe subagent with prompt 'run one bash echo probe'." })
  - Drain the async iterator to completion.

Assert (hard assertions — failures indicate patch regression):
  1. Recorder received at least one PreToolUse event.
  2. At least one such event has subagentSessionId !== parentSessionId.
     → This is THE assertion that fails if #5894 regresses.
  3. At least one PostToolUse event for toolName="Bash" with the same subagentSessionId.
  4. parentSessionId matches the engine's top-level session id.
  5. Event order: PreToolUse precedes PostToolUse for the same tool_use_id.
  6. At least one event's tool input contains "echo probe".
```

Add descriptive failure messages so a CI failure immediately points a reader at `patches/001-subagent-hook-fire.patch`.

### Additional guard: patch sentinel check

In `scripts/verify-hook-patch.ts`, before running the integration test, assert the patch is applied by grepping the installed OpenCode source for a known sentinel string introduced by the patch:

1. Open the patch file, extract a unique added line (pick a comment or a unique identifier).
2. `Grep` for that exact string inside `node_modules/opencode-ai/` (or wherever it is installed).
3. If absent → fail immediately with `"001-subagent-hook-fire.patch is NOT applied to installed opencode-ai. Run \`bun run postinstall\` (or equivalent) and retry."`.

This gives two independent signals:
- Static: patch text is present.
- Dynamic: the behavior actually works.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun install                                  # ensure patches applied
bun run test:hook-patch                      # expect: exit 0, prints "patch verified: static + dynamic"
bun run test test/integration/subagent-hooks # expect: green
bun run typecheck
bun run lint
```

### Expected output

```
✓ patches/001-subagent-hook-fire.patch static sentinel found in node_modules/opencode-ai/...
✓ PreToolUse fired inside subagent (subagentSessionId=abc-123, parent=xyz-789)
✓ PostToolUse fired inside subagent
✓ Tool order verified
patch verified: static + dynamic
```

### Tests to add

- `test/integration/subagent-hooks.test.ts` — all assertions above as separate `it()` blocks so CI reports pinpoint the exact failing invariant.
- A **negative-control test**: temporarily disable the hook patch (via an env var flag your harness respects) → assert the test FAILS. This proves the test is capable of detecting regression. Keep this as a skipped (`it.skip`) test with a clear TODO comment explaining how to manually re-enable and run it.

### Verification

```bash
bun run test:hook-patch
# expect: prints both static + dynamic verified, exit 0

# Prove the test is sharp:
# 1. Temporarily revert the patch: (cd node_modules/opencode-ai && patch -R -p1 < ../../patches/001-subagent-hook-fire.patch)
bun run test:hook-patch
# expect: exits 1 with clear error pointing at the patch
# 2. Restore: bun install (or re-apply)
```

### Tests to add to CI

Add a job or step that runs `bun run test:hook-patch` on every upstream `opencode-ai` version bump. Document this in `docs/development.md` under "Upstream rebase checklist".

### Common pitfalls

- The bug only reproduces when the subagent calls a tool — if the subagent returns only text, the test passes vacuously. The hook-probe agent MUST call `Bash` at least once; assert that the recorder actually recorded a call (don't just check the counter ≥ 0).
- Flaky timing: drain the async iterator fully before asserting, and await a `subagent.end` event — never race against a partial stream.
- `subagentSessionId` distinctness: if your Phase 06.02 dispatch reuses the parent id, the assertion mis-reports pass/fail. Confirm dispatch assigns a new session id.
- `Grep` on `node_modules/` is allowed for this test but note: the install path can differ (`pnpm`, `bun`, workspaces). Use `require.resolve("opencode-ai")` to locate the module root and search relative to that.
- On macOS, line endings in the patch are LF; Windows users might have CRLF — use a regex that tolerates both.
- Do not add jitter retries. If this test is flaky, the patch is flaky — fix the patch.
- Do not expose the hook recorder outside `test-harness.ts`; Phase 08 will replace it with the real engine.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: Phase 06 fully ✅, next prompt = prompts/phase-07/01-mcp-client-stdio.md. -->
<!-- END paste -->

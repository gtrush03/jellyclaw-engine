---
id: T2-08-wire-continue-flag
tier: 2
title: "Thread --continue into findLatestForProject() + resumeSession()"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/cli/run.test.ts"
depends_on_fix:
  - T2-07-wire-resume-flag
tests:
  - name: continue-picks-most-recent-for-cwd
    kind: shell
    description: "--continue without an id resolves to the latest session in the current cwd's project hash"
    command: "bun run test engine/src/cli/run -t continue-picks-most-recent"
    expect_exit: 0
    timeout_sec: 60
  - name: continue-no-session-errors
    kind: shell
    description: "--continue when no session exists for the project exits code 2 with NoSessionForProjectError"
    command: "bun run test engine/src/cli/run -t continue-no-sessions"
    expect_exit: 0
    timeout_sec: 60
  - name: continue-ignores-other-cwds
    kind: shell
    description: "sessions in a different cwd (different project_hash) do NOT satisfy --continue"
    command: "bun run test engine/src/cli/run -t continue-isolated-by-cwd"
    expect_exit: 0
    timeout_sec: 60
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 35
---

# T2-08 — Wire `--continue` to the latest-session-for-cwd resolver

## Context
Anthropic-style "pick up where I left off" UX: `jellyclaw run --continue "do more work"` should grab the most recently touched session for the current project (keyed by `projectHash(cwd)`) and resume it. The resolver (`findLatestForProject`) exists in `engine/src/session/continue.ts` and works. Like `--resume`, the flag is parsed and thrown away. T2-07 laid the priorMessages plumbing; this prompt reuses it.

## Root cause (from audit)
- `engine/src/cli/run.ts:51` — `readonly continue?: boolean;` in `RunCliOptions`.
- `engine/src/cli/run.ts:242-244` — mutex check runs, but `continue === true` is otherwise never acted upon.
- `engine/src/cli/run.ts:321-325` — `RunOptions` never receives the resolved session id.
- `engine/src/session/continue.ts:31-48` — `findLatestForProject(db, projectHash)` is fully implemented.
- `engine/src/session/types.ts` — `NoSessionForProjectError` is the correct error class (per `continue.test.ts`).

## Fix — exact change needed
1. **`engine/src/cli/run.ts:realRunFn` / CLI handler wiring** — when `options.continue === true` AND `options.resume === undefined`:
   ```
   const paths = new SessionPaths();
   const db = await openDb({ paths });
   try {
     const projectHashStr = projectHash(runOptions.cwd ?? process.cwd());
     const latest = await findLatestForProject(db, projectHashStr);
     if (latest === null) {
       throw new ExitError(2, `no prior session for project (cwd=${runOptions.cwd})`);
     }
     const state = await resumeSession({ sessionId: latest.id, paths, db, logger, projectHash: projectHashStr });
     runOpts.priorMessages = toPriorMessages(state);
     runOpts.sessionId = latest.id;
   } finally {
     db.close();
   }
   ```
   Wrap with the existing SIGINT handler so a partial resume doesn't leave the db open.
2. **Import `projectHash` from `engine/src/session/paths.js`** — it's re-exported there per `continue.ts:11`.
3. **Tests** (`engine/src/cli/run.test.ts`):
   - `continue-picks-most-recent` — seed an in-memory sessions table (via Db helper) with two rows for the same `project_hash`, different `last_turn_at`. Invoke the handler with `--continue`, assert the injected runFn receives `sessionId === <most recent id>` and populated `priorMessages`.
   - `continue-no-sessions` — empty sessions table → `ExitError(code:2)` containing "no prior session".
   - `continue-isolated-by-cwd` — seed one row with `project_hash = hash("/a")` and cwd `/a`. Invoke handler with cwd `/b`. Assert `continue-no-sessions`-style error: the row belonging to a different project must be invisible.
4. Wherever possible, share the DB-open + error-conversion helper with T2-07's resume path — extract a single `resolveResumeOrContinue(options, cwd, logger)` function returning `{sessionId, priorMessages} | undefined` if both flags are unset.

## Acceptance criteria
- `continue-picks-most-recent-for-cwd` — latest row by `last_turn_at` wins (maps to test 1).
- `continue-no-session-errors` — clean exit 2 with actionable message (maps to test 2).
- `continue-ignores-other-cwds` — project isolation by `project_hash` preserved (maps to test 3).

## Out of scope
- Do NOT attempt to merge across different project hashes. "Continue in any project" is a separate feature.
- Do NOT change `findLatestForProject` ordering rules.
- Do NOT rehydrate tool-call history (see T2-07 out-of-scope — same constraint applies here).

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/cli/run engine/src/session/continue
grep -n "options.continue" engine/src/cli/run.ts
```

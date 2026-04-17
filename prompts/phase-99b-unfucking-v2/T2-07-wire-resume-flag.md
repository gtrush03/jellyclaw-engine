---
id: T2-07-wire-resume-flag
tier: 2
title: "Thread --resume <id> through to resumeSession() + priorMessages"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/cli/run.test.ts"
  - "engine/src/session/to-prior-messages.ts"
  - "engine/src/session/to-prior-messages.test.ts"
depends_on_fix: []
tests:
  - name: resume-restores-prior-messages
    kind: shell
    description: "--resume <id> loads the JSONL, converts to priorMessages, and passes them into runAgentLoop"
    command: "bun run test engine/src/cli/run -t resume-wires-prior-messages"
    expect_exit: 0
    timeout_sec: 60
  - name: resume-unknown-id-exits-nonzero
    kind: shell
    description: "--resume on a non-existent id exits code 2 with a SessionNotFoundError message on stderr"
    command: "bun run test engine/src/cli/run -t resume-unknown-id"
    expect_exit: 0
    timeout_sec: 60
  - name: resume-transcript-round-trip
    kind: shell
    description: "end-to-end: run prompt A → kill mid-way → --resume <id> 'continue' → transcript contains both halves"
    command: "bun run test engine/src/cli/run -t resume-round-trip"
    expect_exit: 0
    timeout_sec: 120
human_gate: false
max_turns: 40
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 45
---

# T2-07 — Wire `--resume <id>` to the session resume machinery

## Context
Session resumption is fully implemented server-side: `resumeSession()` reads the JSONL transcript for a given session id, reduces the events to an `EngineState`, and applies a token-budget trim. The agent loop even has a `priorMessages` option for feeding prior conversation back in. But the CLI flag `--resume <id>` is parsed and then dropped on the floor — no call is ever made.

## Root cause (from audit)
- `engine/src/cli/run.ts:50` — `readonly resume?: string;` is in `RunCliOptions`.
- `engine/src/cli/run.ts:242-244` — the mutex check against `--continue` is honoured, but past that the flag goes nowhere.
- `engine/src/cli/run.ts:321-325` — `RunOptions` is constructed without threading `options.resume` through. The comment admits it: "`run()` is still the Phase-0 stub and doesn't yet read `--resume`".
- `engine/src/session/resume.ts:140` — `resumeSession()` works; it throws `SessionNotFoundError` for unknown ids (`engine/src/session/resume.ts:151`).
- `engine/src/agents/loop.ts:56-60` — `AgentLoopOptions.priorMessages?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>` already exists and is wired at `loop.ts:137-140`.

## Fix — exact change needed
1. **New file `engine/src/session/to-prior-messages.ts`** — export:
   - `toPriorMessages(state: EngineState): Array<{role:"user"|"assistant"; content:string}>`. Walk `state.messages` (already role-tagged by the reducer), filter to user/assistant pairs, coalesce consecutive assistant text chunks, drop system messages. If `state.toolCalls` is non-empty the function MUST preserve tool-call boundaries by emitting inline markers — but for THIS prompt, keep it minimal: text-only prior messages, tool-call rehydration is T3 territory. Log an `info` when tool-call history was dropped so the model knows context may be thin.
2. **`engine/src/cli/run.ts:realRunFn` / CLI handler wiring**:
   - When `options.resume !== undefined`, before calling `runAgentLoop(...)`:
     ```
     const paths = new SessionPaths();
     const db = await openDb({ paths });
     try {
       const state = await resumeSession({ sessionId: options.resume, paths, db, logger });
       const priorMessages = toPriorMessages(state);
       runOpts.priorMessages = priorMessages;
       runOpts.sessionId = options.resume; // preserve id so subsequent writes append to the same transcript
     } finally {
       db.close();
     }
     ```
   - Catch `SessionNotFoundError` → rethrow as `new ExitError(2, "unknown session id: <id>")`.
   - Extend `RunOptions` in `engine/src/internal.ts` with `priorMessages?: ReadonlyArray<{role:"user"|"assistant"; content:string}>` if not already present, and pipe it into `runAgentLoop({..., priorMessages: opts.priorMessages ?? []})` at `run.ts:142-153`.
3. **Tests**:
   - `engine/src/cli/run.test.ts :: resume-wires-prior-messages` — inject a fake `resumeFn` via DI that returns a fixture `EngineState` with two messages (user: "hi", assistant: "hello"). Run with `--resume <id> "continue"`, assert the injected `runFn` receives `priorMessages: [{role:"user",content:"hi"},{role:"assistant",content:"hello"}]` and `sessionId === <id>`.
   - `:: resume-unknown-id` — injected resume throws `SessionNotFoundError`; assert the CLI exits with `ExitError.code === 2` and stderr contains the id.
   - `:: resume-round-trip` — integration: run prompt A to completion with `JELLYCLAW_SOUL=off` to stabilise output, capture session id from `session.started` event, then invoke CLI again with `--resume <id> "ping"`, assert the persisted JSONL for that session has both user prompts.
   - `engine/src/session/to-prior-messages.test.ts` — role coalescing, tool-call drop warning, empty-state returns empty array.

## Acceptance criteria
- `resume-restores-prior-messages` — flag produces `priorMessages` populated into the loop (maps to test 1).
- `resume-unknown-id-exits-nonzero` — unknown id exits 2 cleanly (maps to test 2).
- `resume-transcript-round-trip` — end-to-end flow appends to the same session JSONL (maps to test 3).

## Out of scope
- Do NOT rehydrate tool-call history into prior messages — text-only for now. A follow-up (T3) can teach `toPriorMessages` to emit tool_use/tool_result blocks.
- Do NOT implement interactive session-picker UX for missing ids.
- Do NOT change `resumeSession` internals.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/session/to-prior-messages engine/src/cli/run
bun run test engine/src/session/resume
```

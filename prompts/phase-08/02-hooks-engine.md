# Phase 08 — Permission engine + hooks — Prompt 02: Hooks engine (10 events)

**When to run:** After Phase 08 prompt 01 (permission modes) is ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 4–6 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 08.01 not ✅. -->
<!-- END paste -->

## Research task

1. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-08-permissions-hooks.md` — Hook events, Hook contract, Steps 3–5.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — hook event lifecycle.
3. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — hook command-injection rules (never shell-interpolate user inputs; stdin JSON only).
4. Read Claude Code's hook reference — match event names, payload shapes, and the `exit 2 = block + stderr reason` contract exactly. Search the codebase for `PreToolUse`, `PostToolUse`, `exit 2`.
5. Read prompt 01 output at `engine/src/permissions/` — you'll inject `runHooks()` into the decision pipeline.
6. Read prompt 06.03's test harness — the in-memory hook recorder from Phase 06 is replaced by this real engine. Keep the harness but mark it DEPRECATED in a comment; remove it in Phase 11.

## Implementation task

Build the hook runner and wire **10 hook events** into the engine lifecycle. Extends the phase doc's 8 by adding `InstructionsLoaded` and `Notification` to match the current Claude Code surface.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/hooks/types.ts` — `HookEvent`, `HookResult` (decision + optional modified payload), `HookConfig`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/hooks/runner.ts` — spawns hook command, pipes JSON in, parses JSON out, honors `exit 2` contract.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/hooks/registry.ts` — matcher for `matcher` field on hook configs; returns hooks for `(event, context)`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/hooks/events.ts` — 10 event emitters, each with a payload schema (Zod).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/hooks/audit-log.ts` — append-only `~/.jellyclaw/logs/hooks.jsonl`.
- Modify `engine/src/permissions/engine.ts` — call `hooksRegistry.run("PreToolUse", ctx)` BEFORE rule evaluation; honor `deny`/`allow`/`modify` from hook results.
- Modify engine core to emit each event at the correct lifecycle point.
- Tests: `runner.test.ts`, `registry.test.ts`, `events.test.ts`, `permissions-hooks-integration.test.ts`.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/hooks.md`.

### The 10 events (match exactly)

| # | Event | Payload shape | Fire point |
|---|-------|---------------|------------|
| 1 | `SessionStart` | `{ sessionId, cwd, config }` | Engine boot, before first prompt |
| 2 | `InstructionsLoaded` | `{ sessionId, claudeMd, systemPromptBytes }` | After CLAUDE.md + skills assembled |
| 3 | `UserPromptSubmit` | `{ sessionId, prompt }` | On user message received |
| 4 | `PreToolUse` | `{ sessionId, toolName, toolInput, callId }` | Before tool invocation; may block |
| 5 | `PostToolUse` | `{ sessionId, toolName, toolInput, toolResult, callId, durationMs }` | After tool result |
| 6 | `SubagentStart` | `{ parentSessionId, subagentSessionId, agentName }` | Entry to Phase 06 dispatch |
| 7 | `SubagentStop` | `{ parentSessionId, subagentSessionId, reason, usage }` | Exit of dispatch |
| 8 | `PreCompact` | `{ sessionId, tokenCount, threshold }` | Before context compaction |
| 9 | `Stop` | `{ sessionId, reason, usage }` | End of a turn (not engine shutdown) |
| 10 | `Notification` | `{ sessionId, level, message }` | Non-fatal notifications (e.g., "skill added", "MCP reconnected") |

### Hook contract (exact)

- **stdin:** JSON `{ event, payload }` (one line, newline-terminated).
- **stdout:** either empty OR JSON `{ decision: "allow"|"deny"|"modify", modified?: <new payload>, reason?: string }`.
- **stderr:** free text; surfaced to the model if the hook blocks.
- **exit code:**
  - `0` → neutral (allow if no explicit decision).
  - `2` → **block** with `reason` = stderr.
  - any other non-zero → treat as neutral + warn (user misconfigured hook script).
- **Timeout:** 30 s → treat as neutral + warn + audit-log `timeout: true`.

### Runner implementation

- `child_process.spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env })` — **never** shell-interpolate user inputs. Each hook config is `{ matcher, command: string, args?: string[], timeout?: number }`. The `command` is a literal exec path or script; array args; no `shell: true`.
- Pipe stdin JSON; close stdin.
- Collect stdout + stderr up to a hard cap (1 MB) to prevent memory bombs.
- Use `AbortController` for timeout; on timeout, SIGTERM then SIGKILL after 1 s.
- Parse stdout as JSON iff non-empty; ignore parse errors → treat as neutral + warn.

### Mode composition with hooks

- `bypassPermissions` bypasses rule checks but still fires hooks (for audit). If a hook emits `deny` in bypass mode → **the deny still wins**. Document this — hooks are a separate belt+suspenders layer.
- `plan` mode fires `PreToolUse` too, and the pipeline denies as usual — hooks can log/observe the attempted call.
- `PostToolUse` in `async` mode: documented knob `{ "blocking": false }` — run without awaiting; does not modify tool result. Default blocking.

### Audit log

- Append JSON per hook invocation: `{ ts, event, sessionId, hookName, decision, durationMs, exit_code, reason?, timedOut? }`.
- Rotate at 50 MB; keep 5 rotations.
- File mode 0600.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/hooks engine/src/permissions
bun run lint
```

### Expected output

- 10 events all emit and are observable by hook commands.
- `exit 2` blocks a tool with the stderr reason visible in the event stream.
- Timeout test: hook that sleeps 40 s is killed at 30 s, tool continues with neutral.

### Tests to add

- `runner.test.ts`:
  - Happy path: hook returns `{decision: "allow"}` via stdout.
  - Exit 2: block with reason from stderr.
  - Timeout: sleep hook → killed at timeout, neutral + warn.
  - Malformed stdout → neutral + warn.
  - Output size cap: 2 MB output → truncated + warn.
- `registry.test.ts` — `matcher` on event and tool name (reuse picomatch); multiple hooks on same event run in declaration order.
- `events.test.ts` — each of the 10 events fires from the correct lifecycle point (use test harness engine).
- `permissions-hooks-integration.test.ts`:
  - Hook returns `deny` in `bypassPermissions` mode → call blocked (deny wins).
  - Hook returns `modify` → tool runs with modified input; audit log records modification.
  - Rule says `allow`, hook says `deny` → deny.

### Verification

```bash
bun run test engine/src/hooks engine/src/permissions   # expect: green

# Smoke: config a hook, observe it blocks
cat > ~/.jellyclaw/jellyclaw.json <<'EOF'
{
  "hooks": [
    { "event": "PreToolUse", "matcher": "Bash", "command": "/usr/bin/env", "args": ["bash", "-c", "echo 'nope' 1>&2; exit 2"] }
  ]
}
EOF
./dist/cli.js run "run the bash command 'echo hi'"
# expect: tool blocked, model sees reason "nope"
```

### Common pitfalls

- `spawn` with `shell: true` on a user-configurable `command` = RCE. Never do that.
- Don't use `console.error` from inside the engine; use pino.
- Hook command path must be an absolute path OR a PATH-resolved binary; warn if relative (could shift based on cwd).
- `PostToolUse` + async mode: results returned to the model MUST NOT depend on async hook outcomes — document this, and enforce in code (the hook cannot `modify` a PostToolUse payload when blocking=false).
- Event ordering inside a subagent: `SubagentStart` fires BEFORE the subagent's `SessionStart`; `SubagentStop` AFTER its `Stop`. Write tests for this specific order.
- `Notification` is intentionally "fire and forget" — it cannot block anything. Enforce with a type: `NotificationHook` has no `decision` field in result.
- Large payloads (PostToolUse with huge tool_result) — truncate toolResult to 256 KB before passing to hooks, with a `"truncated": true` flag.
- The audit log and the permissions audit log (prompt 01) are DIFFERENT files. Don't merge.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: 08.02 ✅, next prompt = prompts/phase-08/03-rate-limiter-and-scrub.md. -->
<!-- END paste -->

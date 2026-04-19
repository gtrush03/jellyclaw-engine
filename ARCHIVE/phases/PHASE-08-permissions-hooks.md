---
phase: 08
name: "Permission engine + hooks"
duration: "2 days"
depends_on: [02, 04, 06]
blocks: [10, 11]
---

# Phase 08 — Permission engine + hooks

## Dream outcome

A `PreToolUse` hook can block a `Bash(rm -rf *)` call by emitting `exit 2` on stderr with a reason, and the engine surfaces that reason to the model. Four permission modes (`default`, `acceptEdits`, `bypassPermissions`, `plan`) change tool gating behavior without code changes — only config. Hook rules matching Claude Code's `Tool(pattern)` syntax work identically.

## Deliverables

- `engine/src/permissions/rules.ts` — matcher for `Tool(pattern)` (glob + regex)
- `engine/src/permissions/engine.ts` — decision pipeline
- `engine/src/hooks/runner.ts` — stdin/stdout JSON + exit-code contract
- `engine/src/hooks/events.ts` — 8 event kinds
- Unit tests (40+)
- `docs/permissions.md`, `docs/hooks.md`

## Permission modes

| Mode | Behavior |
|---|---|
| `default` | Dangerous tools (Bash, Write, Edit) prompt; read tools auto-allow |
| `acceptEdits` | Auto-allow Edit/Write; Bash still prompts |
| `bypassPermissions` | All tools allowed (CI/scripts) |
| `plan` | No tools executed; model outputs a plan only |

## Hook events

1. `SessionStart` — on engine init
2. `PreToolUse` — before tool invocation
3. `PostToolUse` — after tool result
4. `UserPromptSubmit` — when user sends a message
5. `Stop` — end of turn
6. `SubagentStart`
7. `SubagentStop`
8. `PreCompact` — before context compaction

## Hook contract

- stdin: JSON `{ event, payload }`
- stdout: JSON `{ decision: "allow"|"deny"|"modify", modified?: any, reason?: string }` OR empty
- exit 0 = neutral, exit 2 = block with reason on stderr
- Timeout 30 s → treat as neutral + warn

## Step-by-step

### Step 1 — Rule matcher
`Tool(pattern)` supports:
- `Bash` — any bash call
- `Bash(git *)` — glob on command
- `Write(src/**)` — glob on path arg
- `Edit(**)` — all edits
- `mcp__github__*` — MCP namespaced tools

Implement via `picomatch` for globs.

### Step 2 — Decision pipeline
Order: deny > ask > allow. Per-rule decision:
1. Check `hooks[*]` where `matcher` matches event
2. Run hook, collect decisions
3. Apply mode: `bypassPermissions` skips prompts; `plan` blocks all execution; `acceptEdits` auto-allows Edit/Write.

### Step 3 — Hook runner
Spawn shell with hook command, pipe JSON in, parse JSON out, 30 s timeout. Audit-log every invocation to `~/.jellyclaw/logs/hooks.jsonl`.

### Step 4 — Event emitters
Wire each of the 8 events to the correct engine code paths. `PreCompact` fires when token budget exceeds threshold before compaction.

### Step 5 — Test matrix
For each event × each mode × (allow|deny|modify|timeout|exit2), assert expected behavior. ~40 tests.

### Step 6 — CLI flag parity
`--permission-mode plan`, `--permission-mode bypassPermissions` override config.

## Acceptance criteria

- [ ] All 4 modes behave per spec
- [ ] All 8 hook events fire at correct lifecycle points
- [ ] Exit-2 blocks with reason visible to model
- [ ] Timeout treated as neutral + warn
- [ ] Rule patterns match Claude Code's syntax
- [ ] Audit log written for every hook invocation

## Risks + mitigations

- **Hook command injection** → never shell-interpolate user inputs; pass JSON via stdin only.
- **Slow hooks blocking tool execution** → 30 s timeout; async mode for non-blocking hooks (PostToolUse).
- **Rule ambiguity** → `jellyclaw config check` command that lints rules for overlaps.

## Dependencies to install

```
picomatch@^4
```

## Files touched

- `engine/src/permissions/{rules,engine}.ts`
- `engine/src/hooks/{runner,events}.ts`
- `engine/src/{permissions,hooks}/*.test.ts`
- `docs/{permissions,hooks}.md`

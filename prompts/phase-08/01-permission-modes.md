# Phase 08 — Permission engine + hooks — Prompt 01: Permission modes + rule matcher

**When to run:** After Phase 07 is fully ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3–4 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if Phase 07 not fully ✅. -->
<!-- END paste -->

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-08-permissions-hooks.md` in full, especially Permission modes + Step 1 (rule matcher) + Step 2 (decision pipeline).
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — permissions section.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — especially anything about default-deny, deny-wins, and the plan-mode invariant (plan mode MUST NOT execute any tool).
4. Read Claude Code's rule pattern reference (search the repo: `Grep` for `Tool(` and `matcher` in `docs/` and `integration/`). Match its syntax exactly:
   - `Bash` — all bash calls
   - `Bash(git *)` — glob on the command string
   - `Write(src/**)` — glob on path argument
   - `Edit(**)` — all edits
   - `mcp__github__*` — MCP wildcard
5. `picomatch@^4` docs — pay attention to `{ dot: true }` for dotfile matching and `/` vs `\\` on Windows (future-proof).

## Implementation task

Implement the four permission modes and the rule matcher. Hooks come in prompt 02; rate limiter + secret scrub in prompt 03.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/permissions/types.ts` — `PermissionMode`, `PermissionRule`, `PermissionDecision` (`"allow"|"deny"|"ask"`), `ToolCall`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/permissions/rules.ts` — parser for `Tool(pattern)` syntax + matcher.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/permissions/engine.ts` — decision pipeline per tool call.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/permissions/prompt.ts` — interactive prompt helper for `ask` (stdin; auto-deny in non-TTY unless `--auto-approve` is NOT set and there's no prompt handler — but never auto-allow; tests use an injected handler).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/permissions/index.ts` — barrel.
- Tests: `rules.test.ts`, `engine.test.ts`.
- Update `engine/src/config/` to load `permissions: { allow: string[], deny: string[], ask: string[], mode: PermissionMode }` from `jellyclaw.json`.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/permissions.md`.

### Mode semantics (exact table)

| Mode | Read tools | Bash | Write/Edit | MCP | Other |
|---|---|---|---|---|---|
| `default` | allow | ask | ask | rules | ask |
| `acceptEdits` | allow | ask | allow | rules | ask |
| `bypassPermissions` | allow | allow | allow | allow | allow |
| `plan` | allow (read only) | **deny** | **deny** | deny (tools with side effects) | deny |

- Read tools baseline set: `Read`, `Grep`, `Glob`, `LSP`.
- `plan` mode: **no tool with observable side effects may execute**. The engine must call out to a `isSideEffectFree(tool): boolean` predicate. MCP tools default to "not free" in plan mode.

### Rule pattern grammar

```
rule       := toolName "(" pattern ")" | toolName
toolName   := [A-Za-z_][A-Za-z0-9_]* | "mcp__" [a-z0-9-]+ "__" [a-z0-9_-]+  | "mcp__" [a-z0-9-]+ "__*"
pattern    := <picomatch glob against argument-string>
```

- `Bash(git *)` matches when tool name is `Bash` AND the `command` argument glob-matches `git *`.
- `Write(src/**)` matches when tool name is `Write` AND the `path` argument glob-matches `src/**` (with `{ dot: true }`).
- Unknown tool in rule → load-time warning, not error (future-proof for MCP servers not yet connected).
- Plain `Bash` with no parens matches all Bash calls (equivalent to `Bash(**)`).

### Decision pipeline

```
function decide(toolCall, rules, mode):
  1. If mode === "bypassPermissions": return "allow" (audit-log the bypass)
  2. If mode === "plan" AND NOT isSideEffectFree(toolCall): return "deny"
  3. Evaluate rules in this order:
       a. Any deny rule matches → "deny"  (deny wins; document this clearly)
       b. Any ask rule matches  → "ask"
       c. Any allow rule matches → "allow"
  4. Fall through to mode default (see table above)
```

Rule evaluation is O(rules). For MVP that's fine; document complexity.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add picomatch@^4
bun add -d @types/picomatch
bun run typecheck
bun run test engine/src/permissions
bun run lint
```

### Expected output

- Matcher correctly parses and matches each Claude Code pattern.
- Engine produces the right decision for ~30 matrix cases (mode × rule × tool).
- Tests pass.

### Tests to add

- `rules.test.ts`:
  - Parse `Bash`, `Bash(git *)`, `Write(src/**)`, `mcp__github__*`.
  - Match: `Bash(git *)` matches `{tool: "Bash", input: {command: "git status"}}` but not `{command: "rm -rf /"}`.
  - Match: `Write(src/**)` matches `Write({path: "src/foo.ts"})` but not `Write({path: "etc/x"})`.
  - Match: `mcp__github__*` matches `mcp__github__create_issue` but not `mcp__linear__*`.
  - Invalid patterns → load-time error with file + reason.
- `engine.test.ts`:
  - `plan` mode denies `Bash`.
  - `bypassPermissions` allows everything, audit-logs the bypass.
  - Deny rule beats allow rule for same tool.
  - `acceptEdits` auto-allows `Write`/`Edit` but still asks on `Bash`.
  - `default` mode: reads allowed, writes ask, bash ask.
  - Ask handler injection: test calls `decide` with a handler that returns `"allow"` once, assert the allowed path.

### Verification

```bash
bun run test engine/src/permissions   # expect: all green
bun run typecheck
bun run lint

# Matrix dump (write engine/scripts/permissions-matrix.ts)
bun run tsx engine/scripts/permissions-matrix.ts
# expect: prints decision for each (mode, tool, rule) tuple for docs
```

### Common pitfalls

- **Deny wins is non-negotiable.** Write a test that fails if any future code reorders the pipeline.
- `picomatch` options: use `{ dot: true, nonegate: true }`. Do not let a user rule `!foo` accidentally turn deny into allow.
- `bash` command matching: match against the full original command string, not a parsed argv. `Bash(git *)` should match the user-intent glob, not token-by-token.
- Path arguments: normalize `./foo` and `foo` equivalently before matching (via `path.normalize`).
- `isSideEffectFree` for MCP: by default, NO. A future config can opt-in per tool: `{ "mcpTools": { "mcp__github__get_issue": "readonly" } }`.
- `ask` must never auto-resolve in non-interactive contexts — if no handler is provided, treat as `deny` and audit log it. Explicit `--permission-mode bypassPermissions` is the CI escape hatch, not silent ask→allow.
- Audit log: every decision → append JSON line to `~/.jellyclaw/logs/permissions.jsonl`. Include `{ts, sessionId, tool, input: <redacted>, decision, rule_matched?}`.
- Redact sensitive input fields (Bash commands containing the strings in `config.secrets`) before logging. Reuse the credential-strip helper from Phase 07.01 if reasonable.
- Do not couple permissions to hooks yet — prompt 02 does that via a `runHooks()` call injected into `decide`.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: 08.01 ✅, next prompt = prompts/phase-08/02-hooks-engine.md. -->
<!-- END paste -->

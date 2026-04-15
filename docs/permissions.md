# Permissions

Jellyclaw's permission engine gates every tool call against a combination of
**mode** (global policy) and **rules** (per-tool, per-pattern allow/ask/deny
lists). It lives in `engine/src/permissions/` and runs before any tool is
dispatched.

This layer is distinct from the intra-tool `PermissionService` under
`engine/src/tools/types.ts`. That service answers narrow key-based questions
like `bash.cd_escape` or `write.outside_cwd`; this layer gates the entire
tool call `(tool, input)` with a rule grammar that matches Claude Code's
`Tool(pattern)` syntax.

## Modes

| Mode                 | Behavior |
|----------------------|----------|
| `default`            | Read tools auto-allow; Bash/Write/Edit/etc. prompt via ask-handler; rules can override either direction. |
| `acceptEdits`        | Read + Write/Edit/MultiEdit/NotebookEdit auto-allow; Bash still prompts. |
| `bypassPermissions`  | Every tool allowed (CI / scripts). Still audit-logged. |
| `plan`               | Side-effectful tools refused. Only read-only tools (+ MCP tools tagged `readonly`) execute. |

The mode is set in `jellyclaw.json` under `permissions.mode` (default
`"default"`). A `--permission-mode` CLI flag lands in Phase 10.

## Rule grammar

Each rule string is one of:

```
Tool
Tool(pattern)
mcp__<server>__<tool>
mcp__<server>__*
```

- **Bare tool name** — matches every invocation of that tool. `Bash`, `Write`,
  `Read`, etc.
- **`Tool(pattern)`** — a [picomatch](https://github.com/micromatch/picomatch)
  glob applied to a per-tool argument string (see table below). `dot: true`,
  no negation inversion (`!` is literal — prevents `deny: ["!rm*"]`
  footguns).
- **MCP tool** — fully-qualified `mcp__<server>__<tool>`. A `*` leaf matches
  every tool on that server (`mcp__github__*`).

Invalid rule strings are collected as warnings and logged; the rest of the
block still compiles.

### Argument-string mapping

| Tool category         | Input field(s), in order     |
|-----------------------|------------------------------|
| Bash                  | `input.command`              |
| Write/Edit/MultiEdit/Read/Glob/Grep/Notebook* | `input.file_path` → `input.path` → `input.pattern` |
| WebFetch/WebSearch    | `input.url` → `input.query`  |
| MCP tools             | `JSON.stringify(input)`      |

Example rules:

```jsonc
{
  "permissions": {
    "mode": "default",
    "allow": ["Read", "Grep", "Bash(git *)"],
    "ask":   ["Write(src/**)"],
    "deny":  ["Bash(rm *)", "Bash(sudo *)", "WebFetch"]
  }
}
```

## Decision pipeline

For each tool call, in order:

1. **`bypassPermissions`** — always allow.
2. **`plan` + side-effectful** — always deny.
3. **Matching `deny` rule** — **deny wins.**
4. **Matching `ask` rule** — run ask-handler (interactive prompt, GUI, etc.).
5. **Matching `allow` rule** — allow.
6. **Mode fall-through** — no rule matched; apply the mode default.

### Deny-wins (invariant)

**A matching `deny` rule always beats any matching `allow` or `ask` rule for
the same call.** This is the core safety invariant; it lets an operator
paste broad `allow: ["Bash"]` lists without fear as long as narrower deny
rules cover the dangerous cases. It is covered by a dedicated regression test
in `engine/src/permissions/engine.test.ts`.

## Ask-flow

When the pipeline lands on `ask`:

- If an ask-handler is injected (e.g. `createStdinAskHandler()`), it is
  invoked and its `allow`/`deny` resolution is the final decision.
- If no handler is injected, or the handler throws, or the context is
  non-TTY — the decision is **deny**. The engine never silently allows.

The stdin ask-handler prompts `[y/N/a]`. `y` and `a` → allow; anything else
(including the default Enter) → deny.

## `acceptEdits` semantics

`acceptEdits` is intended for loops where the operator has accepted an
edit-plan up-front and does not want to re-confirm every `Write`. It
auto-allows `Read`, `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` as long
as no `deny` rule matches. `Bash` is still gated — if you want Bash
auto-allowed, either flip the mode to `bypassPermissions` or add explicit
`allow` rules like `Bash(git *)`.

## `plan` mode

`plan` never executes side-effectful tools. The built-in read-only set is
`{Read, Grep, Glob, LSP, NotebookRead, WebSearch}`. MCP tools are **denied
by default in plan mode** unless explicitly opted in:

```jsonc
{
  "permissions": {
    "mode": "plan",
    "mcpTools": {
      "mcp__github__get_issue": "readonly",
      "mcp__github__list_issues": "readonly"
    }
  }
}
```

The `readonly` tag only affects plan-mode side-effect classification; it does
not imply any rule.

## Example `jellyclaw.json`

```jsonc
{
  "permissions": {
    "mode": "default",
    "allow": [
      "Read",
      "Grep",
      "Glob",
      "Bash(git status)",
      "Bash(git diff*)"
    ],
    "ask": [
      "Write(src/**)",
      "Edit(src/**)"
    ],
    "deny": [
      "Bash(rm *)",
      "Bash(sudo *)",
      "Bash(curl *)",
      "WebFetch"
    ],
    "mcpTools": {
      "mcp__github__get_issue": "readonly"
    }
  }
}
```

## Audit log

Every decision writes a JSON-line record to
`~/.jellyclaw/logs/permissions.jsonl`:

```json
{"ts":"2026-04-15T10:22:33.111Z","sessionId":"abc","mode":"default","tool":"Bash","input":{"command":"echo [REDACTED]"},"decision":"allow","ruleMatched":"Bash","reason":"rule:Bash"}
```

Secrets passed in the `secrets` option of `decide()` are scrubbed from every
string value in `input` before write, mirroring the MCP credential scrubber
(`engine/src/mcp/credential-strip.ts`). Minimum secret length is 6
characters.

## Coming in later prompts

- **Hook rules + `PreToolUse`/`PostToolUse` events** — Phase 08 prompt 02.
- **`--permission-mode` CLI flag** — Phase 10.
- **GUI ask-handler (desktop shell)** — bridged in the jelly-claw integration.

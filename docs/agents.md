# Subagents

Subagents are isolated, role-scoped child sessions dispatched via the `Task`
tool. They mirror Claude Code's subagent concept: a named agent file defines
a system prompt, a tool allowlist, a model, and optional skills; the parent
session dispatches to one by calling `Task({ subagent_type, description,
prompt })` and receives a structured `SubagentResult` back.

> **Status:** Phase 06 Prompt 02 lands the dispatcher + event plumbing.
> The dispatcher is parameterised on a `SessionRunner` seam — production
> wiring to a real OpenCode child session ships in Phase 09.

## When to use Task vs inlining

Use `Task` when:

- The subproblem needs a **different tool allowlist** (e.g. read-only
  research without `Bash` / `Write`).
- The subproblem needs a **different system prompt** or a **different
  model**.
- You want a **clean transcript** — subagents start with no parent
  transcript, so large exploratory work does not pollute the parent's
  context window.

Inline (do not use `Task`) when:

- The work is short and fits the parent's existing prompt.
- You need back-and-forth with the user — subagents are single-shot.

## Agent file format

Agents live under one of three search roots (first-wins across them):

1. `~/.jellyclaw/agents/<name>.md` (user)
2. `<project>/.jellyclaw/agents/<name>.md` (project)
3. `<project>/agents/<name>.md` (legacy)

A file is Markdown with YAML frontmatter. Example (see Phase 06 Prompt 01
for more):

```markdown
---
name: explore
description: Read-only research subagent.
mode: subagent
model: claude-sonnet
tools: [Read, Grep, Glob]
skills: [repo-map]
max_turns: 20
max_tokens: 100000
---

You are a research subagent. Only read files. Summarise findings.
```

Frontmatter is validated by Zod at load time; the body is trimmed and
stored as the system prompt.

## Dispatch flow

```
parent.Task(input)
  -> SubagentDispatcher.dispatch()
     1. Registry.get(subagent_type)
        - miss -> emit synthetic subagent.end, return { status: "error" }
     2. Check depth (parent.depth + 1 <= maxDepth)
        - over -> emit end, return { status: "error" }
     3. semaphore.run(async () => {
     4.   buildSubagentContext(...)   // intersect tools, resolve model,
                                       // build systemPrompt (CLAUDE.md + body)
                                       // throws NoUsableToolsError on empty tools
     5.   emit subagent.start
     6.   link parent signal -> child AbortController
     7.   runner.run({ context, signal, onEvent: emit, clock })
     8.   map runner.reason -> SubagentResult.status
     9.   emit subagent.end
    10.   return SubagentResult
        })
```

## Configuration

Under `agents` in `jellyclaw.json`:

| key              | default | clamp    | meaning                                   |
| ---------------- | ------- | -------- | ----------------------------------------- |
| `maxConcurrency` | `3`     | `[1, 5]` | Max parallel subagent runs per engine.    |
| `maxDepth`       | `2`     | —        | Max nesting depth (root = 0).             |

Values above the ceiling are clamped with a `warn` log; sub-1 values snap
to 1.

## Isolation rules

A subagent starts in an isolated context built by `buildSubagentContext`:

- **Parent transcript is NOT inherited.** The child sees only its own
  `prompt` + agent `systemPrompt`.
- **Tools are intersected.** The effective allowlist is
  `agent.frontmatter.tools ∩ parent.allowedTools`, preserving the agent's
  declared order. If the intersection is empty, dispatch fails with
  `NoUsableToolsError` (surfaced as `{ status: "error" }`).
- **`CLAUDE.md` IS inherited.** If the parent loaded `CLAUDE.md`, it is
  prepended to the agent's system prompt (two blank lines between the two).
- **Skills are explicit.** Only the skills listed in the agent
  frontmatter are injected — the child does not inherit the parent's
  skill set.
- **Model falls through:** `agent.frontmatter.model ?? parent.model`.

## Event contract

Between `subagent.start` and `subagent.end`, the child forwards its own
`tool.call.start` / `tool.call.end` / `assistant.*` events via the
`onEvent` sink. Observers can therefore reconstruct the full child
transcript without any special protocol.

```
subagent.start
  tool.call.start
  tool.call.end
  tool.call.start
  tool.call.end
  ...
subagent.end
```

> **No `subagent.progress` variant exists.** The canonical 15-event
> protocol in `@jellyclaw/shared` has only `subagent.start` and
> `subagent.end`. Progress is carried by the interleaved tool events
> above. Do not add a third variant — downstream consumers (Claurst,
> Genie, the Tauri desktop app) are built against the 15-event set.

Both `subagent.start` and `subagent.end` carry the child's
`session_id`. The `start.parent_id` matches the dispatching parent's
`sessionId`. The `start.allowed_tools` matches
`context.allowedTools` after intersection.

## Error handling

The `Task` tool **never throws**. Every failure path surfaces as a
`SubagentResult` with `status: "error" | "cancelled" | "max_turns"` so
the parent turn can continue:

| scenario                          | status       | summary prefix              |
| --------------------------------- | ------------ | --------------------------- |
| unknown `subagent_type`           | `error`      | `unknown_agent: …`          |
| `ctx.subagents` not wired         | `error`      | `subagents_unavailable: …`  |
| Zod parse of Task input fails     | `error`      | `invalid_input: …`          |
| depth > `maxDepth`                | `error`      | `subagent_depth_exceeded: …`|
| tool intersection empty           | `error`      | `no_usable_tools: …`        |
| runner.reason === `"error"`       | `error`      | runner's summary            |
| runner.reason === `"max_turns"` / `"max_tokens"` | `max_turns` | runner's summary    |
| runner.reason === `"cancelled"`   | `cancelled`  | runner's summary            |
| dispatcher itself throws          | `error`      | `dispatch_error: …`         |

Returned `SubagentResult` is always JSON-serialisable — no Error
instances, no functions, no symbols.

## Limitations (pre-Phase 09)

- The dispatcher is parameterised on a `SessionRunner` — it does not yet
  spawn a real OpenCode child session. Production wiring ships in Phase
  09 and will wrap a new session bound to the engine's existing OpenCode
  server. Phase 06 tests supply a mock runner that scripts events and
  terminal reasons.
- Token-based termination (`reason: "max_tokens"`) maps to the public
  `max_turns` status because `SubagentResult.status` has four variants;
  the emitted `subagent.end` event still carries the true token count via
  `usage`.
- `cost_usd` on `SubagentUsage` is intentionally absent for now — the
  engine does not yet reconcile provider pricing at the subagent
  boundary.

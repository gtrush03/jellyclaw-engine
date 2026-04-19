---
phase: 06
name: "Subagent system + hook patch verification"
duration: "2 days"
depends_on: [01, 04, 05]
blocks: [08, 11, 12]
---

# Phase 06 — Subagent system

## Dream outcome

The `Task` tool spawns a subagent defined by a markdown file in `~/.jellyclaw/agents/` with YAML frontmatter. The subagent runs in an **isolated context window**, sees only its allowed tools + skills, and reports back a summary. `PreToolUse` / `PostToolUse` hooks fire inside the subagent (verified by the Phase 01 patch). Up to 5 subagents can run in parallel; a semaphore throttles concurrency.

## Deliverables

- `engine/src/agents/discovery.ts` + `parser.ts` + `registry.ts`
- `engine/src/agents/dispatch.ts` — Task tool handler
- `engine/src/agents/semaphore.ts` — concurrency gate (default 3, max 5)
- `engine/src/agents/context.ts` — isolated context builder
- Integration test: parent dispatches 3 parallel subagents, hooks fire inside all
- `docs/agents.md`

## Step-by-step

### Step 1 — Agent file format
```markdown
---
name: code-reviewer
description: Reviews a diff and returns findings
tools: [Read, Grep, Bash]
skills: []
model: claude-sonnet-4-5  # optional override
max_turns: 10
---

You are a senior reviewer. Output: {summary, findings[], risk_score}.
```

### Step 2 — Discovery
Paths: `~/.jellyclaw/agents/`, `.jellyclaw/agents/`, `.claude/agents/` (Genie compat).

### Step 3 — Task tool schema
```ts
{ name: "Task", input: { subagent_type: string, description: string, prompt: string } }
```

### Step 4 — Dispatch
`dispatch.ts`:
1. Resolve agent by `subagent_type`; 404 if unknown.
2. Acquire semaphore slot (wait if full).
3. Build isolated context: system = agent body + inherited CLAUDE.md, tools = intersection(agent.tools, parent.allowed_tools), skills = agent.skills.
4. Emit `subagent.start` event with parent id.
5. Run a new OpenCode session bound to the same server (separate sessionId).
6. Forward events upstream, tagging with subagent path.
7. On end, emit `subagent.end` with usage. Release slot.

### Step 5 — Hook propagation test
Write test that registers a `PreToolUse` hook, dispatches a `Task` that calls `Bash`, asserts the hook log contains a subagent-tagged entry. This validates the Phase 01 patch in the integrated flow.

### Step 6 — Parallel test
Dispatch 3 Tasks concurrently. Assert:
- All `subagent.start` events precede any `subagent.end`
- Semaphore holds cap
- Events are not interleaved within a single `tool_use_id`

### Step 7 — Budget guardrails
Per-subagent `max_turns` (default 20) + `max_tokens` (default 100k). Exceed → emit `subagent.end` with `reason: "max_turns"`.

## Acceptance criteria

- [ ] Agents discovered from 3 default paths
- [ ] Task tool schema matches Claude Code
- [ ] Isolated context: parent CLAUDE.md present, parent transcript NOT present
- [ ] Hooks fire inside subagents (regression-locked test)
- [ ] 3+ parallel subagents work without deadlock
- [ ] `max_turns` + `max_tokens` enforced

## Risks + mitigations

- **Semaphore deadlock if subagent spawns grand-subagent** → disallow nested Task calls beyond depth 2; configurable.
- **Hook patch regression on OpenCode upgrade** → CI runs hook-in-subagent test on every upstream rebase.
- **Runaway token usage** → hard budget with clean termination.

## Dependencies to install

```
p-limit@^6
```

## Files touched

- `engine/src/agents/{discovery,parser,registry,dispatch,semaphore,context}.ts`
- `engine/src/agents/*.test.ts`
- `docs/agents.md`
- `agents/` (example agents)

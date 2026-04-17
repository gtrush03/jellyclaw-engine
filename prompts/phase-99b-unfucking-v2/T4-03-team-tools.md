---
id: T4-03-team-tools
tier: 4
title: "TeamCreate / TeamDelete — multi-agent teammate spawn with per-agent tool subsets"
scope:
  - "engine/src/tools/team.ts"
  - "engine/src/tools/team.test.ts"
  - "engine/src/tools/index.ts"
  - "engine/src/agents/team-registry.ts"
  - "engine/src/agents/team-registry.test.ts"
  - "engine/src/agents/loop.ts"
  - "engine/src/events.ts"
  - "docs/tools/teams.md"
depends_on_fix:
  - T2-01-wire-mcp-tools-into-loop
  - T2-02-subagent-task-tool
tests:
  - name: team-create-spawns-members
    kind: shell
    description: "TeamCreate with 3 agents spawns 3 concurrent subagents via the Task tool machinery"
    command: "bun run test engine/src/tools/team -t team-create-spawns-3"
    expect_exit: 0
    timeout_sec: 60
  - name: team-members-run-in-parallel
    kind: shell
    description: "three agents with 400ms fake tool calls complete in <900ms wallclock, proving parallelism"
    command: "bun run test engine/src/tools/team -t runs-in-parallel"
    expect_exit: 0
    timeout_sec: 30
  - name: per-agent-tool-subset-enforced
    kind: shell
    description: "an agent declared with tools:['Read'] cannot call Bash; attempt returns a tool_error"
    command: "bun run test engine/src/tools/team -t per-agent-tool-subset"
    expect_exit: 0
    timeout_sec: 45
  - name: team-delete-cleans-up
    kind: shell
    description: "TeamDelete cancels in-flight members, reaps PIDs, and removes the team from the registry"
    command: "bun run test engine/src/tools/team -t team-delete-cleans-up"
    expect_exit: 0
    timeout_sec: 45
  - name: team-registry-isolated
    kind: shell
    description: "teams created in session A are not visible to session B (owner scoping)"
    command: "bun run test engine/src/agents/team-registry -t owner-scoping"
    expect_exit: 0
    timeout_sec: 20
human_gate: true
max_turns: 75
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 150
---

# T4-03 — TeamCreate / TeamDelete multi-agent spawn

## Context
Claude Code's `TeamCreate` lets a parent agent spin up a pre-declared set of teammate subagents, each with its own system prompt and tool subset, running concurrently. `TeamDelete` cancels and cleans up. This is the step beyond the single Task-tool subagent shipped in T2-02 — it formalises fleets of subagents as first-class objects, giving the top-level loop a way to orchestrate specialist teammates without re-inventing the spawn protocol per wish.

Reference material:
- `engine/src/agents/loop.ts:48-79` — `AgentLoopOptions`; the same options surface is used per teammate with narrowed `tools`.
- Task tool from T2-02 (`engine/src/tools/task.ts` — produced by that prior prompt) — this is the underlying subagent mechanism we reuse. `TeamCreate` is a fan-out wrapper around repeated `task.spawn()` calls.
- Claude Code surface we match:
  ```ts
  TeamCreate({
    team_id: string,
    members: Array<{
      agent_id: string,
      system_prompt: string,
      tools: string[],      // whitelist of tool names
      prompt: string,       // initial wish for this teammate
      model?: string,       // optional per-agent model override
    }>,
    max_concurrency?: number  // default = members.length
  })
  TeamDelete({ team_id: string })
  ```

## Root cause (from audit)
Right now, any "delegate three tasks" pattern forces the parent to issue three serial Task calls, blowing up wallclock and making cancellation impossible mid-flight. `TeamCreate` collapses this into one tool call with symmetric `TeamDelete` cleanup, and — critically — lets each teammate ship with its own tool subset (read-only researcher, write-enabled implementer, test-only runner), which today is inexpressible.

## Fix — exact change needed

### 1. `engine/src/agents/team-registry.ts` — in-memory + persisted registry
- A team is `{ team_id, owner_session, members: Member[], created_at, status: "running"|"cancelled"|"done" }`.
- `Member` holds `{ agent_id, subagent_id, tools: string[], system_prompt, prompt, model?, status, cancel: AbortController }`.
- Registry API: `createTeam(input) => team`, `getTeam(id, owner)`, `listTeams(owner)`, `cancelTeam(id, owner)`, `reap(id)`.
- Persistence: mirror the scheduler's SQLite approach at `<state-dir>/teams.db` with tables `teams` + `team_members`. A team survives the parent turn so `TeamDelete` can run on the next turn after `TeamCreate`. Use `better-sqlite3` + WAL (already a dep).
- Owner scoping: `getTeam`/`listTeams`/`cancelTeam` filter by the calling session's `owner_session`. Cross-session reads return `null`.

### 2. `engine/src/tools/team.ts` — the two tools
- `TeamCreate`:
  - Zod-validate input. `members.length` ∈ [1, 10] (hard cap: 10 concurrent teammates).
  - For each member, construct a per-member `AgentLoopOptions` with:
    - `systemPrompt` = member.system_prompt
    - `tools` = filter the parent's available tool set to `member.tools` (must be subset; any name not in the parent's set → `ToolError("unknown_tool", memberAgentId)` on creation and the whole call fails, no partial spawn).
    - `model` = member.model ?? parent model
    - `parentSessionId` = parent session id (for observability / hook chains)
  - Fan out with `p-limit` (already a dep, `package.json:50`) at `max_concurrency`. Do NOT wait for completion — return immediately with `{ team_id, members: [{agent_id, subagent_id, status:"running"}] }`. Members run async; their results stream back as `team.member.*` events (see §4).
  - Invariant: if any member fails to spawn, cancel all already-spawned members and return a `ToolError("spawn_failed", { member, cause })`.
- `TeamDelete`:
  - `getTeam(team_id, ownerSession)` or `ToolError("unknown_team")`.
  - For each running member: `member.cancel.abort()`, wait up to 5s for natural exit, then mark `cancelled`.
  - `reap(team_id)` — delete from registry.
  - Return `{ team_id, cancelled: number, already_done: number }`.

### 3. Tool-subset enforcement
- Today, `engine/src/agents/loop.ts` assumes the full builtin+MCP tool set per loop instance. Extend `AgentLoopOptions.tools` (currently implicit) into an explicit `allowedTools?: string[]` field. When set, `toolsAsProviderTools()` filters builtins + MCP to this whitelist; `executeTool` rejects any `tool_use` block whose `name` is not in the whitelist with a `tool_result{is_error:true, content:"tool not permitted for this agent: <name>"}`. No silent passthrough.
- This same mechanism is what Claude Code uses to run read-only sub-agents. It must be strict — a declared researcher that somehow emits a Bash `tool_use` MUST be rejected, not coerced.

### 4. Events
- Extend `engine/src/events.ts` with four new variants (respecting `exactOptionalPropertyTypes`):
  - `team.created` — `{ team_id, members: [{agent_id, subagent_id}] }`
  - `team.member.started` — `{ team_id, agent_id, subagent_id }`
  - `team.member.result` — `{ team_id, agent_id, status:"done"|"error"|"cancelled", output?: string, error?: { code, message } }`
  - `team.deleted` — `{ team_id, cancelled, already_done }`
- These events surface in the parent loop's stream exactly like `subagent.*` events (from T2-02). Dashboard and SSE consumers can subscribe without further changes.

### 5. Registration
- Append `TeamCreate` + `TeamDelete` to `engine/src/tools/index.ts`'s builtin registry.
- Gate TeamCreate behind the same hook surface as Bash / Write (i.e. PreToolUse can veto it). Adding a team of 10 agents is a big action; permission wiring matters.

### 6. `docs/tools/teams.md`
- Example: a parent agent that spawns a reviewer + implementer + tester team to land a PR. Includes a sample TeamCreate JSON body, expected event stream, and when to prefer a single Task tool call vs TeamCreate (rule of thumb: >1 concurrent agent with different tool subsets → Team; else Task).
- Document the 10-member hard cap and the 5s shutdown grace window.

### 7. Tests
- `team-create-spawns-3`: fake `task.spawn` stub, assert three invocations with the right `systemPrompt` / `allowedTools`.
- `runs-in-parallel`: each fake member sleeps 400ms; assert total wallclock <900ms (fails under serial execution).
- `per-agent-tool-subset`: a member with `tools:["Read"]` that emits a `Bash` tool_use block — assert the block is rejected with `"tool not permitted for this agent: Bash"` and no Bash handler ran (spy on `getTool("Bash")` call count).
- `team-delete-cleans-up`: spawn 3 long-running members, call TeamDelete, assert all three got `abort()`, registry row cleaned up, subsequent TeamDelete on same id → `unknown_team`.
- `team-registry-isolated`: sessions `A` and `B`; `A.createTeam` then `B.listTeams()` returns empty; `B.cancelTeam(A.team_id)` → `unknown_team`.

## Acceptance criteria
- `TeamCreate` spawns N concurrent subagents (maps to `team-create-spawns-members`).
- Members run in parallel (maps to `team-members-run-in-parallel`).
- Per-member tool whitelist is enforced at `executeTool` (maps to `per-agent-tool-subset-enforced`).
- `TeamDelete` cancels in-flight members and reaps registry (maps to `team-delete-cleans-up`).
- Registry entries are owner-scoped (maps to `team-registry-isolated`).
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT implement inter-teammate communication (no `TeamMessage`, no shared scratchpad). Teammates run independently; results bubble up through events. Cross-teammate coordination is a later tier.
- Do NOT implement team persistence beyond the current scheduler-daemon lifetime — teams evaporate on daemon restart and members in-flight are marked `cancelled` with reason `daemon_restart`.
- Do NOT extend the Task tool's output shape.
- Do NOT introduce a TeamList tool; `CronList` is the template, and a later prompt can add it if the need is real.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tools/team
bun run test engine/src/agents/team-registry
```

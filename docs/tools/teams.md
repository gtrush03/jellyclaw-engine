# Team Tools

## Overview

The `TeamCreate` and `TeamDelete` tools enable multi-agent coordination by spawning a team of concurrent subagents, each with its own system prompt and tool subset.

## TeamCreate

Spawns a team of concurrent subagents with individual system prompts and tool subsets. Returns immediately with running status; members run asynchronously.

### Input Schema

```json
{
  "team_id": "string (required)",
  "members": [
    {
      "agent_id": "string (required)",
      "system_prompt": "string (required)",
      "tools": ["string"] (required, whitelist of tool names),
      "prompt": "string (required, 1-8192 chars)",
      "model": "string (optional)"
    }
  ],
  "max_concurrency": "integer (optional, 1-10, default: members.length)"
}
```

### Example

```json
{
  "team_id": "pr-review-team",
  "members": [
    {
      "agent_id": "reviewer",
      "system_prompt": "You are a code reviewer. Focus on code quality, security, and best practices.",
      "tools": ["Read", "Grep", "Glob"],
      "prompt": "Review the changes in the PR and identify issues."
    },
    {
      "agent_id": "implementer",
      "system_prompt": "You are a developer. Implement the requested changes.",
      "tools": ["Read", "Write", "Edit", "Bash"],
      "prompt": "Fix the issues identified by the reviewer."
    },
    {
      "agent_id": "tester",
      "system_prompt": "You are a test engineer. Write and run tests.",
      "tools": ["Read", "Write", "Bash"],
      "prompt": "Run the test suite and verify all tests pass."
    }
  ],
  "max_concurrency": 3
}
```

### Output

```json
{
  "team_id": "pr-review-team",
  "members": [
    { "agent_id": "reviewer", "subagent_id": "subagent-abc123", "status": "running" },
    { "agent_id": "implementer", "subagent_id": "subagent-def456", "status": "running" },
    { "agent_id": "tester", "subagent_id": "subagent-ghi789", "status": "running" }
  ]
}
```

### Events

TeamCreate emits the following events:

- `team.created` — When the team is created
- `team.member.started` — When each member agent starts
- `team.member.result` — When each member completes (with status: "done", "error", or "cancelled")

## TeamDelete

Cancel and delete a team. Aborts all running members, waits up to 5 seconds for graceful shutdown, then removes from registry.

### Input Schema

```json
{
  "team_id": "string (required)"
}
```

### Output

```json
{
  "team_id": "pr-review-team",
  "cancelled": 2,
  "already_done": 1
}
```

### Events

- `team.deleted` — When the team is deleted, with cancelled and already_done counts

## Constraints

### Hard Limits

- **10-member cap**: A team can have at most 10 members.
- **5-second shutdown grace**: TeamDelete waits up to 5 seconds for members to exit gracefully before marking them as cancelled.

### Tool Subset Enforcement

Each member's `tools` array must be a subset of valid tool names. Invalid tool names cause the entire TeamCreate call to fail with an `unknown_tool` error.

Valid tool names include:
- Built-in tools: `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Task`, etc.
- MCP tools: Any tool name starting with `mcp__` (e.g., `mcp__github__create_issue`)

### Owner Scoping

Teams are scoped to the session that created them. A session cannot see, list, or cancel teams created by other sessions.

## When to Use Team vs Task

| Scenario | Use |
|----------|-----|
| Single subagent task | `Task` tool |
| Multiple independent tasks with different tool requirements | `TeamCreate` |
| Tasks that need different system prompts | `TeamCreate` |
| Tasks that should run in parallel | `TeamCreate` |
| Simple delegation to one specialist | `Task` tool |

**Rule of thumb**: Use `TeamCreate` when you need >1 concurrent agent with different tool subsets or system prompts. Otherwise, use the simpler `Task` tool.

## Error Handling

### TeamCreate Errors

- `team_exists`: A team with this ID already exists.
- `unknown_tool`: A member requested a tool that doesn't exist.
- `spawn_failed`: Failed to spawn one or more members.

### TeamDelete Errors

- `unknown_team`: The team ID doesn't exist or belongs to a different session.

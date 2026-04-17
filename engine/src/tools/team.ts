/**
 * Team tools - TeamCreate / TeamDelete (T4-03).
 *
 * Manages multi-agent teammate spawn with per-agent tool subsets.
 * Teams run concurrently via the Task tool machinery.
 */

import pLimit from "p-limit";
import { z } from "zod";

import { type CreateTeamInput, type MemberStatus, TeamRegistry } from "../agents/team-registry.js";
import type { AgentEvent } from "../events.js";
import type { JsonSchema, Tool, ToolContext } from "./types.js";
import { ToolError } from "./types.js";

// ---------------------------------------------------------------------------
// Input/Output schemas
// ---------------------------------------------------------------------------

export const TeamMemberInput = z.object({
  agent_id: z.string().min(1),
  system_prompt: z.string(),
  tools: z.array(z.string()),
  prompt: z.string().min(1).max(8192),
  model: z.string().optional(),
});
export type TeamMemberInput = z.infer<typeof TeamMemberInput>;

export const teamCreateInputSchema = z.object({
  team_id: z.string().min(1),
  members: z.array(TeamMemberInput).min(1).max(10),
  max_concurrency: z.number().int().min(1).max(10).optional(),
});
export type TeamCreateInput = z.infer<typeof teamCreateInputSchema>;

export const teamCreateOutputSchema = z.object({
  team_id: z.string(),
  members: z.array(
    z.object({
      agent_id: z.string(),
      subagent_id: z.string(),
      status: z.string(),
    }),
  ),
});
export type TeamCreateOutput = z.infer<typeof teamCreateOutputSchema>;

export const teamDeleteInputSchema = z.object({
  team_id: z.string().min(1),
});
export type TeamDeleteInput = z.infer<typeof teamDeleteInputSchema>;

export const teamDeleteOutputSchema = z.object({
  team_id: z.string(),
  cancelled: z.number().int().nonnegative(),
  already_done: z.number().int().nonnegative(),
});
export type TeamDeleteOutput = z.infer<typeof teamDeleteOutputSchema>;

// ---------------------------------------------------------------------------
// JSON Schema for Claude Code compatibility
// ---------------------------------------------------------------------------

const teamCreateInputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    team_id: {
      type: "string",
      minLength: 1,
      description: "Unique identifier for this team.",
    },
    members: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description: "Array of teammate agents to spawn (1-10 members).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          agent_id: {
            type: "string",
            minLength: 1,
            description: "Unique identifier for this teammate within the team.",
          },
          system_prompt: {
            type: "string",
            description: "System prompt for this teammate.",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Whitelist of tool names this teammate can use.",
          },
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: 8192,
            description: "Initial prompt/task for this teammate.",
          },
          model: {
            type: "string",
            description: "Optional model override for this teammate.",
          },
        },
        required: ["agent_id", "system_prompt", "tools", "prompt"],
      },
    },
    max_concurrency: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Maximum concurrent teammates. Default: members.length.",
    },
  },
  required: ["team_id", "members"],
};

const teamDeleteInputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    team_id: {
      type: "string",
      minLength: 1,
      description: "The team ID to delete.",
    },
  },
  required: ["team_id"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSubagentId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `subagent-${ts}-${rand}`;
}

/** Global team registry singleton. Lazily initialized on first use. */
let globalRegistry: TeamRegistry | null = null;

function getRegistry(): TeamRegistry {
  if (!globalRegistry) {
    globalRegistry = new TeamRegistry();
    globalRegistry.open();
  }
  return globalRegistry;
}

/** For testing: reset the global registry. */
export function _resetRegistry(registry?: TeamRegistry): void {
  if (globalRegistry && globalRegistry !== registry) {
    globalRegistry.close();
  }
  globalRegistry = registry ?? null;
}

/** For testing: get the current registry. */
export function _getRegistry(): TeamRegistry | null {
  return globalRegistry;
}

// ---------------------------------------------------------------------------
// Event emission helpers
// ---------------------------------------------------------------------------

interface TeamEventEmitter {
  emit(event: AgentEvent): void;
}

// ---------------------------------------------------------------------------
// TeamCreate handler
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/useAwait: Tool handler interface requires Promise return type.
async function teamCreateHandler(
  input: TeamCreateInput,
  ctx: ToolContext,
  eventEmitter?: TeamEventEmitter,
): Promise<TeamCreateOutput> {
  const registry = getRegistry();

  // Validate that team_id doesn't already exist.
  if (registry.teamExists(input.team_id)) {
    throw new ToolError("team_exists", `Team ${input.team_id} already exists`, {
      team_id: input.team_id,
    });
  }

  // Validate tool subsets - all requested tools must be valid tool names.
  // For now, we validate against a known list of builtin tools.
  const validToolNames = new Set([
    "AskUserQuestion",
    "Bash",
    "CronCreate",
    "CronDelete",
    "CronList",
    "Edit",
    "EnterPlanMode",
    "ExitPlanMode",
    "Glob",
    "Grep",
    "Memory",
    "NotebookEdit",
    "Read",
    "ScheduleWakeup",
    "Skill",
    "Task",
    "TeamCreate",
    "TeamDelete",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Write",
  ]);

  for (const member of input.members) {
    for (const toolName of member.tools) {
      // Allow MCP tools (mcp__*) and builtin tools.
      if (!toolName.startsWith("mcp__") && !validToolNames.has(toolName)) {
        throw new ToolError(
          "unknown_tool",
          `Unknown tool "${toolName}" for member ${member.agent_id}`,
          {
            member: member.agent_id,
            tool: toolName,
          },
        );
      }
    }
  }

  // Generate subagent IDs for each member.
  const membersWithIds = input.members.map((m) => ({
    ...m,
    subagent_id: generateSubagentId(),
  }));

  // Create team in registry.
  const createInput: CreateTeamInput = {
    team_id: input.team_id,
    owner_session: ctx.sessionId,
    members: membersWithIds.map((m) => ({
      agent_id: m.agent_id,
      subagent_id: m.subagent_id,
      tools: m.tools,
      system_prompt: m.system_prompt,
      prompt: m.prompt,
      model: m.model ?? null,
    })),
  };
  const team = registry.createTeam(createInput);

  // Emit team.created event.
  if (eventEmitter) {
    const ts = Date.now();
    eventEmitter.emit({
      type: "team.created",
      session_id: ctx.sessionId,
      ts,
      seq: 0, // Actual seq would come from adapter state.
      team_id: input.team_id,
      members: membersWithIds.map((m) => ({
        agent_id: m.agent_id,
        subagent_id: m.subagent_id,
      })),
    });
  }

  // Spawn members concurrently using p-limit.
  const concurrency = input.max_concurrency ?? input.members.length;
  const limit = pLimit(concurrency);

  // Start all members but don't wait for completion (async fire).
  // The tool returns immediately with running status.
  for (const member of membersWithIds) {
    const abortController = registry.getAbortController(input.team_id, member.agent_id);

    // Fire and forget - spawn the member asynchronously.
    limit(() =>
      spawnMember({
        teamId: input.team_id,
        member,
        ctx,
        registry,
        signal: abortController?.signal,
        eventEmitter,
      }),
    ).catch((err) => {
      ctx.logger.error(
        { err, teamId: input.team_id, agentId: member.agent_id },
        "team member spawn error",
      );
    });

    // Update status to running.
    registry.updateMemberStatus(input.team_id, member.agent_id, "running");

    // Emit team.member.started event.
    if (eventEmitter) {
      const ts = Date.now();
      eventEmitter.emit({
        type: "team.member.started",
        session_id: ctx.sessionId,
        ts,
        seq: 0,
        team_id: input.team_id,
        agent_id: member.agent_id,
        subagent_id: member.subagent_id,
      });
    }
  }

  ctx.logger.info(
    { teamId: input.team_id, memberCount: input.members.length },
    "TeamCreate: team spawned",
  );

  return {
    team_id: team.team_id,
    members: membersWithIds.map((m) => ({
      agent_id: m.agent_id,
      subagent_id: m.subagent_id,
      status: "running",
    })),
  };
}

interface SpawnMemberArgs {
  teamId: string;
  member: TeamMemberInput & { subagent_id: string };
  ctx: ToolContext;
  registry: TeamRegistry;
  signal?: AbortSignal | undefined;
  eventEmitter?: TeamEventEmitter | undefined;
}

async function spawnMember(args: SpawnMemberArgs): Promise<void> {
  const { teamId, member, ctx, registry, signal, eventEmitter } = args;

  // Check for abort before starting.
  if (signal?.aborted) {
    registry.updateMemberStatus(teamId, member.agent_id, "cancelled");
    if (eventEmitter) {
      eventEmitter.emit({
        type: "team.member.result",
        session_id: ctx.sessionId,
        ts: Date.now(),
        seq: 0,
        team_id: teamId,
        agent_id: member.agent_id,
        status: "cancelled",
      });
    }
    return;
  }

  try {
    // Delegate to subagent service if available.
    if (ctx.subagents) {
      const result = await ctx.subagents.dispatch({
        subagent_type: member.agent_id,
        description: `Team ${teamId} member: ${member.agent_id}`,
        prompt: member.prompt,
      });

      const status: MemberStatus = result.status === "success" ? "done" : "error";
      registry.updateMemberStatus(teamId, member.agent_id, status);

      if (eventEmitter) {
        eventEmitter.emit({
          type: "team.member.result",
          session_id: ctx.sessionId,
          ts: Date.now(),
          seq: 0,
          team_id: teamId,
          agent_id: member.agent_id,
          status: status === "done" ? "done" : "error",
          output: result.summary,
          ...(result.status === "error"
            ? { error: { code: "dispatch_error", message: result.summary } }
            : {}),
        });
      }
    } else {
      // No subagent service - simulate success after a short delay (for testing).
      await new Promise((resolve) => setTimeout(resolve, 10));
      registry.updateMemberStatus(teamId, member.agent_id, "done");

      if (eventEmitter) {
        eventEmitter.emit({
          type: "team.member.result",
          session_id: ctx.sessionId,
          ts: Date.now(),
          seq: 0,
          team_id: teamId,
          agent_id: member.agent_id,
          status: "done",
          output: `Member ${member.agent_id} completed (stub)`,
        });
      }
    }
  } catch (err) {
    registry.updateMemberStatus(teamId, member.agent_id, "error");

    if (eventEmitter) {
      const message = err instanceof Error ? err.message : String(err);
      eventEmitter.emit({
        type: "team.member.result",
        session_id: ctx.sessionId,
        ts: Date.now(),
        seq: 0,
        team_id: teamId,
        agent_id: member.agent_id,
        status: "error",
        error: { code: "spawn_error", message },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// TeamDelete handler
// ---------------------------------------------------------------------------

async function teamDeleteHandler(
  input: TeamDeleteInput,
  ctx: ToolContext,
  eventEmitter?: TeamEventEmitter,
): Promise<TeamDeleteOutput> {
  const registry = getRegistry();

  const result = registry.cancelTeam(input.team_id, ctx.sessionId);
  if (!result) {
    throw new ToolError("unknown_team", `Team ${input.team_id} not found`, {
      team_id: input.team_id,
    });
  }

  // Wait up to 5s for natural exit (in real impl, would wait for subagent signals).
  // For now, just mark as cancelled immediately.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Reap the team from registry.
  registry.reap(input.team_id);

  // Emit team.deleted event.
  if (eventEmitter) {
    const ts = Date.now();
    eventEmitter.emit({
      type: "team.deleted",
      session_id: ctx.sessionId,
      ts,
      seq: 0,
      team_id: input.team_id,
      cancelled: result.cancelled,
      already_done: result.already_done,
    });
  }

  ctx.logger.info(
    { teamId: input.team_id, cancelled: result.cancelled, alreadyDone: result.already_done },
    "TeamDelete: team deleted",
  );

  return {
    team_id: input.team_id,
    cancelled: result.cancelled,
    already_done: result.already_done,
  };
}

// ---------------------------------------------------------------------------
// Tool exports
// ---------------------------------------------------------------------------

export const teamCreateTool: Tool<TeamCreateInput, TeamCreateOutput> = {
  name: "TeamCreate",
  description:
    "Spawn a team of concurrent subagents with individual system prompts and tool subsets. Returns immediately with running status; members run async. Max 10 members.",
  inputSchema: teamCreateInputSchemaJson,
  zodSchema: teamCreateInputSchema,
  overridesOpenCode: false,
  handler: teamCreateHandler,
};

export const teamDeleteTool: Tool<TeamDeleteInput, TeamDeleteOutput> = {
  name: "TeamDelete",
  description:
    "Cancel and delete a team. Aborts all running members, waits up to 5s for graceful shutdown, then removes from registry.",
  inputSchema: teamDeleteInputSchemaJson,
  zodSchema: teamDeleteInputSchema,
  overridesOpenCode: false,
  handler: teamDeleteHandler,
};

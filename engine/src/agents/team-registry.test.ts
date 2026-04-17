/**
 * Tests for TeamRegistry (T4-03).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CreateTeamInput, TeamRegistry } from "./team-registry.js";

describe("TeamRegistry", () => {
  let tempDir: string;
  let registry: TeamRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-registry-test-"));
    registry = new TeamRegistry({ stateDir: tempDir });
    registry.open();
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("owner-scoping", () => {
    it("teams created in session A are not visible to session B", () => {
      const sessionA = "session-A-123";
      const sessionB = "session-B-456";

      // Session A creates a team.
      const input: CreateTeamInput = {
        team_id: "team-alpha",
        owner_session: sessionA,
        members: [
          {
            agent_id: "researcher",
            subagent_id: "subagent-001",
            tools: ["Read", "Grep"],
            system_prompt: "You are a researcher.",
            prompt: "Research the topic.",
            model: null,
          },
        ],
      };

      const team = registry.createTeam(input);
      expect(team.team_id).toBe("team-alpha");
      expect(team.owner_session).toBe(sessionA);

      // Session A can see the team.
      const teamFromA = registry.getTeam("team-alpha", sessionA);
      expect(teamFromA).toBeDefined();
      expect(teamFromA?.team_id).toBe("team-alpha");

      const teamsListA = registry.listTeams(sessionA);
      expect(teamsListA).toHaveLength(1);
      expect(teamsListA[0]?.team_id).toBe("team-alpha");

      // Session B CANNOT see the team.
      const teamFromB = registry.getTeam("team-alpha", sessionB);
      expect(teamFromB).toBeUndefined();

      const teamsListB = registry.listTeams(sessionB);
      expect(teamsListB).toHaveLength(0);

      // Session B CANNOT cancel the team.
      const cancelResult = registry.cancelTeam("team-alpha", sessionB);
      expect(cancelResult).toBeUndefined();

      // Session A CAN still see the team (not cancelled by B).
      const teamStillExists = registry.getTeam("team-alpha", sessionA);
      expect(teamStillExists).toBeDefined();
      expect(teamStillExists?.status).toBe("running");

      // Session A CAN cancel the team.
      const cancelResultA = registry.cancelTeam("team-alpha", sessionA);
      expect(cancelResultA).toBeDefined();
      expect(cancelResultA?.cancelled).toBeGreaterThanOrEqual(0);
    });
  });

  describe("basic operations", () => {
    it("creates a team with multiple members", () => {
      const input: CreateTeamInput = {
        team_id: "test-team",
        owner_session: "session-123",
        members: [
          {
            agent_id: "agent-1",
            subagent_id: "sub-1",
            tools: ["Read"],
            system_prompt: "Agent 1",
            prompt: "Task 1",
            model: null,
          },
          {
            agent_id: "agent-2",
            subagent_id: "sub-2",
            tools: ["Write"],
            system_prompt: "Agent 2",
            prompt: "Task 2",
            model: "claude-3-haiku",
          },
        ],
      };

      const team = registry.createTeam(input);

      expect(team.team_id).toBe("test-team");
      expect(team.members).toHaveLength(2);
      expect(team.members[0]?.agent_id).toBe("agent-1");
      expect(team.members[1]?.model).toBe("claude-3-haiku");
      expect(team.status).toBe("running");
    });

    it("teamExists returns true for existing teams", () => {
      registry.createTeam({
        team_id: "exists-team",
        owner_session: "session-1",
        members: [
          {
            agent_id: "a1",
            subagent_id: "s1",
            tools: [],
            system_prompt: "",
            prompt: "task",
            model: null,
          },
        ],
      });

      expect(registry.teamExists("exists-team")).toBe(true);
      expect(registry.teamExists("nonexistent")).toBe(false);
    });

    it("updateMemberStatus changes member status", () => {
      registry.createTeam({
        team_id: "status-team",
        owner_session: "session-1",
        members: [
          {
            agent_id: "a1",
            subagent_id: "s1",
            tools: [],
            system_prompt: "",
            prompt: "task",
            model: null,
          },
        ],
      });

      registry.updateMemberStatus("status-team", "a1", "running");

      const team = registry.getTeam("status-team", "session-1");
      expect(team?.members[0]?.status).toBe("running");

      registry.updateMemberStatus("status-team", "a1", "done");
      const teamAfter = registry.getTeam("status-team", "session-1");
      expect(teamAfter?.members[0]?.status).toBe("done");
    });

    it("reap removes team from registry", () => {
      registry.createTeam({
        team_id: "reap-team",
        owner_session: "session-1",
        members: [
          {
            agent_id: "a1",
            subagent_id: "s1",
            tools: [],
            system_prompt: "",
            prompt: "task",
            model: null,
          },
        ],
      });

      expect(registry.teamExists("reap-team")).toBe(true);
      registry.reap("reap-team");
      expect(registry.teamExists("reap-team")).toBe(false);
    });
  });
});

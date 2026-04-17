/**
 * Team registry for multi-agent spawn (T4-03).
 *
 * Manages teams of concurrent subagents with SQLite-backed persistence.
 * Teams survive the parent turn so TeamDelete can run on a subsequent turn.
 *
 * Uses `better-sqlite3` with WAL journal mode (already a dep from T4-01).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import Database from "better-sqlite3";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas - types flow FROM Zod (per CLAUDE.md convention)
// ---------------------------------------------------------------------------

export const TeamStatus = z.enum(["running", "cancelled", "done"]);
export type TeamStatus = z.infer<typeof TeamStatus>;

export const MemberStatus = z.enum(["pending", "running", "done", "error", "cancelled"]);
export type MemberStatus = z.infer<typeof MemberStatus>;

export const TeamMember = z.object({
  agent_id: z.string(),
  subagent_id: z.string(),
  tools: z.array(z.string()),
  system_prompt: z.string(),
  prompt: z.string(),
  model: z.string().nullable(),
  status: MemberStatus,
});
export type TeamMember = z.infer<typeof TeamMember>;

export const Team = z.object({
  team_id: z.string(),
  owner_session: z.string(),
  members: z.array(TeamMember),
  created_at: z.number().int(),
  status: TeamStatus,
});
export type Team = z.infer<typeof Team>;

export const CreateTeamInput = z.object({
  team_id: z.string().min(1),
  owner_session: z.string().min(1),
  members: z.array(
    z.object({
      agent_id: z.string().min(1),
      subagent_id: z.string().min(1),
      tools: z.array(z.string()),
      system_prompt: z.string(),
      prompt: z.string().min(1),
      model: z.string().nullable().optional(),
    }),
  ),
});
export type CreateTeamInput = z.infer<typeof CreateTeamInput>;

// ---------------------------------------------------------------------------
// Current schema version
// ---------------------------------------------------------------------------

const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Default path helpers
// ---------------------------------------------------------------------------

function defaultStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "jellyclaw");
  }
  return path.join(os.homedir(), ".jellyclaw");
}

export interface TeamRegistryOptions {
  /** Directory containing teams.db. */
  stateDir?: string | undefined;
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// In-memory abort controllers (not persisted - cleared on daemon restart)
// ---------------------------------------------------------------------------

interface RuntimeMember {
  abort: AbortController;
}

// ---------------------------------------------------------------------------
// TeamRegistry class
// ---------------------------------------------------------------------------

export class TeamRegistry {
  readonly dbPath: string;
  readonly stateDir: string;
  readonly #now: () => number;
  #db: DatabaseType | null = null;

  /** In-memory abort controllers for running members. */
  readonly #runtime: Map<string, Map<string, RuntimeMember>> = new Map();

  // Prepared statements (lazy-initialized after open).
  #stmtInsertTeam: Statement | null = null;
  #stmtInsertMember: Statement | null = null;
  #stmtGetTeam: Statement | null = null;
  #stmtListTeams: Statement | null = null;
  #stmtListMembers: Statement | null = null;
  #stmtUpdateTeamStatus: Statement | null = null;
  #stmtUpdateMemberStatus: Statement | null = null;
  #stmtDeleteTeam: Statement | null = null;
  #stmtDeleteMembers: Statement | null = null;

  constructor(opts: TeamRegistryOptions = {}) {
    this.stateDir = opts.stateDir ?? defaultStateDir();
    this.dbPath = path.join(this.stateDir, "teams.db");
    this.#now = opts.now ?? Date.now;
  }

  /** Open the database, run migrations, prepare statements. */
  open(): void {
    if (this.#db !== null) return;

    // Ensure state directory exists.
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });

    this.#db = new Database(this.dbPath);

    // Pragmas per spec.
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = NORMAL");
    this.#db.pragma("busy_timeout = 2000");
    this.#db.pragma("foreign_keys = ON");

    this.#migrate();
    this.#prepareStatements();
  }

  /** Close the database cleanly. */
  close(): void {
    if (this.#db === null) return;
    this.#db.close();
    this.#db = null;
    this.#stmtInsertTeam = null;
    this.#stmtInsertMember = null;
    this.#stmtGetTeam = null;
    this.#stmtListTeams = null;
    this.#stmtListMembers = null;
    this.#stmtUpdateTeamStatus = null;
    this.#stmtUpdateMemberStatus = null;
    this.#stmtDeleteTeam = null;
    this.#stmtDeleteMembers = null;
  }

  get isOpen(): boolean {
    return this.#db !== null;
  }

  // -------------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------------

  #migrate(): void {
    const db = this.#requireDb();

    // Create schema_version table if not exists.
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    const currentVersion = row?.version ?? 0;

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      return; // Already at current version.
    }

    // Migration v0 -> v1
    if (currentVersion < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS teams (
          team_id       TEXT PRIMARY KEY,
          owner_session TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          status        TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams (owner_session);

        CREATE TABLE IF NOT EXISTS team_members (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id       TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
          agent_id      TEXT NOT NULL,
          subagent_id   TEXT NOT NULL,
          tools         TEXT NOT NULL,
          system_prompt TEXT NOT NULL,
          prompt        TEXT NOT NULL,
          model         TEXT,
          status        TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members (team_id);
      `);
    }

    // Update schema_version.
    db.prepare("DELETE FROM schema_version").run();
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION);
  }

  #prepareStatements(): void {
    const db = this.#requireDb();

    this.#stmtInsertTeam = db.prepare(`
      INSERT INTO teams (team_id, owner_session, created_at, status)
      VALUES (@team_id, @owner_session, @created_at, @status)
    `);

    this.#stmtInsertMember = db.prepare(`
      INSERT INTO team_members (team_id, agent_id, subagent_id, tools, system_prompt, prompt, model, status)
      VALUES (@team_id, @agent_id, @subagent_id, @tools, @system_prompt, @prompt, @model, @status)
    `);

    this.#stmtGetTeam = db.prepare(`
      SELECT * FROM teams WHERE team_id = ? AND owner_session = ?
    `);

    this.#stmtListTeams = db.prepare(`
      SELECT * FROM teams WHERE owner_session = ? ORDER BY created_at DESC
    `);

    this.#stmtListMembers = db.prepare(`
      SELECT * FROM team_members WHERE team_id = ? ORDER BY id ASC
    `);

    this.#stmtUpdateTeamStatus = db.prepare(`
      UPDATE teams SET status = ? WHERE team_id = ?
    `);

    this.#stmtUpdateMemberStatus = db.prepare(`
      UPDATE team_members SET status = ? WHERE team_id = ? AND agent_id = ?
    `);

    this.#stmtDeleteTeam = db.prepare(`
      DELETE FROM teams WHERE team_id = ?
    `);

    this.#stmtDeleteMembers = db.prepare(`
      DELETE FROM team_members WHERE team_id = ?
    `);
  }

  #requireDb(): DatabaseType {
    if (this.#db === null) {
      throw new Error("TeamRegistry: database not open. Call open() first.");
    }
    return this.#db;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Create a new team. Returns the created Team object. */
  createTeam(input: CreateTeamInput): Team {
    const db = this.#requireDb();
    const now = this.#now();

    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtInsertTeam?.run({
        team_id: input.team_id,
        owner_session: input.owner_session,
        created_at: now,
        status: "running",
      });

      for (const member of input.members) {
        this.#stmtInsertMember?.run({
          team_id: input.team_id,
          agent_id: member.agent_id,
          subagent_id: member.subagent_id,
          tools: JSON.stringify(member.tools),
          system_prompt: member.system_prompt,
          prompt: member.prompt,
          model: member.model ?? null,
          status: "pending",
        });
      }

      db.exec("COMMIT");

      // Initialize runtime state.
      const runtimeMembers = new Map<string, RuntimeMember>();
      for (const member of input.members) {
        runtimeMembers.set(member.agent_id, { abort: new AbortController() });
      }
      this.#runtime.set(input.team_id, runtimeMembers);

      return {
        team_id: input.team_id,
        owner_session: input.owner_session,
        members: input.members.map((m) => ({
          agent_id: m.agent_id,
          subagent_id: m.subagent_id,
          tools: m.tools,
          system_prompt: m.system_prompt,
          prompt: m.prompt,
          model: m.model ?? null,
          status: "pending" as MemberStatus,
        })),
        created_at: now,
        status: "running",
      };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Get a team by ID and owner. Returns undefined if not found or not owned. */
  getTeam(teamId: string, owner: string): Team | undefined {
    const row = this.#stmtGetTeam?.get(teamId, owner) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const memberRows = this.#stmtListMembers?.all(teamId) as Record<string, unknown>[];
    const members = memberRows.map((m) => ({
      agent_id: m.agent_id as string,
      subagent_id: m.subagent_id as string,
      tools: JSON.parse(m.tools as string) as string[],
      system_prompt: m.system_prompt as string,
      prompt: m.prompt as string,
      model: (m.model as string) ?? null,
      status: m.status as MemberStatus,
    }));

    return {
      team_id: row.team_id as string,
      owner_session: row.owner_session as string,
      members,
      created_at: row.created_at as number,
      status: row.status as TeamStatus,
    };
  }

  /** List all teams for an owner. */
  listTeams(owner: string): Team[] {
    const rows = this.#stmtListTeams?.all(owner) as Record<string, unknown>[];
    return rows.map((row) => {
      const memberRows = this.#stmtListMembers?.all(row.team_id) as Record<string, unknown>[];
      const members = memberRows.map((m) => ({
        agent_id: m.agent_id as string,
        subagent_id: m.subagent_id as string,
        tools: JSON.parse(m.tools as string) as string[],
        system_prompt: m.system_prompt as string,
        prompt: m.prompt as string,
        model: (m.model as string) ?? null,
        status: m.status as MemberStatus,
      }));

      return {
        team_id: row.team_id as string,
        owner_session: row.owner_session as string,
        members,
        created_at: row.created_at as number,
        status: row.status as TeamStatus,
      };
    });
  }

  /** Cancel a team. Aborts all running members. Returns cancelled/already_done counts. */
  cancelTeam(
    teamId: string,
    owner: string,
  ): { cancelled: number; already_done: number } | undefined {
    const team = this.getTeam(teamId, owner);
    if (!team) return undefined;

    const db = this.#requireDb();
    let cancelled = 0;
    let already_done = 0;

    // Abort runtime controllers.
    const runtimeMembers = this.#runtime.get(teamId);
    for (const member of team.members) {
      if (member.status === "done" || member.status === "error") {
        already_done++;
      } else if (member.status === "pending" || member.status === "running") {
        const runtime = runtimeMembers?.get(member.agent_id);
        if (runtime) {
          runtime.abort.abort();
        }
        cancelled++;
      }
    }

    // Update database status.
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const member of team.members) {
        if (member.status === "pending" || member.status === "running") {
          this.#stmtUpdateMemberStatus?.run("cancelled", teamId, member.agent_id);
        }
      }
      this.#stmtUpdateTeamStatus?.run("cancelled", teamId);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    return { cancelled, already_done };
  }

  /** Remove a team from the registry (after cancellation/completion). */
  reap(teamId: string): void {
    const db = this.#requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtDeleteMembers?.run(teamId);
      this.#stmtDeleteTeam?.run(teamId);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    this.#runtime.delete(teamId);
  }

  /** Update a member's status. */
  updateMemberStatus(teamId: string, agentId: string, status: MemberStatus): void {
    this.#requireDb(); // Ensure DB is open.
    this.#stmtUpdateMemberStatus?.run(status, teamId, agentId);

    // Check if all members are done/error/cancelled -> update team status.
    const team = this.getTeamById(teamId);
    if (team) {
      const allDone = team.members.every(
        (m) => m.status === "done" || m.status === "error" || m.status === "cancelled",
      );
      if (allDone && team.status === "running") {
        this.#stmtUpdateTeamStatus?.run("done", teamId);
      }
    }
  }

  /** Get a team by ID without owner check (internal use). */
  getTeamById(teamId: string): Team | undefined {
    const db = this.#requireDb();
    const row = db.prepare("SELECT * FROM teams WHERE team_id = ?").get(teamId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;

    const memberRows = this.#stmtListMembers?.all(teamId) as Record<string, unknown>[];
    const members = memberRows.map((m) => ({
      agent_id: m.agent_id as string,
      subagent_id: m.subagent_id as string,
      tools: JSON.parse(m.tools as string) as string[],
      system_prompt: m.system_prompt as string,
      prompt: m.prompt as string,
      model: (m.model as string) ?? null,
      status: m.status as MemberStatus,
    }));

    return {
      team_id: row.team_id as string,
      owner_session: row.owner_session as string,
      members,
      created_at: row.created_at as number,
      status: row.status as TeamStatus,
    };
  }

  /** Get the abort controller for a member (for internal use). */
  getAbortController(teamId: string, agentId: string): AbortController | undefined {
    return this.#runtime.get(teamId)?.get(agentId)?.abort;
  }

  /** Check if a team exists for any owner. */
  teamExists(teamId: string): boolean {
    const db = this.#requireDb();
    const row = db.prepare("SELECT 1 FROM teams WHERE team_id = ?").get(teamId);
    return row !== undefined;
  }
}

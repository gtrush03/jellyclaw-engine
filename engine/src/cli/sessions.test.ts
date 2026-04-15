/**
 * `jellyclaw sessions` CLI tests.
 *
 * We spawn handler functions directly (no fork), with a tmp `JELLYCLAW_HOME`,
 * and spy on `process.stdout.write` / `process.stderr.write` to capture output.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb } from "../session/db.js";
import { projectHash as computeProjectHash, SessionPaths } from "../session/paths.js";
import { SessionWriter } from "../session/writer.js";

import {
  listCommand,
  reindexCommand,
  rmCommand,
  searchCommand,
  sessionsCommand,
  showCommand,
} from "./sessions.js";

interface Captured {
  out: string;
  err: string;
}

function captureIo(): { captured: Captured; restore: () => void } {
  const captured: Captured = { out: "", err: "" };
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    captured.out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    captured.err += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  return {
    captured,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

async function writeJsonlLines(path: string, events: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined);
  const body = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await appendFile(path, body, "utf8");
}

describe("jellyclaw sessions CLI", () => {
  let home: string;
  let originalEnvHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jellyclaw-cli-"));
    originalEnvHome = process.env.JELLYCLAW_HOME;
    process.env.JELLYCLAW_HOME = home;
    originalCwd = process.cwd();
  });

  afterEach(() => {
    if (originalEnvHome === undefined) {
      delete process.env.JELLYCLAW_HOME;
    } else {
      process.env.JELLYCLAW_HOME = originalEnvHome;
    }
    try {
      process.chdir(originalCwd);
    } catch {
      // best-effort
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("list: empty store prints header + 'no sessions' hint", async () => {
    const { captured, restore } = captureIo();
    try {
      const code = await listCommand([]);
      expect(code).toBe(0);
      expect(captured.out).toContain("ID");
      expect(captured.out).toContain("no sessions");
    } finally {
      restore();
    }
  });

  it("list: filters by current-project by default; --project all via --all", async () => {
    const paths = new SessionPaths({ home });
    const db = await openDb({ paths });
    try {
      const writer = new SessionWriter(db);
      await writer.upsertSession({
        id: "sess-a",
        projectHash: "aaaaaaaaaaaa",
        cwd: "/proj/a",
        model: "sonnet-4-6",
        createdAt: 100,
        lastTurnAt: 200,
        parentSessionId: null,
        status: "active",
        summary: "fix auth bug in login flow",
      });
      await writer.upsertSession({
        id: "sess-b",
        projectHash: "bbbbbbbbbbbb",
        cwd: "/proj/b",
        model: "sonnet-4-6",
        createdAt: 100,
        lastTurnAt: 300,
        parentSessionId: null,
        status: "active",
        summary: "refactor widget",
      });
    } finally {
      db.close();
    }

    // Filter explicitly by project "aaaaaaaaaaaa"
    {
      const { captured, restore } = captureIo();
      try {
        const code = await listCommand(["--project", "aaaaaaaaaaaa"]);
        expect(code).toBe(0);
        expect(captured.out).toContain("sess-a");
        expect(captured.out).not.toContain("sess-b");
      } finally {
        restore();
      }
    }

    // --all shows both
    {
      const { captured, restore } = captureIo();
      try {
        const code = await listCommand(["--all"]);
        expect(code).toBe(0);
        expect(captured.out).toContain("sess-a");
        expect(captured.out).toContain("sess-b");
      } finally {
        restore();
      }
    }
  });

  it("list --all shows archived sessions", async () => {
    const paths = new SessionPaths({ home });
    const db = await openDb({ paths });
    try {
      const writer = new SessionWriter(db);
      await writer.upsertSession({
        id: "sess-archived",
        projectHash: "ccccccccc111",
        cwd: "/proj/c",
        model: null,
        createdAt: 1,
        lastTurnAt: 1,
        parentSessionId: null,
        status: "archived",
        summary: "old",
      });
    } finally {
      db.close();
    }

    // Default excludes archived
    {
      const { captured, restore } = captureIo();
      try {
        await listCommand(["--project", "ccccccccc111"]);
        expect(captured.out).not.toContain("sess-archived");
      } finally {
        restore();
      }
    }

    {
      const { captured, restore } = captureIo();
      try {
        await listCommand(["--all"]);
        expect(captured.out).toContain("sess-archived");
      } finally {
        restore();
      }
    }
  });

  it("search: finds message matching query", async () => {
    const paths = new SessionPaths({ home });
    const db = await openDb({ paths });
    try {
      const writer = new SessionWriter(db);
      await writer.upsertSession({
        id: "sess-s1",
        projectHash: "ddddddddddd1",
        cwd: "/p",
        model: null,
        createdAt: 1,
        lastTurnAt: 1,
        parentSessionId: null,
        status: "active",
        summary: null,
      });
      await writer.upsertSession({
        id: "sess-s2",
        projectHash: "ddddddddddd1",
        cwd: "/p",
        model: null,
        createdAt: 2,
        lastTurnAt: 2,
        parentSessionId: null,
        status: "active",
        summary: null,
      });
      await writer.appendMessage({
        sessionId: "sess-s1",
        turnIndex: 0,
        role: "user",
        content: "please fix this auth bug in production",
        ts: 1,
      });
      await writer.appendMessage({
        sessionId: "sess-s2",
        turnIndex: 0,
        role: "user",
        content: "unrelated chatter about cats",
        ts: 2,
      });
      await writer.appendMessage({
        sessionId: "sess-s2",
        turnIndex: 1,
        role: "assistant",
        content: "weather report",
        ts: 3,
      });
    } finally {
      db.close();
    }

    const { captured, restore } = captureIo();
    try {
      const code = await searchCommand(["auth", "bug"]);
      expect(code).toBe(0);
      expect(captured.out).toContain("sess-s1");
      expect(captured.out).not.toContain("sess-s2");
      // snippet text should render (may contain ansi or not depending on TTY)
      expect(captured.out.toLowerCase()).toContain("auth");
    } finally {
      restore();
    }
  });

  it("show: seeded JSONL with messages + tool call + usage renders all sections", async () => {
    const projectHash = "eeeeeeeeeeee";
    const sessionId = "sess-show-1";
    const paths = new SessionPaths({ home });

    const db = await openDb({ paths });
    try {
      const writer = new SessionWriter(db);
      await writer.upsertSession({
        id: sessionId,
        projectHash,
        cwd: "/proj/show",
        model: "sonnet-4-6",
        createdAt: 1_700_000_000_000,
        lastTurnAt: 1_700_000_000_500,
        parentSessionId: null,
        status: "ended",
        summary: "all green",
      });
    } finally {
      db.close();
    }

    // Seed JSONL directly with valid AgentEvent lines.
    const logPath = paths.sessionLog(projectHash, sessionId);
    await mkdir(paths.projectDir(projectHash), { recursive: true });
    await writeJsonlLines(logPath, [
      {
        type: "session.started",
        session_id: sessionId,
        ts: 1_700_000_000_000,
        seq: 0,
        wish: "fix the thing",
        agent: "default",
        model: "sonnet-4-6",
        provider: "anthropic",
        cwd: "/proj/show",
      },
      {
        type: "agent.message",
        session_id: sessionId,
        ts: 1_700_000_000_100,
        seq: 1,
        delta: "Hello there.",
        final: true,
      },
      {
        type: "tool.called",
        session_id: sessionId,
        ts: 1_700_000_000_200,
        seq: 2,
        tool_id: "call-1",
        tool_name: "Read",
        input: { path: "/tmp/x" },
      },
      {
        type: "tool.result",
        session_id: sessionId,
        ts: 1_700_000_000_250,
        seq: 3,
        tool_id: "call-1",
        tool_name: "Read",
        output: { bytes: 42 },
        duration_ms: 50,
      },
      {
        type: "usage.updated",
        session_id: sessionId,
        ts: 1_700_000_000_300,
        seq: 4,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      {
        type: "session.completed",
        session_id: sessionId,
        ts: 1_700_000_000_500,
        seq: 5,
        turns: 1,
        duration_ms: 500,
      },
    ]);

    const { captured, restore } = captureIo();
    try {
      const code = await showCommand([sessionId]);
      expect(code).toBe(0);
      expect(captured.out).toContain(`session ${sessionId}`);
      expect(captured.out).toContain("messages:");
      expect(captured.out).toContain("fix the thing");
      expect(captured.out).toContain("Hello there.");
      expect(captured.out).toContain("tool calls:");
      expect(captured.out).toContain("Read");
      expect(captured.out).toContain("usage:");
      expect(captured.out).toContain("100 tokens");
    } finally {
      restore();
    }
  });

  it("show: unknown session prints error to stderr with exit code 1", async () => {
    const { captured, restore } = captureIo();
    try {
      const code = await showCommand(["does-not-exist"]);
      expect(code).toBe(1);
      expect(captured.err).toContain("session not found");
    } finally {
      restore();
    }
  });

  it("rm: moves files to .trash and archives session", async () => {
    const projectHash = "ffffffffffff";
    const sessionId = "sess-rm-1";
    const paths = new SessionPaths({ home });

    const db = await openDb({ paths });
    try {
      const writer = new SessionWriter(db);
      await writer.upsertSession({
        id: sessionId,
        projectHash,
        cwd: "/p",
        model: null,
        createdAt: 1,
        lastTurnAt: 1,
        parentSessionId: null,
        status: "active",
        summary: null,
      });
    } finally {
      db.close();
    }

    await mkdir(paths.projectDir(projectHash), { recursive: true });
    const logPath = paths.sessionLog(projectHash, sessionId);
    const metaPath = paths.sessionMeta(projectHash, sessionId);
    await appendFile(logPath, "{}\n", "utf8");
    await appendFile(`${logPath}.1`, "{}\n", "utf8");
    await appendFile(metaPath, "{}", "utf8");

    {
      const { restore } = captureIo();
      try {
        const code = await rmCommand([sessionId]);
        expect(code).toBe(0);
      } finally {
        restore();
      }
    }

    // Files moved to trash
    const trashDir = join(paths.sessionsRoot(), ".trash", projectHash, sessionId);
    const trashed = await readdir(trashDir);
    expect(trashed.sort()).toEqual(
      [`${sessionId}.jsonl`, `${sessionId}.jsonl.1`, `${sessionId}.meta.json`].sort(),
    );

    // Original files gone
    await expect(stat(logPath)).rejects.toThrow();

    // list (default) doesn't show it; list --all does.
    {
      const { captured, restore } = captureIo();
      try {
        await listCommand(["--project", projectHash]);
        expect(captured.out).not.toContain(sessionId);
      } finally {
        restore();
      }
    }
    {
      const { captured, restore } = captureIo();
      try {
        await listCommand(["--all"]);
        expect(captured.out).toContain(sessionId);
      } finally {
        restore();
      }
    }
  });

  it("rm: unknown session returns exit code 1", async () => {
    const { captured, restore } = captureIo();
    try {
      const code = await rmCommand(["nope"]);
      expect(code).toBe(1);
      expect(captured.err).toContain("session not found");
    } finally {
      restore();
    }
  });

  it("reindex: prints not-implemented message and exits 0", async () => {
    const { captured, restore } = captureIo();
    try {
      const code = await reindexCommand([]);
      expect(code).toBe(0);
      expect(captured.out).toContain("not yet implemented");
    } finally {
      restore();
    }
  });

  it("sessionsCommand: unknown subcommand returns 2", async () => {
    const { captured, restore } = captureIo();
    try {
      const code = await sessionsCommand(["bogus"]);
      expect(code).toBe(2);
      expect(captured.err).toContain("unknown sessions subcommand");
    } finally {
      restore();
    }
  });

  it("sessionsCommand: help prints usage", async () => {
    const { captured, restore } = captureIo();
    try {
      const code = await sessionsCommand(["help"]);
      expect(code).toBe(0);
      expect(captured.out).toContain("SUBCOMMANDS");
    } finally {
      restore();
    }
  });

  it("default list uses current-cwd project hash", async () => {
    // Confirm the default project filter is derived from process.cwd()
    const paths = new SessionPaths({ home });
    const myHash = computeProjectHash(process.cwd());
    const db = await openDb({ paths });
    try {
      const writer = new SessionWriter(db);
      await writer.upsertSession({
        id: "sess-cwd",
        projectHash: myHash,
        cwd: process.cwd(),
        model: null,
        createdAt: 1,
        lastTurnAt: 1,
        parentSessionId: null,
        status: "active",
        summary: "cwd session",
      });
      await writer.upsertSession({
        id: "sess-other",
        projectHash: "000000000000",
        cwd: "/other",
        model: null,
        createdAt: 1,
        lastTurnAt: 1,
        parentSessionId: null,
        status: "active",
        summary: "other",
      });
    } finally {
      db.close();
    }

    const { captured, restore } = captureIo();
    try {
      await listCommand([]);
      expect(captured.out).toContain("sess-cwd");
      expect(captured.out).not.toContain("sess-other");
    } finally {
      restore();
    }
  });
});

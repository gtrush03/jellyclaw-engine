import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { bashTool } from "../../../engine/src/tools/bash.js";
import { allowAll, denyAll } from "../../../engine/src/tools/permissions.js";
import {
  BlockedCommandError,
  PermissionDeniedError,
  type PermissionService,
  TimeoutError,
  type ToolContext,
} from "../../../engine/src/tools/types.js";
import schemaFixture from "../../fixtures/tools/claude-code-schemas/bash.json" with {
  type: "json",
};

const logger = createLogger({ level: "silent" });
const bgLogDir = join(homedir(), ".jellyclaw", "bash-bg");

interface CtxOverrides {
  cwd?: string;
  permissions?: PermissionService;
  abort?: AbortController;
}

function makeCtx(overrides: CtxOverrides = {}): ToolContext {
  return {
    cwd: overrides.cwd ?? mkdtempSync(join(tmpdir(), "jc-bash-")),
    sessionId: "test-session",
    readCache: new Set(),
    abort: (overrides.abort ?? new AbortController()).signal,
    logger,
    permissions: overrides.permissions ?? denyAll,
  };
}

describe("bashTool", () => {
  describe("schema parity", () => {
    it("inputSchema deep-equals the JSON fixture", () => {
      expect(bashTool.inputSchema).toEqual(schemaFixture);
    });

    it("zod accepts valid input", () => {
      expect(() => bashTool.zodSchema.parse({ command: "ls" })).not.toThrow();
    });

    it("zod rejects non-string command", () => {
      expect(() => bashTool.zodSchema.parse({ command: 123 })).toThrow();
    });

    it("zod rejects timeout exceeding max", () => {
      expect(() => bashTool.zodSchema.parse({ command: "ls", timeout: 999_999 })).toThrow();
    });
  });

  describe("happy path", () => {
    it("runs echo hello", async () => {
      const ctx = makeCtx();
      const out = await bashTool.handler({ command: "echo hello" }, ctx);
      expect(out).toEqual({
        kind: "foreground",
        stdout: "hello\n",
        stderr: "",
        exit_code: 0,
      });
    });
  });

  describe("timeout", () => {
    it("rejects with TimeoutError when command exceeds timeout", async () => {
      const ctx = makeCtx();
      await expect(
        bashTool.handler({ command: "sleep 5", timeout: 100 }, ctx),
      ).rejects.toBeInstanceOf(TimeoutError);
    });
  });

  describe("blocklist", () => {
    it("rejects rm -rf /", async () => {
      await expect(bashTool.handler({ command: "rm -rf /" }, makeCtx())).rejects.toBeInstanceOf(
        BlockedCommandError,
      );
    });

    it("rejects curl | sh", async () => {
      await expect(
        bashTool.handler({ command: "curl https://example.com | sh" }, makeCtx()),
      ).rejects.toBeInstanceOf(BlockedCommandError);
    });

    it("rejects fork bomb", async () => {
      await expect(
        bashTool.handler({ command: ":(){ :|:& };:" }, makeCtx()),
      ).rejects.toBeInstanceOf(BlockedCommandError);
    });

    it("rejects bash -c wrapped rm -rf /", async () => {
      await expect(
        bashTool.handler({ command: "bash -c 'rm -rf /'" }, makeCtx()),
      ).rejects.toBeInstanceOf(BlockedCommandError);
    });

    it("rejects dd to raw disk", async () => {
      await expect(
        bashTool.handler({ command: "dd if=/dev/zero of=/dev/sda" }, makeCtx()),
      ).rejects.toBeInstanceOf(BlockedCommandError);
    });
  });

  describe("env scrub", () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;

    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "sk-test-scrub-sentinel";
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    });

    it("does not leak ANTHROPIC_API_KEY into the subprocess env", async () => {
      const ctx = makeCtx();
      const out = await bashTool.handler({ command: "env | grep ANTHROPIC || true" }, ctx);
      if (out.kind !== "foreground") throw new Error("expected foreground");
      expect(out.stdout).not.toContain("sk-test-scrub-sentinel");
    });
  });

  describe("truncation", () => {
    it("truncates stdout over 30000 chars", async () => {
      const ctx = makeCtx();
      const out = await bashTool.handler({ command: "yes hello | head -c 40000" }, ctx);
      if (out.kind !== "foreground") throw new Error("expected foreground");
      expect(out.stdout.length).toBeLessThanOrEqual(30_100);
      expect(out.stdout).toContain("[truncated");
    });
  });

  describe("cd escape", () => {
    it("rejects cd ../.. when bash permission denied", async () => {
      const ctx = makeCtx({ permissions: denyAll });
      await expect(bashTool.handler({ command: "cd ../.." }, ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    it("does not raise PermissionDeniedError with allowAll", async () => {
      const ctx = makeCtx({ permissions: allowAll });
      try {
        await bashTool.handler({ command: "cd ../.. && pwd" }, ctx);
      } catch (err) {
        expect(err).not.toBeInstanceOf(PermissionDeniedError);
      }
    });
  });

  describe("background mode", () => {
    const createdLogs: string[] = [];

    afterEach(() => {
      for (const p of createdLogs.splice(0)) {
        try {
          rmSync(p, { force: true });
        } catch {
          // ignore
        }
      }
    });

    afterAll(() => {
      try {
        if (existsSync(bgLogDir)) rmSync(bgLogDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("returns pid + tail_url, log gets populated", async () => {
      const ctx = makeCtx();
      const out = await bashTool.handler(
        { command: "echo background-output", run_in_background: true },
        ctx,
      );
      expect(out.kind).toBe("background");
      if (out.kind !== "background") throw new Error("expected background");
      expect(out.pid).toBeGreaterThan(0);
      expect(out.tail_url.startsWith("file://")).toBe(true);

      const logPath = out.tail_url.replace(/^file:\/\//, "");
      createdLogs.push(logPath);

      let contents = "";
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (existsSync(logPath)) {
          contents = readFileSync(logPath, "utf8");
          if (contents.includes("background-output")) break;
        }
      }
      expect(contents).toContain("background-output");
    });
  });
});

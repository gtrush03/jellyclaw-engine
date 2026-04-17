/**
 * Tests for auth-cmd.ts (T3-10).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadCredentials } from "./credentials.js";

let tmpDir: string;
let credsPath: string;
let claudeCredsDir: string;
let claudeCredsPath: string;
let prevCredsEnv: string | undefined;
let prevHomeEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "jellyclaw-auth-"));
  credsPath = join(tmpDir, "credentials.json");
  claudeCredsDir = join(tmpDir, ".claude");
  claudeCredsPath = join(claudeCredsDir, ".credentials.json");

  prevCredsEnv = process.env.JELLYCLAW_CREDENTIALS_PATH;
  prevHomeEnv = process.env.HOME;

  process.env.JELLYCLAW_CREDENTIALS_PATH = credsPath;
  // Mock HOME so obtainSubscriptionCredentials reads from our test dir
  process.env.HOME = tmpDir;

  await mkdir(claudeCredsDir, { recursive: true });
});

afterEach(async () => {
  if (prevCredsEnv === undefined) delete process.env.JELLYCLAW_CREDENTIALS_PATH;
  else process.env.JELLYCLAW_CREDENTIALS_PATH = prevCredsEnv;

  if (prevHomeEnv === undefined) delete process.env.HOME;
  else process.env.HOME = prevHomeEnv;

  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("login-subscription-populates-creds", () => {
  it("writes subscription credentials after claude setup-token succeeds", async () => {
    // Write a fake Claude credentials file (simulating what claude setup-token would create)
    const fakeClaudeCreds = {
      claudeAiOauth: {
        accessToken: "fake-access-token-12345",
        refreshToken: "fake-refresh-token-abc",
        expiresAt: Date.now() + 3600_000,
      },
    };
    await writeFile(claudeCredsPath, JSON.stringify(fakeClaudeCreds), { mode: 0o600 });

    // Create a mock spawn that immediately succeeds
    vi.mock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: vi.fn(() => {
          // Return a fake child process that emits 'close' with code 0
          const EventEmitter = require("node:events");
          const fakeChild = new EventEmitter();
          fakeChild.kill = vi.fn();
          process.nextTick(() => fakeChild.emit("close", 0));
          return fakeChild;
        }),
      };
    });

    // Now import and run the action
    const { loginSubscriptionAction } = await import("./auth-cmd.js");

    // Capture stdout
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    const code = await loginSubscriptionAction();

    // Restore mocks
    vi.restoreAllMocks();

    expect(code).toBe(0);

    // Verify credentials were saved
    const loaded = await loadCredentials();
    expect(loaded.subscription).toBeDefined();
    expect(loaded.subscription?.kind).toBe("oauth");
    expect(loaded.subscription?.accessToken).toBe("fake-access-token-12345");
    expect(loaded.subscription?.refreshToken).toBe("fake-refresh-token-abc");
  });

  it("fails gracefully when Claude credentials file is missing", async () => {
    // Don't create the Claude credentials file

    vi.mock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: vi.fn(() => {
          const EventEmitter = require("node:events");
          const fakeChild = new EventEmitter();
          fakeChild.kill = vi.fn();
          process.nextTick(() => fakeChild.emit("close", 0));
          return fakeChild;
        }),
      };
    });

    const { loginSubscriptionAction } = await import("./auth-cmd.js");

    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await loginSubscriptionAction();

    vi.restoreAllMocks();

    expect(code).toBe(1);
    expect(errors.join("")).toContain("Failed to obtain subscription credentials");
  });
});

describe("auth status", () => {
  it("reports no credentials when file is empty", async () => {
    const { statusAction } = await import("./auth-cmd.js");

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    const code = await statusAction();

    vi.restoreAllMocks();

    expect(code).toBe(0);
    const text = output.join("");
    expect(text).toContain("Anthropic API key: not set");
    expect(text).toContain("Subscription OAuth: not set");
  });

  it("reports present credentials without exposing tokens", async () => {
    const { saveCredentials } = await import("./credentials.js");
    await saveCredentials({
      anthropicApiKey: "sk-ant-api03-test12345",
      subscription: {
        kind: "oauth",
        accessToken: "secret-token-here",
        obtainedAt: Date.now(),
      },
    });

    const { statusAction } = await import("./auth-cmd.js");

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    const code = await statusAction();

    vi.restoreAllMocks();

    expect(code).toBe(0);
    const text = output.join("");
    expect(text).toContain("Anthropic API key: present");
    expect(text).toContain("Subscription OAuth: present");
    // Verify tokens are NOT in output
    expect(text).not.toContain("sk-ant-api03-test12345");
    expect(text).not.toContain("secret-token-here");
  });
});

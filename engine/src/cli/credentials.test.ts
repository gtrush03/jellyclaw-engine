/**
 * Tests for `engine/src/cli/credentials.ts`.
 *
 * Each test uses an isolated tmp dir via `fs.mkdtemp` and sets
 * `JELLYCLAW_CREDENTIALS_PATH` so `defaultCredentialsPath()` resolves there.
 */

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CredentialsSchema,
  credentialsFileExists,
  defaultCredentialsPath,
  loadCredentials,
  saveCredentials,
  updateCredentials,
} from "./credentials.js";

let tmpDir: string;
let credsPath: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "jellyclaw-creds-"));
  credsPath = join(tmpDir, "credentials.json");
  prevEnv = process.env.JELLYCLAW_CREDENTIALS_PATH;
  process.env.JELLYCLAW_CREDENTIALS_PATH = credsPath;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.JELLYCLAW_CREDENTIALS_PATH;
  else process.env.JELLYCLAW_CREDENTIALS_PATH = prevEnv;
});

describe("credentials — schema", () => {
  it("accepts a valid key", () => {
    const r = CredentialsSchema.safeParse({ anthropicApiKey: "sk-ant-xxxxxxxxxxx" });
    expect(r.success).toBe(true);
  });

  it("rejects a short key", () => {
    const r = CredentialsSchema.safeParse({ anthropicApiKey: "short" });
    expect(r.success).toBe(false);
  });

  it("accepts an empty object (no keys yet)", () => {
    const r = CredentialsSchema.safeParse({});
    expect(r.success).toBe(true);
  });
});

describe("credentials — path override", () => {
  it("defaultCredentialsPath honours JELLYCLAW_CREDENTIALS_PATH", () => {
    expect(defaultCredentialsPath()).toBe(credsPath);
  });
});

describe("credentials — save/load roundtrip", () => {
  it("saves and loads the same payload", async () => {
    const payload = { anthropicApiKey: "sk-ant-api03-abcdefghij" };
    await saveCredentials(payload);
    const loaded = await loadCredentials();
    expect(loaded).toStrictEqual(payload);
  });

  it("writes the file with mode 0o600", async () => {
    await saveCredentials({ anthropicApiKey: "sk-ant-api03-abcdefghij" });
    const s = await stat(credsPath);
    // mask to permission bits only
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writes the dir with mode 0o700", async () => {
    await saveCredentials({ anthropicApiKey: "sk-ant-api03-abcdefghij" });
    const s = await stat(tmpDir);
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("credentials — load robustness", () => {
  it("returns {} when file is missing", async () => {
    const loaded = await loadCredentials();
    expect(loaded).toStrictEqual({});
  });

  it("returns {} when file is invalid JSON", async () => {
    await writeFile(credsPath, "not json at all", { mode: 0o600 });
    const loaded = await loadCredentials();
    expect(loaded).toStrictEqual({});
  });

  it("returns {} when schema rejects the payload (short key)", async () => {
    await writeFile(
      credsPath,
      JSON.stringify({ anthropicApiKey: "nope" }),
      { mode: 0o600 },
    );
    const loaded = await loadCredentials();
    expect(loaded).toStrictEqual({});
  });

  it("ignores unknown fields (zod strips by default)", async () => {
    await writeFile(
      credsPath,
      JSON.stringify({
        anthropicApiKey: "sk-ant-api03-abcdefghij",
        someJunk: "ignored",
      }),
      { mode: 0o600 },
    );
    const loaded = await loadCredentials();
    // zod default is `strip`, so unknown fields are removed.
    expect(loaded).toStrictEqual({ anthropicApiKey: "sk-ant-api03-abcdefghij" });
  });
});

describe("credentials — save atomicity & validation", () => {
  it("rejects short keys at save time", async () => {
    await expect(saveCredentials({ anthropicApiKey: "x" })).rejects.toThrow();
  });

  it("writes atomically (no .tmp left behind)", async () => {
    await saveCredentials({ anthropicApiKey: "sk-ant-api03-abcdefghij" });
    await expect(stat(`${credsPath}.tmp`)).rejects.toThrow();
    // Verify body is well-formed JSON ending with a newline.
    const raw = await readFile(credsPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("overwrites atomically on subsequent saves", async () => {
    await saveCredentials({ anthropicApiKey: "sk-ant-api03-firstkeyyy" });
    await saveCredentials({ anthropicApiKey: "sk-ant-api03-secondkeyy" });
    const loaded = await loadCredentials();
    expect(loaded.anthropicApiKey).toBe("sk-ant-api03-secondkeyy");
    const s = await stat(credsPath);
    expect(s.mode & 0o777).toBe(0o600);
  });
});

describe("credentials — updateCredentials merge", () => {
  it("preserves existing fields when patching", async () => {
    await saveCredentials({
      anthropicApiKey: "sk-ant-api03-abcdefghij",
      openaiApiKey: "sk-proj-openaiiiiii",
    });
    const merged = await updateCredentials({ anthropicApiKey: "sk-ant-api03-rotatedkey" });
    expect(merged.anthropicApiKey).toBe("sk-ant-api03-rotatedkey");
    expect(merged.openaiApiKey).toBe("sk-proj-openaiiiiii");
    const loaded = await loadCredentials();
    expect(loaded).toStrictEqual(merged);
  });
});

describe("credentials — credentialsFileExists", () => {
  it("returns false when the file is missing", async () => {
    expect(await credentialsFileExists()).toBe(false);
  });

  it("returns true after a save", async () => {
    await saveCredentials({ anthropicApiKey: "sk-ant-api03-abcdefghij" });
    expect(await credentialsFileExists()).toBe(true);
  });
});

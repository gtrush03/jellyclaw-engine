/**
 * Tests for the MCP OAuth token store.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenStore, TokenStoreInsecureError } from "./token-store.js";

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jellyclaw-tokenstore-"));
  storePath = path.join(tmpDir, "mcp-tokens.json");
});

afterEach(async () => {
  // Restore permissions so cleanup can traverse/delete everything.
  await fs.chmod(tmpDir, 0o700).catch(() => undefined);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("TokenStore — empty / round-trip", () => {
  it("loads cleanly when the file does not exist", async () => {
    const store = new TokenStore({ path: storePath });
    await store.load();
    expect(await store.get("anything")).toBeUndefined();
  });

  it("round-trips a single entry through a fresh instance", async () => {
    const a = new TokenStore({ path: storePath });
    await a.load();
    await a.set("srv", { accessToken: "a-token-value" });

    const b = new TokenStore({ path: storePath });
    await b.load();
    expect(await b.get("srv")).toEqual({ accessToken: "a-token-value" });
  });

  it("round-trips all optional fields", async () => {
    const a = new TokenStore({ path: storePath });
    await a.load();
    await a.set("srv", {
      accessToken: "acc",
      refreshToken: "ref",
      expiresAt: 1_700_000_000_000,
      scope: "read write",
      tokenType: "Bearer",
    });

    const b = new TokenStore({ path: storePath });
    await b.load();
    expect(await b.get("srv")).toEqual({
      accessToken: "acc",
      refreshToken: "ref",
      expiresAt: 1_700_000_000_000,
      scope: "read write",
      tokenType: "Bearer",
    });
  });
});

describe("TokenStore — file mode", () => {
  it("writes the file with mode 0600", async () => {
    const store = new TokenStore({ path: storePath });
    await store.load();
    await store.set("srv", { accessToken: "a" });
    const stat = await fs.stat(storePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("does not leave a .tmp file behind on a successful write", async () => {
    const store = new TokenStore({ path: storePath });
    await store.load();
    await store.set("srv", { accessToken: "a" });
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("refuses world-readable files (0o644)", async () => {
    await fs.writeFile(storePath, "{}", { mode: 0o644 });
    await fs.chmod(storePath, 0o644);
    const store = new TokenStore({ path: storePath });
    await expect(store.load()).rejects.toBeInstanceOf(TokenStoreInsecureError);
  });

  it("refuses world-readable files (0o604)", async () => {
    await fs.writeFile(storePath, "{}", { mode: 0o604 });
    await fs.chmod(storePath, 0o604);
    const store = new TokenStore({ path: storePath });
    await expect(store.load()).rejects.toBeInstanceOf(TokenStoreInsecureError);
  });

  it("refuses group-readable files (0o640)", async () => {
    await fs.writeFile(storePath, "{}", { mode: 0o640 });
    await fs.chmod(storePath, 0o640);
    const store = new TokenStore({ path: storePath });
    await expect(store.load()).rejects.toBeInstanceOf(TokenStoreInsecureError);
  });

  it("refuses group-writable files (0o660)", async () => {
    await fs.writeFile(storePath, "{}", { mode: 0o660 });
    await fs.chmod(storePath, 0o660);
    const store = new TokenStore({ path: storePath });
    await expect(store.load()).rejects.toBeInstanceOf(TokenStoreInsecureError);
  });

  it("accepts 0o600", async () => {
    await fs.writeFile(storePath, "{}", { mode: 0o600 });
    await fs.chmod(storePath, 0o600);
    const store = new TokenStore({ path: storePath });
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("accepts 0o400", async () => {
    await fs.writeFile(storePath, "{}", { mode: 0o600 });
    await fs.chmod(storePath, 0o400);
    const store = new TokenStore({ path: storePath });
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("accepts 0o700 (owner-only, execute bit set)", async () => {
    await fs.writeFile(storePath, "{}", { mode: 0o600 });
    await fs.chmod(storePath, 0o700);
    const store = new TokenStore({ path: storePath });
    await expect(store.load()).resolves.toBeUndefined();
  });
});

describe("TokenStore — multi-server + delete", () => {
  it("persists and retrieves multiple servers", async () => {
    const store = new TokenStore({ path: storePath });
    await store.load();
    await store.set("one", { accessToken: "aaa" });
    await store.set("two", { accessToken: "bbb", refreshToken: "rrr" });

    const reopened = new TokenStore({ path: storePath });
    await reopened.load();
    expect(await reopened.get("one")).toEqual({ accessToken: "aaa" });
    expect(await reopened.get("two")).toEqual({ accessToken: "bbb", refreshToken: "rrr" });
  });

  it("delete removes the entry and leaves others intact", async () => {
    const store = new TokenStore({ path: storePath });
    await store.load();
    await store.set("one", { accessToken: "aaa" });
    await store.set("two", { accessToken: "bbb" });
    await store.delete("one");

    expect(await store.get("one")).toBeUndefined();
    expect(await store.get("two")).toEqual({ accessToken: "bbb" });

    const reopened = new TokenStore({ path: storePath });
    await reopened.load();
    expect(await reopened.get("one")).toBeUndefined();
    expect(await reopened.get("two")).toEqual({ accessToken: "bbb" });
  });

  it("delete of a missing entry is a no-op", async () => {
    const store = new TokenStore({ path: storePath });
    await store.load();
    await store.delete("never-existed");
    expect(await store.get("never-existed")).toBeUndefined();
  });
});

describe("TokenStore — lifecycle guards", () => {
  it("throws on get() before load()", async () => {
    const store = new TokenStore({ path: storePath });
    await expect(store.get("srv")).rejects.toThrow(/load\(\) must be called first/);
  });

  it("throws on set() before load()", async () => {
    const store = new TokenStore({ path: storePath });
    await expect(store.set("srv", { accessToken: "a" })).rejects.toThrow(
      /load\(\) must be called first/,
    );
  });

  it("throws on delete() before load()", async () => {
    const store = new TokenStore({ path: storePath });
    await expect(store.delete("srv")).rejects.toThrow(/load\(\) must be called first/);
  });
});

describe("TokenStore — error messages never leak tokens", () => {
  it("scrubs the access token from a write failure", async () => {
    if (process.platform === "win32") return;

    const secretToken = `super-secret-access-token-${"x".repeat(64)}`;
    const lockedDir = path.join(tmpDir, "locked");
    await fs.mkdir(lockedDir, { mode: 0o700 });
    const lockedPath = path.join(lockedDir, "mcp-tokens.json");

    const store = new TokenStore({ path: lockedPath });
    await store.load();
    // Write a first entry successfully so subsequent redaction has
    // something to redact — then lock the directory so the next write
    // fails inside `#persist`.
    await store.set("srv", { accessToken: secretToken });
    await fs.chmod(lockedDir, 0o500);

    let caught: unknown;
    try {
      await store.set("srv", { accessToken: secretToken, scope: "new" });
    } catch (err) {
      caught = err;
    }
    // Restore immediately so afterEach cleanup works even if assertions throw.
    await fs.chmod(lockedDir, 0o700);

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(secretToken);
  });
});

describe("TokenStore — path property", () => {
  it("exposes the path that was passed in", () => {
    const store = new TokenStore({ path: storePath });
    expect(store.path).toBe(storePath);
  });
});

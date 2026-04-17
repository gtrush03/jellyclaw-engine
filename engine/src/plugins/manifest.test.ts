/**
 * Tests for plugin manifest loading (T4-05).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isValidPluginId, loadManifest, PluginManifest } from "./manifest.js";

describe("PluginManifest schema", () => {
  it("accepts a minimal valid manifest", () => {
    const result = PluginManifest.safeParse({
      id: "my-plugin",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("my-plugin");
      expect(result.data.version).toBe("1.0.0");
    }
  });

  it("accepts a full manifest", () => {
    const result = PluginManifest.safeParse({
      id: "my-plugin",
      version: "2.3.4-beta.1",
      description: "A test plugin",
      homepage: "https://example.com",
      author: "Test Author",
      engines: { jellyclaw: ">=0.1.0" },
      permissions: {
        tools: ["Bash", "Read"],
        fs_write: ["/tmp"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid id (uppercase)", () => {
    const result = PluginManifest.safeParse({
      id: "MyPlugin",
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid id (starts with number)", () => {
    const result = PluginManifest.safeParse({
      id: "123-plugin",
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid version", () => {
    const result = PluginManifest.safeParse({
      id: "my-plugin",
      version: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid homepage URL", () => {
    const result = PluginManifest.safeParse({
      id: "my-plugin",
      version: "1.0.0",
      homepage: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

describe("isValidPluginId", () => {
  it("accepts valid ids", () => {
    expect(isValidPluginId("my-plugin")).toBe(true);
    expect(isValidPluginId("a")).toBe(true);
    expect(isValidPluginId("plugin-123")).toBe(true);
    expect(isValidPluginId("a-b-c")).toBe(true);
  });

  it("rejects invalid ids", () => {
    expect(isValidPluginId("")).toBe(false);
    expect(isValidPluginId("MyPlugin")).toBe(false);
    expect(isValidPluginId("123-plugin")).toBe(false);
    expect(isValidPluginId("plugin_name")).toBe(false);
    expect(isValidPluginId("plugin.name")).toBe(false);
  });
});

describe("loadManifest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads a valid manifest", () => {
    const pluginDir = path.join(tempDir, "my-plugin");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ id: "my-plugin", version: "1.0.0" }),
    );

    const result = loadManifest(pluginDir);
    expect(result.kind).toBe("ok");
    expect(result.plugin).toBeDefined();
    expect(result.plugin?.manifest.id).toBe("my-plugin");
  });

  it("returns missing for non-existent manifest", () => {
    const pluginDir = path.join(tempDir, "no-manifest");
    fs.mkdirSync(pluginDir);

    const result = loadManifest(pluginDir);
    expect(result.kind).toBe("missing");
    expect(result.error).toContain("plugin.json not found");
  });

  it("invalid-manifest-skipped: returns invalid for malformed JSON", () => {
    const pluginDir = path.join(tempDir, "bad-json");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), "{ invalid json }");

    const result = loadManifest(pluginDir);
    expect(result.kind).toBe("invalid");
    expect(result.error).toContain("failed to parse");
  });

  it("returns invalid for schema violations", () => {
    const pluginDir = path.join(tempDir, "bad-schema");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ id: "InvalidId", version: "bad" }),
    );

    const result = loadManifest(pluginDir);
    expect(result.kind).toBe("invalid");
    expect(result.error).toContain("invalid plugin.json");
  });

  it("sets component directory paths", () => {
    const pluginDir = path.join(tempDir, "full-plugin");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ id: "full-plugin", version: "1.0.0" }),
    );

    const result = loadManifest(pluginDir);
    expect(result.kind).toBe("ok");
    expect(result.plugin?.skillsDir).toBe(path.join(pluginDir, "skills"));
    expect(result.plugin?.agentsDir).toBe(path.join(pluginDir, "agents"));
    expect(result.plugin?.commandsDir).toBe(path.join(pluginDir, "commands"));
    expect(result.plugin?.hooksDir).toBe(path.join(pluginDir, "hooks"));
  });
});

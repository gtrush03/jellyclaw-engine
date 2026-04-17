/**
 * Tests for the Skill tool.
 */

import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../skills/registry.js";
import type { Skill } from "../skills/types.js";
import { createSkillTool, skillInputSchema, UnknownSkillError } from "./skill.js";
import { makePermissionService, type ToolContext } from "./types.js";

function makeTestContext(): ToolContext {
  return {
    cwd: "/tmp",
    sessionId: "test-session",
    readCache: new Set(),
    abort: new AbortController().signal,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => ({}) as unknown,
    } as unknown as ToolContext["logger"],
    permissions: makePermissionService(),
  };
}

function makeTestSkill(name: string, body: string): Skill {
  return {
    name,
    frontmatter: {
      name,
      description: `Test skill ${name}`,
    },
    body,
    path: `/test/${name}/SKILL.md`,
    source: "user",
    mtimeMs: Date.now(),
  };
}

describe("Skill tool", () => {
  it("returns skill body for valid name", async () => {
    const registry = new SkillRegistry();
    // Manually populate the registry for testing
    const skill = makeTestSkill("unit-test", "hello world body");
    (registry as unknown as { "#skills": Map<string, Skill> })["#skills"] = new Map([
      ["unit-test", skill],
    ]);

    // Use a workaround to set skills in registry
    const realRegistry = new SkillRegistry();
    Object.defineProperty(realRegistry, "get", {
      value: (name: string) => (name === "unit-test" ? skill : undefined),
    });
    Object.defineProperty(realRegistry, "list", {
      value: () => [skill],
    });
    Object.defineProperty(realRegistry, "size", {
      value: () => 1,
    });

    const tool = createSkillTool(realRegistry);
    const ctx = makeTestContext();
    const result = await tool.handler({ name: "unit-test" }, ctx);

    expect(result).toEqual({ content: "hello world body" });
  });

  it("throws UnknownSkillError for unknown name", async () => {
    const registry = new SkillRegistry();
    Object.defineProperty(registry, "get", {
      value: () => undefined,
    });
    Object.defineProperty(registry, "list", {
      value: () => [makeTestSkill("existing-skill", "body")],
    });

    const tool = createSkillTool(registry);
    const ctx = makeTestContext();

    await expect(tool.handler({ name: "unknown-skill" }, ctx)).rejects.toThrow(UnknownSkillError);
    await expect(tool.handler({ name: "unknown-skill" }, ctx)).rejects.toThrow(
      /Unknown skill "unknown-skill"/,
    );
    await expect(tool.handler({ name: "unknown-skill" }, ctx)).rejects.toThrow(
      /Available: existing-skill/,
    );
  });

  it("rejects uppercase names via zod schema", () => {
    const result = skillInputSchema.safeParse({ name: "InvalidName" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("kebab-case");
    }
  });

  it("accepts valid kebab-case names via zod schema", () => {
    const result = skillInputSchema.safeParse({ name: "valid-skill-name" });
    expect(result.success).toBe(true);
  });

  it("accepts names with numbers via zod schema", () => {
    const result = skillInputSchema.safeParse({ name: "skill-123" });
    expect(result.success).toBe(true);
  });

  it("rejects names with underscores via zod schema", () => {
    const result = skillInputSchema.safeParse({ name: "invalid_name" });
    expect(result.success).toBe(false);
  });
});

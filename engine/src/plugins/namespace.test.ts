/**
 * Tests for plugin namespace helpers (T4-05).
 */

import { describe, expect, it } from "vitest";

import {
  belongsToPlugin,
  isNamespaced,
  isValidAgentName,
  isValidCommandName,
  isValidHookEventName,
  isValidSkillName,
  localPart,
  namespaced,
  parseNamespaced,
} from "./namespace.js";

describe("namespaced", () => {
  it("creates namespaced id", () => {
    expect(namespaced("my-plugin", "my-skill")).toBe("my-plugin:my-skill");
  });
});

describe("parseNamespaced", () => {
  it("parses namespaced id", () => {
    const result = parseNamespaced("my-plugin:my-skill");
    expect(result).toEqual({ pluginId: "my-plugin", localId: "my-skill" });
  });

  it("returns null for non-namespaced id", () => {
    expect(parseNamespaced("my-skill")).toBeNull();
  });

  it("returns null for empty plugin id", () => {
    expect(parseNamespaced(":my-skill")).toBeNull();
  });

  it("returns null for empty local id", () => {
    expect(parseNamespaced("my-plugin:")).toBeNull();
  });

  it("handles multiple colons (takes first)", () => {
    const result = parseNamespaced("plugin:local:extra");
    expect(result).toEqual({ pluginId: "plugin", localId: "local:extra" });
  });
});

describe("isNamespaced", () => {
  it("returns true for namespaced id", () => {
    expect(isNamespaced("my-plugin:my-skill")).toBe(true);
  });

  it("returns false for non-namespaced id", () => {
    expect(isNamespaced("my-skill")).toBe(false);
  });
});

describe("localPart", () => {
  it("extracts local part from namespaced id", () => {
    expect(localPart("my-plugin:my-skill")).toBe("my-skill");
  });

  it("returns id if not namespaced", () => {
    expect(localPart("my-skill")).toBe("my-skill");
  });
});

describe("belongsToPlugin", () => {
  it("returns true if id belongs to plugin", () => {
    expect(belongsToPlugin("my-plugin:my-skill", "my-plugin")).toBe(true);
  });

  it("returns false if id belongs to different plugin", () => {
    expect(belongsToPlugin("my-plugin:my-skill", "other-plugin")).toBe(false);
  });

  it("returns false if id is not namespaced", () => {
    expect(belongsToPlugin("my-skill", "my-plugin")).toBe(false);
  });
});

describe("validation helpers", () => {
  describe("isValidSkillName", () => {
    it("accepts valid skill names", () => {
      expect(isValidSkillName("foo")).toBe(true);
      expect(isValidSkillName("my-skill")).toBe(true);
      expect(isValidSkillName("skill-123")).toBe(true);
    });

    it("rejects invalid skill names", () => {
      expect(isValidSkillName("")).toBe(false);
      expect(isValidSkillName("MySkill")).toBe(false);
      expect(isValidSkillName("my_skill")).toBe(false);
      expect(isValidSkillName("123-skill")).toBe(false);
    });
  });

  describe("isValidAgentName", () => {
    it("accepts valid agent names", () => {
      expect(isValidAgentName("bar")).toBe(true);
      expect(isValidAgentName("my-agent")).toBe(true);
    });

    it("rejects invalid agent names", () => {
      expect(isValidAgentName("")).toBe(false);
      expect(isValidAgentName("MyAgent")).toBe(false);
    });
  });

  describe("isValidCommandName", () => {
    it("accepts valid command names", () => {
      expect(isValidCommandName("hello")).toBe(true);
      expect(isValidCommandName("my-command")).toBe(true);
    });

    it("rejects invalid command names", () => {
      expect(isValidCommandName("")).toBe(false);
      expect(isValidCommandName("MyCommand")).toBe(false);
    });
  });

  describe("isValidHookEventName", () => {
    it("accepts valid hook event names", () => {
      expect(isValidHookEventName("PreToolUse")).toBe(true);
      expect(isValidHookEventName("PostToolUse")).toBe(true);
      expect(isValidHookEventName("UserPromptSubmit")).toBe(true);
    });

    it("rejects invalid hook event names", () => {
      expect(isValidHookEventName("InvalidEvent")).toBe(false);
      expect(isValidHookEventName("pretooluse")).toBe(false);
      expect(isValidHookEventName("")).toBe(false);
    });
  });
});

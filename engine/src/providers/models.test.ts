import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  InvalidModelError,
  isKnownModel,
  KNOWN_MODELS,
  resolveModel,
} from "./models.js";

function envOf(entries: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...entries } as NodeJS.ProcessEnv;
}

describe("KNOWN_MODELS / DEFAULT_MODEL", () => {
  it("DEFAULT_MODEL is claude-sonnet-4-5 and is in the registry", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-4-5");
    expect(KNOWN_MODELS).toContain(DEFAULT_MODEL);
  });

  it("registry contains the three T0 ids", () => {
    expect(KNOWN_MODELS).toContain("claude-sonnet-4-5");
    expect(KNOWN_MODELS).toContain("claude-opus-4-5");
    expect(KNOWN_MODELS).toContain("claude-haiku-4-5");
  });

  it("does NOT contain the bogus claude-opus-4-6 id", () => {
    expect((KNOWN_MODELS as readonly string[]).includes("claude-opus-4-6")).toBe(false);
  });
});

describe("isKnownModel", () => {
  it("accepts every entry in KNOWN_MODELS", () => {
    for (const m of KNOWN_MODELS) {
      expect(isKnownModel(m)).toBe(true);
    }
  });

  it("rejects unknown ids", () => {
    expect(isKnownModel("claude-opus-4-6")).toBe(false);
    expect(isKnownModel("gpt-4")).toBe(false);
    expect(isKnownModel("")).toBe(false);
  });
});

describe("resolveModel — priority order", () => {
  it("flag wins over configModel, env, and default", () => {
    const m = resolveModel({
      flag: "claude-opus-4-5",
      configModel: "claude-haiku-4-5",
      env: envOf({ ANTHROPIC_DEFAULT_MODEL: "claude-sonnet-4-5" }),
    });
    expect(m).toBe("claude-opus-4-5");
  });

  it("configModel wins when flag is absent", () => {
    const m = resolveModel({
      configModel: "claude-haiku-4-5",
      env: envOf({ ANTHROPIC_DEFAULT_MODEL: "claude-opus-4-5" }),
    });
    expect(m).toBe("claude-haiku-4-5");
  });

  it("env wins when flag and configModel are absent", () => {
    const m = resolveModel({
      env: envOf({ ANTHROPIC_DEFAULT_MODEL: "claude-opus-4-5" }),
    });
    expect(m).toBe("claude-opus-4-5");
  });

  it("falls back to DEFAULT_MODEL when nothing is set", () => {
    const m = resolveModel({ env: envOf({}) });
    expect(m).toBe(DEFAULT_MODEL);
  });

  it("falls back to DEFAULT_MODEL when no args are passed at all", () => {
    const m = resolveModel();
    // Can't rely on host env here; just assert it returned a known model.
    expect(isKnownModel(m)).toBe(true);
  });

  it("treats empty / whitespace-only flag as absent", () => {
    const m = resolveModel({
      flag: "   ",
      configModel: "claude-opus-4-5",
      env: envOf({}),
    });
    expect(m).toBe("claude-opus-4-5");
  });

  it("treats empty / whitespace-only configModel as absent", () => {
    const m = resolveModel({
      configModel: "",
      env: envOf({ ANTHROPIC_DEFAULT_MODEL: "claude-haiku-4-5" }),
    });
    expect(m).toBe("claude-haiku-4-5");
  });
});

describe("resolveModel — rejection", () => {
  it("throws InvalidModelError for unknown flag", () => {
    expect(() => resolveModel({ flag: "claude-opus-4-6", env: envOf({}) })).toThrow(
      InvalidModelError,
    );
  });

  it("throws InvalidModelError for unknown configModel", () => {
    expect(() => resolveModel({ configModel: "not-a-model", env: envOf({}) })).toThrow(
      InvalidModelError,
    );
  });

  it("throws InvalidModelError for unknown env value", () => {
    expect(() => resolveModel({ env: envOf({ ANTHROPIC_DEFAULT_MODEL: "gpt-4" }) })).toThrow(
      InvalidModelError,
    );
  });

  it("error message names the offending id and lists known models", () => {
    try {
      resolveModel({ flag: "claude-opus-4-6", env: envOf({}) });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidModelError);
      const e = err as InvalidModelError;
      expect(e.modelId).toBe("claude-opus-4-6");
      expect(e.message).toContain("claude-opus-4-6");
      expect(e.message).toContain("claude-sonnet-4-5");
    }
  });
});

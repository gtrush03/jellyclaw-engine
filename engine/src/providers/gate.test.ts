import { describe, expect, it } from "vitest";
import { type Config, parseConfig } from "../config/schema.js";
import { CachingGateError, enforceCachingGate } from "./gate.js";

function makeConfig(overrides: {
  provider: "anthropic" | "openrouter";
  model: string;
  acknowledgeCachingLimits: boolean;
}): Config {
  return parseConfig({
    provider: overrides.provider,
    model: overrides.model,
    acknowledgeCachingLimits: overrides.acknowledgeCachingLimits,
  });
}

describe("enforceCachingGate", () => {
  describe("provider=anthropic always allows", () => {
    it("claude-opus-4-6, gate=false → allow", () => {
      const config = makeConfig({
        provider: "anthropic",
        model: "claude-opus-4-6",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "claude-opus-4-6")).not.toThrow();
    });

    it("claude-opus-4-6, gate=true → allow", () => {
      const config = makeConfig({
        provider: "anthropic",
        model: "claude-opus-4-6",
        acknowledgeCachingLimits: true,
      });
      expect(() => enforceCachingGate(config, "claude-opus-4-6")).not.toThrow();
    });

    it("claude-sonnet-4.6, gate=false → allow", () => {
      const config = makeConfig({
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "claude-sonnet-4.6")).not.toThrow();
    });
  });

  describe("provider=openrouter + non-Anthropic model always allows", () => {
    it("qwen/qwen3-coder, gate=false → allow", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "qwen/qwen3-coder")).not.toThrow();
    });

    it("google/gemini-2.0-flash, gate=false → allow", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "google/gemini-2.0-flash",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "google/gemini-2.0-flash")).not.toThrow();
    });

    it("meta-llama/llama-3.3-70b, gate=false → allow", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "meta-llama/llama-3.3-70b")).not.toThrow();
    });
  });

  describe("provider=openrouter + Anthropic model + gate=false throws", () => {
    it("anthropic/claude-sonnet-4.6 → THROW", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "anthropic/claude-sonnet-4.6")).toThrow(
        CachingGateError,
      );
    });

    it("anthropic/claude-opus-4-6 → THROW", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "anthropic/claude-opus-4-6",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "anthropic/claude-opus-4-6")).toThrow(
        CachingGateError,
      );
    });

    it("bare claude-opus-4-6 → THROW (matches /^claude[-_]/i)", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "claude-opus-4-6",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "claude-opus-4-6")).toThrow(CachingGateError);
    });

    it("bare claude-sonnet-4.6 → THROW", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "claude-sonnet-4.6",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "claude-sonnet-4.6")).toThrow(CachingGateError);
    });

    it("Claude-Opus (capitalized) → THROW (case-insensitive)", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "Claude-Opus",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(config, "Claude-Opus")).toThrow(CachingGateError);
    });

    it("error message contains the model slug and both remediation hints", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        acknowledgeCachingLimits: false,
      });
      try {
        enforceCachingGate(config, "anthropic/claude-sonnet-4.6");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CachingGateError);
        const message = (err as Error).message;
        expect(message).toContain("anthropic/claude-sonnet-4.6");
        expect(message).toContain("--provider anthropic");
        expect(message).toContain("acknowledgeCachingLimits");
      }
    });
  });

  describe("provider=openrouter + Anthropic model + gate=true allows", () => {
    it("anthropic/claude-sonnet-4.6, gate=true → allow", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        acknowledgeCachingLimits: true,
      });
      expect(() => enforceCachingGate(config, "anthropic/claude-sonnet-4.6")).not.toThrow();
    });

    it("bare claude-opus-4-6, gate=true → allow", () => {
      const config = makeConfig({
        provider: "openrouter",
        model: "claude-opus-4-6",
        acknowledgeCachingLimits: true,
      });
      expect(() => enforceCachingGate(config, "claude-opus-4-6")).not.toThrow();
    });
  });

  describe("uses the explicit model argument, not config.model", () => {
    it("config.model is Anthropic but explicit model is non-Anthropic → allow", () => {
      // provider=openrouter, gate=false. If the helper incorrectly consulted
      // config.model (claude-opus-4-6), it would throw. It must use the
      // explicit model arg (qwen/qwen3-coder) and allow.
      const config = makeConfig({
        provider: "openrouter",
        model: "claude-opus-4-6",
        acknowledgeCachingLimits: true, // set true so config parse doesn't already fail anywhere else
      });
      // Re-parse with gate=false to make the test airtight on the explicit-arg claim.
      const configGateFalse = parseConfig({
        provider: "openrouter",
        model: "claude-opus-4-6",
        acknowledgeCachingLimits: false,
      });
      expect(() => enforceCachingGate(configGateFalse, "qwen/qwen3-coder")).not.toThrow();
      // And sanity: with the Anthropic explicit model it would throw under the same config.
      expect(() => enforceCachingGate(configGateFalse, "claude-opus-4-6")).toThrow(
        CachingGateError,
      );
      // Touch `config` so TS doesn't complain about unused binding.
      expect(config.acknowledgeCachingLimits).toBe(true);
    });
  });
});

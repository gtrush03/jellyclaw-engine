import { describe, expect, it } from "vitest";
import type { ToolCall } from "../permissions/types.js";
import {
  noteBrowserHost,
  type RateLimitPolicy,
  type RateLimitSessionState,
  resolveRateLimitKey,
} from "./policies.js";

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { name, input };
}

function freshSession(): RateLimitSessionState {
  return { lastBrowserHost: null };
}

const POLICY: RateLimitPolicy = {
  browser: {
    default: { capacity: 5, refillPerSecond: 1 },
    perDomain: {
      "example.com": { capacity: 10, refillPerSecond: 2 },
    },
  },
};

describe("resolveRateLimitKey — browser_navigate", () => {
  it("keys by hostname and picks perDomain bucket", () => {
    const r = resolveRateLimitKey(
      call("mcp__playwright__browser_navigate", { url: "https://example.com/foo" }),
      POLICY,
      freshSession(),
    );
    expect(r.key).toBe("browser:example.com");
    expect(r.bucketConfig).toEqual({ capacity: 10, refillPerSecond: 2 });
  });

  it("unknown domain falls back to default bucket", () => {
    const r = resolveRateLimitKey(
      call("mcp__playwright__browser_navigate", { url: "https://other.test/" }),
      POLICY,
      freshSession(),
    );
    expect(r.key).toBe("browser:other.test");
    expect(r.bucketConfig).toEqual({ capacity: 5, refillPerSecond: 1 });
  });

  it("malformed URL → passthrough (null)", () => {
    const r = resolveRateLimitKey(
      call("mcp__playwright__browser_navigate", { url: "not a url" }),
      POLICY,
      freshSession(),
    );
    expect(r.key).toBeNull();
    expect(r.bucketConfig).toBeNull();
  });

  it("missing url → passthrough", () => {
    const r = resolveRateLimitKey(
      call("mcp__playwright__browser_navigate", {}),
      POLICY,
      freshSession(),
    );
    expect(r.key).toBeNull();
  });
});

describe("resolveRateLimitKey — inherit tools", () => {
  it("browser_click inherits session.lastBrowserHost", () => {
    const s = freshSession();
    s.lastBrowserHost = "example.com";
    const r = resolveRateLimitKey(call("mcp__playwright__browser_click", { ref: "#x" }), POLICY, s);
    expect(r.key).toBe("browser:example.com");
    expect(r.bucketConfig).toEqual({ capacity: 10, refillPerSecond: 2 });
  });

  it("browser_click with no prior navigate uses _unknown + default bucket", () => {
    const r = resolveRateLimitKey(
      call("mcp__playwright__browser_click", { ref: "#x" }),
      POLICY,
      freshSession(),
    );
    expect(r.key).toBe("browser:_unknown");
    expect(r.bucketConfig).toEqual({ capacity: 5, refillPerSecond: 1 });
  });
});

describe("resolveRateLimitKey — passthrough", () => {
  it("non-browser tool → passthrough", () => {
    const r = resolveRateLimitKey(call("Bash", { command: "ls" }), POLICY, freshSession());
    expect(r.key).toBeNull();
    expect(r.bucketConfig).toBeNull();
  });

  it("policy.browser undefined → all browser tools passthrough", () => {
    const empty: RateLimitPolicy = {};
    const r = resolveRateLimitKey(
      call("mcp__playwright__browser_navigate", { url: "https://example.com" }),
      empty,
      freshSession(),
    );
    expect(r.key).toBeNull();
    const r2 = resolveRateLimitKey(
      call("mcp__playwright__browser_click", {}),
      empty,
      freshSession(),
    );
    expect(r2.key).toBeNull();
  });
});

describe("noteBrowserHost", () => {
  it("updates state on valid browser_navigate", () => {
    const s = freshSession();
    noteBrowserHost(s, call("mcp__playwright__browser_navigate", { url: "https://foo.test/bar" }));
    expect(s.lastBrowserHost).toBe("foo.test");
  });

  it("ignores other tools", () => {
    const s = freshSession();
    s.lastBrowserHost = "prev.test";
    noteBrowserHost(s, call("mcp__playwright__browser_click", {}));
    expect(s.lastBrowserHost).toBe("prev.test");
  });

  it("ignores navigate with malformed URL", () => {
    const s = freshSession();
    s.lastBrowserHost = "prev.test";
    noteBrowserHost(s, call("mcp__playwright__browser_navigate", { url: "not a url" }));
    expect(s.lastBrowserHost).toBe("prev.test");
  });
});

import { describe, expect, it } from "vitest";
import type { ToolCall } from "../permissions/types.js";
import {
  BROWSER_BUCKET,
  isBrowserRateLimited,
  noteBrowserHost,
  type RateLimitPolicy,
  type RateLimitSessionState,
  resolveRateLimitKey,
} from "./policies.js";
import { TokenBucket } from "./token-bucket.js";

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

// ---------------------------------------------------------------------------
// Global browser rate limit bucket tests (Phase 07.5 T2-01)
// ---------------------------------------------------------------------------

describe("BROWSER_BUCKET", () => {
  it("has capacity of 10 (burst tokens)", () => {
    expect(BROWSER_BUCKET.capacity).toBe(10);
  });

  it("has refillPerSecond of 1 (60 req/min)", () => {
    expect(BROWSER_BUCKET.refillPerSecond).toBe(1);
  });

  it("has name 'browser'", () => {
    expect(BROWSER_BUCKET.name).toBe("browser");
  });

  it("TokenBucket starts with 10 burst tokens", () => {
    const clock = 0;
    const bucket = new TokenBucket({
      capacity: BROWSER_BUCKET.capacity,
      refillPerSecond: BROWSER_BUCKET.refillPerSecond,
      now: () => clock,
    });

    // Should be able to acquire 10 tokens immediately
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryAcquire(1)).toBe(true);
    }
    // 11th should fail
    expect(bucket.tryAcquire(1)).toBe(false);
  });

  it("refill rate is 1 token per second", () => {
    let clock = 0;
    const bucket = new TokenBucket({
      capacity: BROWSER_BUCKET.capacity,
      refillPerSecond: BROWSER_BUCKET.refillPerSecond,
      now: () => clock,
    });

    // Drain all tokens
    for (let i = 0; i < 10; i++) {
      bucket.tryAcquire(1);
    }
    expect(bucket.tryAcquire(1)).toBe(false);

    // Advance 1 second → 1 token refilled
    clock += 1000;
    expect(bucket.tryAcquire(1)).toBe(true);
    expect(bucket.tryAcquire(1)).toBe(false);

    // Advance another 5 seconds → 5 more tokens
    clock += 5000;
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryAcquire(1)).toBe(true);
    }
    expect(bucket.tryAcquire(1)).toBe(false);
  });
});

describe("isBrowserRateLimited", () => {
  it("returns true for mcp__playwright__* tools", () => {
    expect(isBrowserRateLimited("mcp__playwright__browser_navigate")).toBe(true);
    expect(isBrowserRateLimited("mcp__playwright__browser_click")).toBe(true);
    expect(isBrowserRateLimited("mcp__playwright__browser_evaluate")).toBe(true);
    expect(isBrowserRateLimited("mcp__playwright__browser_run_code")).toBe(true);
    expect(isBrowserRateLimited("mcp__playwright__browser_file_upload")).toBe(true);
    expect(isBrowserRateLimited("mcp__playwright__browser_snapshot")).toBe(true);
  });

  it("returns true for mcp__playwright-extension__* tools", () => {
    expect(isBrowserRateLimited("mcp__playwright-extension__browser_snapshot")).toBe(true);
    expect(isBrowserRateLimited("mcp__playwright-extension__browser_navigate")).toBe(true);
  });

  it("returns true for mcp__chrome-devtools__* tools", () => {
    expect(isBrowserRateLimited("mcp__chrome-devtools__lighthouse_audit")).toBe(true);
    expect(isBrowserRateLimited("mcp__chrome-devtools__performance_trace")).toBe(true);
  });

  it("returns false for non-browser MCP tools", () => {
    expect(isBrowserRateLimited("mcp__github__create_issue")).toBe(false);
    expect(isBrowserRateLimited("mcp__linear__list_issues")).toBe(false);
    expect(isBrowserRateLimited("mcp__some-server__foo")).toBe(false);
  });

  it("returns false for non-MCP tools", () => {
    expect(isBrowserRateLimited("Bash")).toBe(false);
    expect(isBrowserRateLimited("Read")).toBe(false);
    expect(isBrowserRateLimited("Write")).toBe(false);
  });
});

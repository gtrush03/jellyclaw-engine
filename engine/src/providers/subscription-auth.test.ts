/**
 * Tests for subscription-auth.ts (T3-10).
 */

import { describe, expect, it } from "vitest";

import type { Credentials } from "../cli/credentials.js";
import { parseRole, scrubEnvForSubscription, selectAuth } from "./subscription-auth.js";

describe("worker-prefers-subscription", () => {
  it("worker role returns subscription when present", () => {
    const creds: Credentials = {
      anthropicApiKey: "sk-ant-api03-testkey123",
      subscription: {
        kind: "oauth",
        accessToken: "oauth-token-12345",
        obtainedAt: Date.now(),
      },
    };

    const auth = selectAuth(creds, "worker");
    expect(auth).not.toBeNull();
    expect(auth?.kind).toBe("subscription");
    if (auth?.kind === "subscription") {
      expect(auth.token).toBe("oauth-token-12345");
    }
  });

  it("worker role returns null when subscription is missing", () => {
    const creds: Credentials = {
      anthropicApiKey: "sk-ant-api03-testkey123",
    };

    const auth = selectAuth(creds, "worker");
    expect(auth).toBeNull();
  });

  it("worker role ignores API key when subscription is present", () => {
    const creds: Credentials = {
      anthropicApiKey: "sk-ant-api03-testkey123",
      subscription: {
        kind: "oauth",
        accessToken: "oauth-token-worker",
        obtainedAt: Date.now(),
      },
    };

    const auth = selectAuth(creds, "worker");
    expect(auth?.kind).toBe("subscription");
  });
});

describe("tester-prefers-apikey", () => {
  it("tester role returns API key when present", () => {
    const creds: Credentials = {
      anthropicApiKey: "sk-ant-api03-testerkey",
      subscription: {
        kind: "oauth",
        accessToken: "oauth-token-unused",
        obtainedAt: Date.now(),
      },
    };

    const auth = selectAuth(creds, "tester");
    expect(auth?.kind).toBe("apiKey");
    if (auth?.kind === "apiKey") {
      expect(auth.key).toBe("sk-ant-api03-testerkey");
    }
  });

  it("tester role falls back to subscription when no API key", () => {
    const creds: Credentials = {
      subscription: {
        kind: "oauth",
        accessToken: "oauth-fallback-token",
        obtainedAt: Date.now(),
      },
    };

    const auth = selectAuth(creds, "tester");
    expect(auth?.kind).toBe("subscription");
  });

  it("tester role returns null when both are missing", () => {
    const creds: Credentials = {};

    const auth = selectAuth(creds, "tester");
    expect(auth).toBeNull();
  });
});

describe("default-prefers-apikey", () => {
  it("default role returns API key when present", () => {
    const creds: Credentials = {
      anthropicApiKey: "sk-ant-api03-defaultkey",
      subscription: {
        kind: "oauth",
        accessToken: "oauth-token-unused",
        obtainedAt: Date.now(),
      },
    };

    const auth = selectAuth(creds, "default");
    expect(auth?.kind).toBe("apiKey");
  });

  it("default role falls back to subscription", () => {
    const creds: Credentials = {
      subscription: {
        kind: "oauth",
        accessToken: "oauth-default-fallback",
        obtainedAt: Date.now(),
      },
    };

    const auth = selectAuth(creds, "default");
    expect(auth?.kind).toBe("subscription");
  });

  it("default role returns null when no creds", () => {
    const creds: Credentials = {};
    const auth = selectAuth(creds, "default");
    expect(auth).toBeNull();
  });
});

describe("parseRole", () => {
  it('parses "worker" correctly', () => {
    expect(parseRole("worker")).toBe("worker");
  });

  it('parses "tester" correctly', () => {
    expect(parseRole("tester")).toBe("tester");
  });

  it("defaults to 'default' for unknown values", () => {
    expect(parseRole("unknown")).toBe("default");
    expect(parseRole(undefined)).toBe("default");
    expect(parseRole("")).toBe("default");
  });
});

describe("scrubEnvForSubscription", () => {
  it("removes ANTHROPIC_API_KEY from env", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OTHER_VAR: "keep-me",
      PATH: "/usr/bin",
    };

    const scrubbed = scrubEnvForSubscription(env);

    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.OTHER_VAR).toBe("keep-me");
    expect(scrubbed.PATH).toBe("/usr/bin");
  });

  it("preserves env when ANTHROPIC_API_KEY is not present", () => {
    const env = {
      OTHER_VAR: "value",
    };

    const scrubbed = scrubEnvForSubscription(env);

    expect(scrubbed.OTHER_VAR).toBe("value");
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("does not mutate the original env", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-secret",
    };

    scrubEnvForSubscription(env);

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
  });
});

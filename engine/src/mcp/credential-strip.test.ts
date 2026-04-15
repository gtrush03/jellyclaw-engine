/**
 * Tests for the MCP credential scrubber.
 */

import { describe, expect, it, vi } from "vitest";
import { buildCredentialScrubber, REDACTED, scrubCredentials } from "./credential-strip.js";

describe("buildCredentialScrubber", () => {
  it("redacts a single secret value found in a longer string", () => {
    const scrub = buildCredentialScrubber(["sk-abcdef123456"]);
    expect(scrub("token is sk-abcdef123456 here")).toBe(`token is ${REDACTED} here`);
  });

  it("redacts multiple different secret values independently in one pass", () => {
    const scrub = buildCredentialScrubber(["password-one", "api-key-two-value"]);
    expect(scrub("user=password-one, key=api-key-two-value done")).toBe(
      `user=${REDACTED}, key=${REDACTED} done`,
    );
  });

  it("does not touch random text that doesn't match a secret", () => {
    const scrub = buildCredentialScrubber(["supersecretvalue"]);
    expect(scrub("the quick brown fox")).toBe("the quick brown fox");
    expect(scrub("this is not a secret")).toBe("this is not a secret");
    const json = '{"message":"hello world","ok":true}';
    expect(scrub(json)).toBe(json);
  });

  it("handles secrets containing regex metacharacters", () => {
    const meta = "a.b*c[d](e)$f?g+h|i\\j";
    const scrub = buildCredentialScrubber([meta]);
    expect(scrub(`start ${meta} end`)).toBe(`start ${REDACTED} end`);
    // And doesn't over-match: the regex-interpreted pattern would match many
    // non-literal things. Assert that a near-miss is NOT redacted.
    expect(scrub("aXbYcZdZeZfZgZhZiZj")).toBe("aXbYcZdZeZfZgZhZiZj");
  });

  it("longest-first precedence: longer superstrings win over prefixes", () => {
    const scrub = buildCredentialScrubber(["abcxyz", "abcxyzdef"]);
    expect(scrub("xx abcxyzdef yy")).toBe(`xx ${REDACTED} yy`);
  });

  it("skips empty string secret with onSkipped reason=empty and leaves input unchanged", () => {
    const onSkipped = vi.fn();
    const scrub = buildCredentialScrubber([""], { onSkipped });
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith("", "empty");
    expect(scrub("nothing to redact here")).toBe("nothing to redact here");
  });

  it("skips too-short secrets (<6 chars) with onSkipped reason=too_short", () => {
    const onSkipped = vi.fn();
    const scrub = buildCredentialScrubber(["abc", "ab", "12345"], {
      onSkipped,
    });
    expect(onSkipped).toHaveBeenCalledTimes(3);
    expect(onSkipped).toHaveBeenCalledWith("abc", "too_short");
    expect(onSkipped).toHaveBeenCalledWith("ab", "too_short");
    expect(onSkipped).toHaveBeenCalledWith("12345", "too_short");
    // Short values should not be redacted.
    expect(scrub("abc ab 12345 untouched")).toBe("abc ab 12345 untouched");
  });

  it("replaces all occurrences of the same secret", () => {
    const scrub = buildCredentialScrubber(["topsecret"]);
    expect(scrub("topsecret and topsecret and topsecret")).toBe(
      `${REDACTED} and ${REDACTED} and ${REDACTED}`,
    );
  });

  it("returns input unchanged when all secrets are skipped (empty pattern branch)", () => {
    const onSkipped = vi.fn();
    const scrub = buildCredentialScrubber(["", "abc", "xy"], { onSkipped });
    const input = "abc xy whatever some text";
    expect(scrub(input)).toBe(input);
    expect(onSkipped).toHaveBeenCalledTimes(3);
  });

  it("works on multi-line input (stderr output simulation)", () => {
    const scrub = buildCredentialScrubber(["deadbeefcafe"]);
    const input = [
      "[server] starting up",
      "[server] using token deadbeefcafe for auth",
      "[server] second line also has deadbeefcafe inside it",
      "[server] done",
    ].join("\n");
    const expected = [
      "[server] starting up",
      `[server] using token ${REDACTED} for auth`,
      `[server] second line also has ${REDACTED} inside it`,
      "[server] done",
    ].join("\n");
    expect(scrub(input)).toBe(expected);
  });

  it("reuses the compiled pattern across invocations (same scrubber, many calls)", () => {
    const scrub = buildCredentialScrubber(["reusable-secret-1"]);
    for (let i = 0; i < 5; i++) {
      expect(scrub(`iter ${i}: reusable-secret-1`)).toBe(`iter ${i}: ${REDACTED}`);
    }
  });
});

describe("scrubCredentials", () => {
  it("one-shot: equivalent to buildCredentialScrubber(secrets)(text)", () => {
    expect(scrubCredentials("hello alphabravocharlie world", ["alphabravocharlie"])).toBe(
      `hello ${REDACTED} world`,
    );
  });
});

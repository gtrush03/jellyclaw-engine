import { describe, expect, it } from "vitest";
import { scrubString } from "./scrub.js";
import { builtInPatterns } from "./secret-patterns.js";

const patterns = builtInPatterns();

describe("scrubString", () => {
  it("empty string returns empty", () => {
    const res = scrubString("", patterns);
    expect(res).toEqual({ scrubbed: "", hits: 0, byName: {} });
  });

  it("string shorter than minLength is skipped", () => {
    const res = scrubString("abc", patterns);
    expect(res.scrubbed).toBe("abc");
    expect(res.hits).toBe(0);
  });

  it("replaces single anthropic key", () => {
    const res = scrubString("key=sk-ant-AAAAAAAAAAAAAAAAAAAAAABBBB done", patterns);
    expect(res.scrubbed).toBe("key=[REDACTED:anthropic_api_key] done");
    expect(res.hits).toBe(1);
  });

  it("replaces three distinct secrets in one string", () => {
    const text = [
      "anthropic sk-ant-AAAAAAAAAAAAAAAAAAAAAABBBB",
      "aws AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join(" | ");
    const res = scrubString(text, patterns);
    expect(res.scrubbed).toContain("[REDACTED:anthropic_api_key]");
    expect(res.scrubbed).toContain("[REDACTED:aws_access_key_id]");
    expect(res.scrubbed).toContain("[REDACTED:github_pat_legacy]");
    expect(res.hits).toBe(3);
  });

  it("counts multiple matches of the same pattern", () => {
    const key = "sk-ant-AAAAAAAAAAAAAAAAAAAAAABBBB";
    const text = `a ${key} b ${key} c ${key} d`;
    const res = scrubString(text, patterns);
    expect(res.hits).toBe(3);
    expect(res.byName.anthropic_api_key).toBe(3);
  });

  it("narrow-first: anthropic beats openai", () => {
    const res = scrubString("sk-ant-AAAAAAAAAAAAAAAAAAAAAABBBB", patterns);
    expect(res.byName.anthropic_api_key).toBe(1);
    expect(res.byName.openai_api_key).toBeUndefined();
  });

  it("Authorization: Bearer is consumed by authorization_bearer", () => {
    const jwtish = "Authorization: Bearer eyJhbcdefghij.eyJabcdefghij.abcdefghij1234";
    const res = scrubString(jwtish, patterns);
    expect(res.scrubbed).toBe("[REDACTED:authorization_bearer]");
    expect(res.hits).toBe(1);
    expect(res.byName.authorization_bearer).toBe(1);
  });

  it("password=hunter2 redacts the whole assignment", () => {
    const res = scrubString("password=hunter2 rest", patterns);
    expect(res.scrubbed).toBe("[REDACTED:generic_password_assignment] rest");
  });

  it("fast:true replaces only the first match", () => {
    const key = "sk-ant-AAAAAAAAAAAAAAAAAAAAAABBBB";
    const text = `a ${key} b ${key} c`;
    const res = scrubString(text, patterns, { fast: true });
    expect(res.hits).toBe(1);
    // second key still present raw (fast mode stops after first)
    expect(res.scrubbed.includes(key)).toBe(true);
  });

  it("non-matching string returns unchanged", () => {
    const res = scrubString("the quick brown fox jumps over", patterns);
    expect(res.hits).toBe(0);
    expect(res.scrubbed).toBe("the quick brown fox jumps over");
  });

  it("respects minLength override", () => {
    const res = scrubString("abc", patterns, { minLength: 1 });
    // still no match, but no short-circuit — just correctness path
    expect(res.hits).toBe(0);
  });
});

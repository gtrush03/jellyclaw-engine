/**
 * Unit tests for the pure Edit-diagnostics helper.
 */

import { describe, expect, it } from "vitest";

import { explainMissingMatch } from "../../../engine/src/tools/edit-diagnostics.js";

describe("explainMissingMatch", () => {
  it("flags empty old_string", () => {
    expect(explainMissingMatch("hello", "")).toContain("empty");
  });

  it("flags a line-number prefix", () => {
    expect(explainMissingMatch("hello world", "42\thello")).toContain("line-number prefix");
  });

  it("flags CRLF-in-file vs LF-in-old_string", () => {
    expect(explainMissingMatch("hello\r\nworld\r\n", "hello\nworld")).toContain("CRLF");
  });

  it("flags LF-in-file vs CRLF-in-old_string", () => {
    const hint = explainMissingMatch("hello\nworld", "hello\r\nworld");
    expect(hint).toMatch(/CRLF|strip \\r/i);
  });

  it("flags whitespace-only mismatches", () => {
    expect(explainMissingMatch("foo bar", "foo  bar")).toContain("whitespace normalization");
  });

  it("falls through to a 'not found' hint for a genuinely absent match", () => {
    expect(explainMissingMatch("hello", "goodbye")).toContain("not found");
  });

  it("never leaks more than ~400 chars even for a huge file", () => {
    const big = "a".repeat(10_000);
    const hint = explainMissingMatch(big, "zzz");
    expect(hint.length).toBeLessThanOrEqual(400);
  });
});

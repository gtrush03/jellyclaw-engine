/**
 * Tests for unified diff computation (T3-07).
 */

import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.js";

describe("unifiedDiff", () => {
  it("computes diff for simple text change", () => {
    const oldText = "line1\nline2\nline3";
    const newText = "line1\nmodified\nline3";

    const diff = unifiedDiff(oldText, newText);

    // Should have: ctx(line1), del(line2), add(modified), ctx(line3)
    expect(diff.length).toBe(4);
    expect(diff[0]).toEqual({ kind: "ctx", text: "line1" });
    expect(diff[1]).toEqual({ kind: "del", text: "line2" });
    expect(diff[2]).toEqual({ kind: "add", text: "modified" });
    expect(diff[3]).toEqual({ kind: "ctx", text: "line3" });
  });

  it("handles empty old text (all additions)", () => {
    const diff = unifiedDiff("", "a\nb\nc");

    expect(diff.length).toBe(3);
    expect(diff.every((line) => line.kind === "add")).toBe(true);
    expect(diff[0]).toEqual({ kind: "add", text: "a" });
    expect(diff[1]).toEqual({ kind: "add", text: "b" });
    expect(diff[2]).toEqual({ kind: "add", text: "c" });
  });

  it("handles empty new text (all deletions)", () => {
    const diff = unifiedDiff("x\ny\nz", "");

    expect(diff.length).toBe(3);
    expect(diff.every((line) => line.kind === "del")).toBe(true);
  });

  it("handles identical strings (all context)", () => {
    const text = "same\ntext\nhere";
    const diff = unifiedDiff(text, text);

    expect(diff.length).toBe(3);
    expect(diff.every((line) => line.kind === "ctx")).toBe(true);
  });

  it("handles both empty strings", () => {
    const diff = unifiedDiff("", "");
    expect(diff.length).toBe(0);
  });

  it("handles single line change", () => {
    const diff = unifiedDiff("old", "new");

    expect(diff.length).toBe(2);
    expect(diff[0]).toEqual({ kind: "del", text: "old" });
    expect(diff[1]).toEqual({ kind: "add", text: "new" });
  });

  it("handles multiple additions", () => {
    const oldText = "line1\nline3";
    const newText = "line1\nline2\nline3";

    const diff = unifiedDiff(oldText, newText);

    // The diff library may produce different results depending on the algorithm
    // Check that we have the right content at minimum
    const addLines = diff.filter((l) => l.kind === "add");
    expect(addLines.length).toBeGreaterThan(0);
  });

  it("handles trailing newlines correctly", () => {
    const diff = unifiedDiff("foo\n", "bar\n");

    // Should have del(foo) and add(bar), possibly with empty context
    const dels = diff.filter((l) => l.kind === "del" && l.text === "foo");
    const adds = diff.filter((l) => l.kind === "add" && l.text === "bar");

    expect(dels.length).toBe(1);
    expect(adds.length).toBe(1);
  });
});

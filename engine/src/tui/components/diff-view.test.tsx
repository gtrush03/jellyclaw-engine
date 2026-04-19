/**
 * Tests for DiffView component (T1-03 polish).
 *
 * Covers:
 *   - +/-/ctx line rendering.
 *   - Hunk header with `+adds / -dels` summary.
 *   - Collapse path for diffs over `maxRows`.
 *   - Enter-to-expand hint in the collapsed summary.
 */

import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import type { DiffLine } from "../lib/diff.js";
import { unifiedDiff } from "../lib/diff.js";
import { DiffView } from "./diff-view.js";

describe("DiffView: edit-renders-diff", () => {
  it("renders added lines with + prefix", () => {
    const diff: DiffLine[] = [
      { kind: "del", text: "old line 1" },
      { kind: "del", text: "old line 2" },
      { kind: "add", text: "new line 1" },
      { kind: "add", text: "new line 2" },
    ];

    const { lastFrame } = render(<DiffView diff={diff} />);
    const frame = lastFrame();

    expect(frame).toContain("+ new line 1");
    expect(frame).toContain("+ new line 2");
    expect(frame).toContain("- old line 1");
    expect(frame).toContain("- old line 2");
  });

  it("renders context lines with space prefix", () => {
    const diff: DiffLine[] = [
      { kind: "ctx", text: "unchanged" },
      { kind: "add", text: "added" },
    ];

    const { lastFrame } = render(<DiffView diff={diff} />);
    const frame = lastFrame();

    // Context lines have 2-space prefix
    expect(frame).toContain("  unchanged");
    expect(frame).toContain("+ added");
  });
});

describe("DiffView: write-renders-full-insert", () => {
  it("renders all lines with + prefix for new file", () => {
    const diff = unifiedDiff("", "a\nb\nc");

    const { lastFrame } = render(<DiffView diff={diff} />);
    const frame = lastFrame();

    expect(frame).toContain("+ a");
    expect(frame).toContain("+ b");
    expect(frame).toContain("+ c");
    // Should not have any - lines
    expect(frame).not.toContain("- ");
  });
});

describe("DiffView: large-diff-collapses", () => {
  it("collapses diffs with more than maxRows lines (default 60)", () => {
    // Create 70 added lines (exceeds default 60)
    const lines: DiffLine[] = Array.from({ length: 70 }, (_, i) => ({
      kind: "add" as const,
      text: `line ${i + 1}`,
    }));

    const { lastFrame } = render(<DiffView diff={lines} />);
    const frame = lastFrame();

    // Should contain the elided marker
    expect(frame).toContain("lines elided");

    // Should contain first lines
    expect(frame).toContain("line 1");
    expect(frame).toContain("line 30");

    // Should contain last lines
    expect(frame).toContain("line 41");
    expect(frame).toContain("line 70");

    // Should contain the expand hint (Enter key per T1-03 spec).
    expect(frame).toContain("press Enter to expand");
    // Summary surfaces adds / dels counts.
    expect(frame).toContain("+70");
    expect(frame).toContain("-0");
  });

  it("collapses with custom maxRows", () => {
    const lines: DiffLine[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "add" as const,
      text: `line ${i + 1}`,
    }));

    const { lastFrame } = render(<DiffView diff={lines} maxRows={40} />);
    const frame = lastFrame();

    // Should contain the elided marker
    expect(frame).toContain("lines elided");
    expect(frame).toContain("press Enter to expand");
  });

  it("does not collapse when under maxRows", () => {
    const lines: DiffLine[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "add" as const,
      text: `line ${i + 1}`,
    }));

    // Default maxRows is now 60
    const { lastFrame } = render(<DiffView diff={lines} />);
    const frame = lastFrame();

    // Should NOT contain the elided marker (50 < 60)
    expect(frame).not.toContain("lines elided");
    expect(frame).not.toContain("press Enter to expand");
  });

  it("renders a hunk header with +adds / -dels summary", () => {
    const diff: DiffLine[] = [
      { kind: "add", text: "one" },
      { kind: "add", text: "two" },
      { kind: "del", text: "zero" },
    ];
    const { lastFrame } = render(<DiffView diff={diff} filePath="/file.ts" />);
    const plain = stripAnsi(lastFrame());
    expect(plain).toContain("/file.ts");
    expect(plain).toContain("+2");
    expect(plain).toContain("-1");
  });
});

describe("DiffView: file path display", () => {
  it("displays file path when provided", () => {
    const diff: DiffLine[] = [{ kind: "add", text: "content" }];

    const { lastFrame } = render(<DiffView diff={diff} filePath="/path/to/file.ts" />);
    const frame = lastFrame();

    expect(frame).toContain("/path/to/file.ts");
  });

  it("does not show file path header when not provided", () => {
    const diff: DiffLine[] = [{ kind: "add", text: "content" }];

    const { lastFrame } = render(<DiffView diff={diff} />);
    const frame = lastFrame();

    // Should just have the diff content, no path
    expect(frame).toContain("+ content");
  });
});

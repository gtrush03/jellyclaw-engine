/**
 * Unit tests for the backend prompt parser.
 *
 * These run with vitest against the real files in `prompts/phase-01/*.md`
 * (the parser is pure — no network, no watchers) plus a set of inline
 * fixtures covering edge cases.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  parsePromptFile,
  assemblePrompt,
  extractPhaseName,
} from "../../server/src/lib/prompt-parser.js";

const REPO_ROOT = "/Users/gtrush/Downloads/jellyclaw-engine";
const SAMPLE = path.join(REPO_ROOT, "prompts/phase-01/01-research.md");

describe("parsePromptFile", () => {
  it("extracts id, phase, subPrompt from the path", async () => {
    const p = await parsePromptFile(SAMPLE);
    expect(p.id).toBe("phase-01/01-research");
    expect(p.phase).toBe("01");
    expect(p.subPrompt).toBe("01-research");
    expect(p.filePath).toBe(SAMPLE);
  });

  it("extracts the H1 as title", async () => {
    const p = await parsePromptFile(SAMPLE);
    expect(p.title.length).toBeGreaterThan(0);
    expect(p.title).not.toBe("(untitled prompt)");
  });

  it("returns a non-empty raw and body", async () => {
    const p = await parsePromptFile(SAMPLE);
    expect(p.raw.length).toBeGreaterThan(100);
    expect(p.body.length).toBeGreaterThan(0);
    // Body should not still contain the session-startup markers.
    expect(p.body).not.toContain("<!-- BEGIN SESSION STARTUP -->");
    expect(p.body).not.toContain("<!-- END SESSION CLOSEOUT -->");
  });

  it("handles missing frontmatter gracefully", async () => {
    const tmp = path.join(os.tmpdir(), "jc-unit-no-fm.md");
    // Must live outside the repo? No — assertInsideRepo blocks it. Use a file
    // inside the repo tree instead by writing to prompts/phase-00/99-scratch.md
    // (skip: we use a fixture inside REPO_ROOT for this assertion).
    const fixturePath = path.join(REPO_ROOT, "prompts/phase-00/99-unit-test-fixture-no-fm.md");
    await fs.writeFile(
      fixturePath,
      "# Phase 00 — Bootstrap — Prompt 99: no frontmatter\n\nBody content.\n",
    );
    try {
      const p = await parsePromptFile(fixturePath);
      expect(p.title).toContain("Prompt 99");
      expect(p.whenToRun).toBeNull();
      expect(p.duration).toBeNull();
    } finally {
      await fs.unlink(fixturePath).catch(() => {});
      await fs.unlink(tmp).catch(() => {});
    }
  });

  it("handles special characters in content", async () => {
    const fixturePath = path.join(REPO_ROOT, "prompts/phase-00/98-unit-test-fixture-special.md");
    await fs.writeFile(
      fixturePath,
      "# Phase 00 — Weird — Prompt 98: unicode & html\n\n" +
        "**When to run:** after <thing> & before <other>\n\n" +
        "Body with 日本語 and emoji 🌀 and `backticks`.\n",
    );
    try {
      const p = await parsePromptFile(fixturePath);
      expect(p.whenToRun).toContain("<thing>");
      expect(p.body).toContain("日本語");
      expect(p.body).toContain("🌀");
    } finally {
      await fs.unlink(fixturePath).catch(() => {});
    }
  });

  it("refuses paths outside the repo root (traversal guard)", async () => {
    await expect(parsePromptFile("/etc/passwd")).rejects.toThrow(/Path traversal blocked/);
  });
});

describe("assemblePrompt", () => {
  it("combines startup + body + closeout", async () => {
    const { assembled, parsed } = await assemblePrompt(SAMPLE);
    expect(assembled).toContain("---"); // the divider between sections
    expect(assembled.length).toBeGreaterThan(parsed.body.length);
  });

  it("substitutes <NN>, <phase-name>, <sub-prompt>", async () => {
    const { assembled, parsed } = await assemblePrompt(SAMPLE);
    // After assembly no literal placeholder tokens should remain.
    expect(assembled).not.toMatch(/<NN>/);
    expect(assembled).not.toMatch(/<phase-name>/);
    expect(assembled).not.toMatch(/<sub-prompt>/);
    // The zero-padded phase number and sub-prompt slug should appear.
    expect(assembled).toContain(parsed.phase);
    expect(assembled).toContain(parsed.subPrompt);
  });
});

describe("extractPhaseName", () => {
  it("pulls the phase name from the canonical H1 format", () => {
    expect(extractPhaseName("Phase 01 — OpenCode Pinning — Prompt 02: implement")).toBe(
      "OpenCode Pinning",
    );
  });

  it("falls back to the second segment when the format is unusual", () => {
    expect(extractPhaseName("Phase 42 — Something — Else")).toBe("Something");
  });

  it("returns the whole title when no em-dashes are present", () => {
    expect(extractPhaseName("Just a title")).toBe("Just a title");
  });
});

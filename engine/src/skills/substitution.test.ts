import { describe, expect, it } from "vitest";
import { substitute } from "./substitution.ts";

const PROJECT_DIR = "/tmp/proj";

describe("substitute", () => {
  it("replaces $ARGUMENTS with empty string when args is empty", () => {
    const r = substitute("run: $ARGUMENTS", { projectDir: PROJECT_DIR });
    expect(r.output).toBe("run: ");
    expect(r.unknown).toEqual([]);
  });

  it("replaces $ARGUMENTS with the full arg string", () => {
    const r = substitute("run: $ARGUMENTS", {
      args: "hello world",
      projectDir: PROJECT_DIR,
    });
    expect(r.output).toBe("run: hello world");
    expect(r.unknown).toEqual([]);
  });

  it("substitutes positional $1 $2", () => {
    const r = substitute("$1 $2", {
      args: "alpha beta",
      projectDir: PROJECT_DIR,
    });
    expect(r.output).toBe("alpha beta");
    expect(r.unknown).toEqual([]);
  });

  it("replaces $1 with empty string when args is absent", () => {
    const r = substitute("[$1]", { projectDir: PROJECT_DIR });
    expect(r.output).toBe("[]");
    expect(r.unknown).toEqual([]);
  });

  it("replaces $9 with empty string when only 3 args are supplied", () => {
    const r = substitute("[$9]", {
      args: "a b c",
      projectDir: PROJECT_DIR,
    });
    expect(r.output).toBe("[]");
    expect(r.unknown).toEqual([]);
  });

  it("substitutes $CLAUDE_PROJECT_DIR", () => {
    const r = substitute("cd $CLAUDE_PROJECT_DIR", {
      projectDir: "/work/foo",
    });
    expect(r.output).toBe("cd /work/foo");
    expect(r.unknown).toEqual([]);
  });

  it("leaves unknown $FOO literal and records it in unknown", () => {
    const r = substitute("hello $FOO", { projectDir: PROJECT_DIR });
    expect(r.output).toBe("hello $FOO");
    expect(r.unknown).toEqual(["FOO"]);
  });

  it("dedupes unknowns while preserving first-seen order", () => {
    const r = substitute("$FOO $BAR $FOO", { projectDir: PROJECT_DIR });
    expect(r.output).toBe("$FOO $BAR $FOO");
    expect(r.unknown).toEqual(["FOO", "BAR"]);
  });

  it("honors \\$ escape — literal $ARGUMENTS is preserved", () => {
    const r = substitute("\\$ARGUMENTS", {
      args: "should-not-appear",
      projectDir: PROJECT_DIR,
    });
    expect(r.output).toBe("$ARGUMENTS");
    expect(r.unknown).toEqual([]);
  });

  it("handles mixed substitutions, escapes, and unknowns", () => {
    const body = "$ARGUMENTS | first=$1 | dir=$CLAUDE_PROJECT_DIR | \\$literal | unk=$UNKNOWN";
    const r = substitute(body, {
      args: "alpha beta",
      projectDir: "/p",
    });
    expect(r.output).toBe("alpha beta | first=alpha | dir=/p | $literal | unk=$UNKNOWN");
    expect(r.unknown).toEqual(["UNKNOWN"]);
  });

  // $10 — we chose the trailing-digit lookahead guard interpretation: $10
  // does NOT match the positional regex (`$([1-9])(?!\d)`), and `10` is not
  // a valid uppercase VAR name, so $10 is left literal and is NOT flagged as
  // unknown. This is the safer, more explicit behavior.
  it("leaves $10 literal (lookahead guard; not a supported positional or VAR)", () => {
    const r = substitute("x=$10", { args: "alpha", projectDir: PROJECT_DIR });
    expect(r.output).toBe("x=$10");
    expect(r.unknown).toEqual([]);
  });

  it("does not substitute or flag lowercase $var", () => {
    const r = substitute("hey $var there", { projectDir: PROJECT_DIR });
    expect(r.output).toBe("hey $var there");
    expect(r.unknown).toEqual([]);
  });
});

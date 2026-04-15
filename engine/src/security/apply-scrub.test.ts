import { describe, expect, it } from "vitest";
import { applyScrub } from "./apply-scrub.js";
import { builtInPatterns } from "./secret-patterns.js";

const patterns = builtInPatterns();
const ANTHROPIC = "sk-ant-AAAAAAAAAAAAAAAAAAAAAABBBB";

describe("applyScrub", () => {
  it("scrubs nested string at depth 3", () => {
    const input = { a: { b: { c: `leak ${ANTHROPIC}` } } };
    const res = applyScrub(input, patterns);
    const out = res.value as { a: { b: { c: string } } };
    expect(out.a.b.c).toBe("leak [REDACTED:anthropic_api_key]");
    expect(res.hits).toBe(1);
    expect(res.byName.anthropic_api_key).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it("walks arrays of mixed types", () => {
    const input: unknown[] = [1, `key=${ANTHROPIC}`, null, true, undefined];
    const res = applyScrub(input, patterns);
    const out = res.value as unknown[];
    expect(out[0]).toBe(1);
    expect(out[1]).toBe("key=[REDACTED:anthropic_api_key]");
    expect(out[2]).toBe(null);
    expect(out[3]).toBe(true);
    expect(out[4]).toBe(undefined);
    expect(res.hits).toBe(1);
  });

  it("passes primitives through unchanged", () => {
    expect(applyScrub(42, patterns).value).toBe(42);
    expect(applyScrub(true, patterns).value).toBe(true);
    expect(applyScrub(null, patterns).value).toBe(null);
    expect(applyScrub(undefined, patterns).value).toBe(undefined);
  });

  it("maxDepth truncates deeper values", () => {
    const input = { a: { b: { c: { d: { e: `x ${ANTHROPIC}` } } } } };
    const res = applyScrub(input, patterns, { maxDepth: 2 });
    expect(res.truncated).toBe(true);
  });

  it("handles direct self-cycles without infinite recursion", () => {
    interface Node {
      self?: Node;
      name: string;
    }
    const o: Node = { name: "root" };
    o.self = o;
    const res = applyScrub(o, patterns);
    const out = res.value as { name: string; self: unknown };
    expect(out.name).toBe("root");
    expect(out.self).toBe("[CYCLE]");
  });

  it("object keys themselves are NOT scrubbed", () => {
    const input: Record<string, string> = {};
    input[ANTHROPIC] = "value";
    const res = applyScrub(input, patterns);
    const out = res.value as Record<string, string>;
    // The key must still be present literally.
    expect(Object.keys(out)).toContain(ANTHROPIC);
    expect(out[ANTHROPIC]).toBe("value");
    expect(res.hits).toBe(0);
  });

  it("budget exceeded still returns hits (stubbed clock)", () => {
    // `now()` returns an ever-increasing time — so the very first walk step
    // sees elapsed > budgetMs (the second call to now() already exceeds 100).
    let tick = 0;
    const now = (): number => {
      const v = tick;
      tick += 1000;
      return v;
    };
    const input = { a: `k=${ANTHROPIC}` };
    const res = applyScrub(input, patterns, { budgetMs: 100, now });
    // Still scrubs — budget is a warn, not a hard stop.
    const out = res.value as { a: string };
    expect(out.a).toBe("k=[REDACTED:anthropic_api_key]");
    expect(res.hits).toBe(1);
  });

  it("does not mutate input", () => {
    const original = { a: { b: `leak ${ANTHROPIC}` } };
    const snapshot = JSON.parse(JSON.stringify(original)) as typeof original;
    applyScrub(original, patterns);
    expect(original).toEqual(snapshot);
    // And the top-level reference must be unchanged.
    expect(original.a.b).toBe(`leak ${ANTHROPIC}`);
  });
});

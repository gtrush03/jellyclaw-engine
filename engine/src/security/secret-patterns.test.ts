import { describe, expect, it } from "vitest";
import { scrubString } from "./scrub.js";
import {
  builtInPatterns,
  compileUserPatterns,
  InvalidPatternError,
  mergePatterns,
  ReDoSRejectedError,
} from "./secret-patterns.js";

describe("builtInPatterns", () => {
  it("returns at least 12 patterns", () => {
    const patterns = builtInPatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(12);
  });

  it("every pattern has global flag and snake_case name", () => {
    const patterns = builtInPatterns();
    for (const p of patterns) {
      expect(p.re.flags).toContain("g");
      expect(p.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("redacts anthropic key with anthropic_api_key marker", () => {
    const patterns = builtInPatterns();
    const res = scrubString("here is sk-ant-AAAAAAAAAAAAAAAAAAAAAABBBB key", patterns);
    expect(res.scrubbed).toContain("[REDACTED:anthropic_api_key]");
    expect(res.hits).toBe(1);
    expect(res.byName.anthropic_api_key).toBe(1);
  });

  it("narrow wins: sk-ant-... redacted as anthropic, not openai", () => {
    const patterns = builtInPatterns();
    const res = scrubString("sk-ant-AAAAAAAAAAAAAAAAAAAAAABBBB", patterns);
    expect(res.byName.anthropic_api_key).toBe(1);
    expect(res.byName.openai_api_key).toBeUndefined();
  });

  it("does not match short sk-short strings", () => {
    const patterns = builtInPatterns();
    const res = scrubString("token sk-short here", patterns);
    expect(res.hits).toBe(0);
    expect(res.scrubbed).toBe("token sk-short here");
  });
});

describe("compileUserPatterns", () => {
  it("accepts a well-formed spec", () => {
    const res = compileUserPatterns([{ name: "my_api", regex: "MYAPI[A-Z0-9]{8,}" }]);
    expect(res.rejected).toEqual([]);
    expect(res.patterns).toHaveLength(1);
    expect(res.patterns[0]?.name).toBe("my_api");
    expect(res.patterns[0]?.re.flags).toContain("g");
  });

  it("rejects regex with \\1 backreference with InvalidPatternError-style reason", () => {
    const res = compileUserPatterns([{ name: "bad_backref", regex: "(a)\\1" }]);
    expect(res.patterns).toHaveLength(0);
    expect(res.rejected[0]?.name).toBe("bad_backref");
    expect(res.rejected[0]?.reason).toMatch(/backreference/);
  });

  it("auto-adds /g flag when user omits it", () => {
    const res = compileUserPatterns([{ name: "no_g", regex: "FOO", flags: "i" }]);
    expect(res.patterns[0]?.re.flags).toContain("g");
    expect(res.patterns[0]?.re.flags).toContain("i");
  });

  it("rejects via injected slow clock (simulated ReDoS)", () => {
    // Simulate a slow probe by having `now()` return 0, then 1000 ms — making
    // every probe look >50ms without actually running a bad regex.
    let tick = 0;
    const now = (): number => {
      const cur = tick;
      tick += 1000; // each call advances 1000ms
      return cur;
    };
    const res = compileUserPatterns([{ name: "faux_redos", regex: "FOO" }], { now });
    expect(res.patterns).toHaveLength(0);
    expect(res.rejected[0]?.name).toBe("faux_redos");
    expect(res.rejected[0]?.reason).toMatch(/ReDoS/);
  });

  it("errors thrown as instances are constructable", () => {
    const e1 = new ReDoSRejectedError("x", 123.45);
    expect(e1.name).toBe("ReDoSRejectedError");
    expect(e1.patternName).toBe("x");
    const e2 = new InvalidPatternError("y", "bad");
    expect(e2.name).toBe("InvalidPatternError");
    expect(e2.patternName).toBe("y");
  });

  it("rejects invalid regex syntax", () => {
    const res = compileUserPatterns([{ name: "bad_syntax", regex: "(" }]);
    expect(res.patterns).toHaveLength(0);
    expect(res.rejected[0]?.reason).toMatch(/compile/);
  });
});

describe("mergePatterns", () => {
  it("dedupes by name (first wins) and orders builtins, user, literals", () => {
    const builtins = builtInPatterns();
    const user = compileUserPatterns([
      { name: "anthropic_api_key", regex: "nope" }, // duplicate name
      { name: "my_api", regex: "MYAPI[0-9]+" },
    ]).patterns;
    const merged = mergePatterns(builtins, user, ["hunter2"]);
    const names = merged.map((p) => p.name);
    // anthropic_api_key only appears once (builtin wins)
    expect(names.filter((n) => n === "anthropic_api_key")).toHaveLength(1);
    // my_api is included
    expect(names).toContain("my_api");
    // runtime_literal is last
    expect(merged[merged.length - 1]?.name).toBe("runtime_literal");
  });

  it("runtime literal redacts its value in a haystack", () => {
    const merged = mergePatterns([], [], ["hunter2"]);
    const res = scrubString("my password is hunter2 ok?", merged);
    expect(res.scrubbed).toContain("[REDACTED:runtime_literal]");
    expect(res.scrubbed).not.toContain("hunter2");
  });
});

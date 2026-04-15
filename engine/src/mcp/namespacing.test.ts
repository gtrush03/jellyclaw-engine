import { describe, expect, it } from "vitest";

import {
  InvalidServerNameError,
  InvalidToolNameError,
  NAMESPACED_TOOL_RE,
  namespace,
  parse,
  validateServerName,
} from "./namespacing.js";

describe("namespace()", () => {
  it("joins server and tool with double-underscore separators", () => {
    expect(namespace("playwright", "browser_click")).toBe("mcp__playwright__browser_click");
    expect(namespace("gh", "repo")).toBe("mcp__gh__repo");
  });

  it("preserves underscores inside tool names", () => {
    expect(namespace("srv", "do_the_thing")).toBe("mcp__srv__do_the_thing");
  });

  it("preserves dots + digits inside tool names", () => {
    expect(namespace("a1-b2", "tool.v2")).toBe("mcp__a1-b2__tool.v2");
  });

  it("rejects server names containing underscores", () => {
    expect(() => namespace("bad_name", "x")).toThrow(InvalidServerNameError);
  });

  it("rejects server names containing uppercase", () => {
    expect(() => namespace("BadName", "x")).toThrow(InvalidServerNameError);
  });

  it("rejects empty server names", () => {
    expect(() => namespace("", "x")).toThrow(InvalidServerNameError);
  });

  it("rejects tool names containing '__'", () => {
    expect(() => namespace("srv", "has__double")).toThrow(InvalidToolNameError);
  });
});

describe("parse()", () => {
  it("round-trips a valid namespaced name", () => {
    const n = namespace("srv", "tool_v2");
    expect(parse(n)).toEqual({ server: "srv", tool: "tool_v2" });
  });

  it("splits on the first '__' after the mcp prefix (tool keeps extras)", () => {
    // Tool "tool_v2" only has single underscores — ensure parser keeps them.
    expect(parse("mcp__srv__a_b_c")).toEqual({ server: "srv", tool: "a_b_c" });
  });

  it("returns null for malformed input", () => {
    expect(parse("not-namespaced")).toBeNull();
    expect(parse("mcp__srv")).toBeNull();
    expect(parse("mcp____empty-server")).toBeNull();
  });

  it("rejects server names with uppercase (regex enforces [a-z0-9-]+)", () => {
    expect(parse("mcp__SRV__tool")).toBeNull();
  });

  it("regex matches the canonical form", () => {
    expect(NAMESPACED_TOOL_RE.test("mcp__playwright__browser_click")).toBe(true);
  });
});

describe("validateServerName()", () => {
  it("returns the name when valid", () => {
    expect(validateServerName("playwright")).toBe("playwright");
    expect(validateServerName("a-b-c")).toBe("a-b-c");
    expect(validateServerName("a1")).toBe("a1");
  });

  it("throws InvalidServerNameError on invalid input", () => {
    expect(() => validateServerName("bad_name")).toThrow(InvalidServerNameError);
    expect(() => validateServerName("Bad")).toThrow(InvalidServerNameError);
    expect(() => validateServerName("with space")).toThrow(InvalidServerNameError);
    expect(() => validateServerName("")).toThrow(InvalidServerNameError);
  });
});

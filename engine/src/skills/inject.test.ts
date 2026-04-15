import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { buildSkillInjection, DEFAULT_INJECTION_MAX_BYTES } from "./inject.js";
import type { Skill, SkillSource } from "./types.js";

const mkSkill = (name: string, source: SkillSource, description: string): Skill => ({
  name,
  source,
  path: `/tmp/${name}.md`,
  mtimeMs: 0,
  body: "",
  frontmatter: { name, description },
});

function mkLogger() {
  const warn = vi.fn();
  const logger = {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
  return { logger, warn };
}

describe("buildSkillInjection", () => {
  it("returns empty result with no skills and does not warn", () => {
    const { logger, warn } = mkLogger();
    const res = buildSkillInjection({ skills: [], logger });
    expect(res.block).toBe("");
    expect(res.included).toEqual([]);
    expect(res.dropped).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("renders a single small skill under the default cap", () => {
    const { logger, warn } = mkLogger();
    const res = buildSkillInjection({
      skills: [mkSkill("that-skill", "user", "does a thing")],
      logger,
    });
    expect(res.block).toContain("# Available skills (invoke by name via the use_skill tool):\n");
    expect(res.block).toContain("- skill:that-skill — does a thing\n");
    expect(res.included).toEqual(["that-skill"]);
    expect(res.dropped).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(Buffer.byteLength(res.block, "utf8")).toBeLessThanOrEqual(DEFAULT_INJECTION_MAX_BYTES);
  });

  it("sorts by source priority then alphabetically within a source", () => {
    const skills: Skill[] = [
      mkSkill("z-legacy", "legacy", "legacy z"),
      mkSkill("a-project", "project", "project a"),
      mkSkill("b-user", "user", "user b"),
      mkSkill("a-user", "user", "user a"),
      mkSkill("b-project", "project", "project b"),
      mkSkill("a-legacy", "legacy", "legacy a"),
    ];
    const res = buildSkillInjection({ skills });
    expect(res.included).toEqual([
      "a-user",
      "b-user",
      "a-project",
      "b-project",
      "a-legacy",
      "z-legacy",
    ]);
    // Also assert the block emits in that order.
    const firstIdx = res.block.indexOf("a-user");
    const secondIdx = res.block.indexOf("b-user");
    const thirdIdx = res.block.indexOf("a-project");
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  it("drops lowest-priority skills when the cap is exceeded and warns once", () => {
    const { logger, warn } = mkLogger();
    // Each line is roughly 50-60 bytes. With maxBytes=200 and a ~60 byte header,
    // only 2 lines should fit, the third should be dropped.
    const longDesc = "x".repeat(40);
    const skills: Skill[] = [
      mkSkill("a-user", "user", longDesc),
      mkSkill("b-project", "project", longDesc),
      mkSkill("c-legacy", "legacy", longDesc),
    ];
    const res = buildSkillInjection({ skills, maxBytes: 200, logger });
    expect(res.included).toEqual(["a-user", "b-project"]);
    expect(res.dropped).toEqual(["c-legacy"]);
    expect(Buffer.byteLength(res.block, "utf8")).toBeLessThanOrEqual(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { dropped: ["c-legacy"], maxBytes: 200 },
      "skill injection exceeded cap; lowest-priority skills dropped",
    );
  });

  it("is greedy (does not break early) — a later smaller skill fits past a big dropped one", () => {
    const { logger } = mkLogger();
    // Header is 58 bytes. maxBytes = 200 → 142 bytes remaining for lines.
    const small1 = mkSkill("a-user", "user", "tiny"); // ~22 bytes
    const huge = mkSkill("b-user", "user", "X".repeat(400)); // ~416 bytes → won't fit
    const small2 = mkSkill("c-user", "user", "also tiny"); // ~27 bytes → should still fit
    const res = buildSkillInjection({ skills: [small1, huge, small2], maxBytes: 200, logger });
    expect(res.included).toContain("a-user");
    expect(res.included).toContain("c-user");
    expect(res.dropped).toEqual(["b-user"]);
    expect(Buffer.byteLength(res.block, "utf8")).toBeLessThanOrEqual(200);
  });

  it("returns empty block when the header alone exceeds maxBytes and warns", () => {
    const { logger, warn } = mkLogger();
    const skills = [mkSkill("a-user", "user", "hi")];
    const res = buildSkillInjection({ skills, maxBytes: 10, logger });
    expect(res.block).toBe("");
    expect(res.included).toEqual([]);
    expect(res.dropped).toEqual(["a-user"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("counts utf-8 bytes correctly with em-dashes and emoji", () => {
    const { logger } = mkLogger();
    // Description itself contains em-dash (3 bytes) + emoji (4 bytes).
    const desc = "does — a thing 🔥";
    const skills = [mkSkill("emoji-skill", "user", desc)];
    const res = buildSkillInjection({ skills, logger });
    expect(Buffer.byteLength(res.block, "utf8")).toBeLessThanOrEqual(DEFAULT_INJECTION_MAX_BYTES);
    // Verify the em-dash separator between name and description exists.
    expect(res.block).toContain("- skill:emoji-skill — ");
    expect(res.block).toContain(desc);
  });

  it("fires warn exactly once even when many skills are dropped", () => {
    const { logger, warn } = mkLogger();
    const skills: Skill[] = Array.from({ length: 20 }, (_, i) =>
      mkSkill(`s-${String(i).padStart(2, "0")}`, "user", "x".repeat(60)),
    );
    const res = buildSkillInjection({ skills, maxBytes: 200, logger });
    expect(res.dropped.length).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn when nothing is dropped", () => {
    const { logger, warn } = mkLogger();
    const skills = [
      mkSkill("a", "user", "one"),
      mkSkill("b", "project", "two"),
      mkSkill("c", "legacy", "three"),
    ];
    const res = buildSkillInjection({ skills, logger });
    expect(res.dropped).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is deterministic — two calls produce byte-identical blocks", () => {
    const skills = [
      mkSkill("b", "project", "two"),
      mkSkill("a", "user", "one"),
      mkSkill("c", "legacy", "three"),
    ];
    const a = buildSkillInjection({ skills });
    const b = buildSkillInjection({ skills });
    expect(a.block).toBe(b.block);
    expect(a.included).toEqual(b.included);
    expect(a.dropped).toEqual(b.dropped);
  });
});

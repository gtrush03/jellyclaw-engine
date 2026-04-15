import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillsListAction } from "./skills-cmd.js";

function captureStream(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

describe("skillsListAction", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jellyclaw-skills-cmd-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prints 'no skills found' on an empty roots tree", async () => {
    const stdout = captureStream();
    const code = await skillsListAction({
      stdout: stdout.stream,
      stderr: captureStream().stream,
      roots: [{ path: root, source: "user" }],
    });
    expect(code).toBe(0);
    expect(stdout.read()).toContain("no skills found");
  });

  it("prints a row for a fixture skill", async () => {
    writeFileSync(
      join(root, "my-skill.md"),
      "---\nname: my-skill\ndescription: a fixture skill for the CLI test\n---\nbody\n",
    );
    const stdout = captureStream();
    const code = await skillsListAction({
      stdout: stdout.stream,
      stderr: captureStream().stream,
      roots: [{ path: root, source: "user" }],
    });
    expect(code).toBe(0);
    const out = stdout.read();
    expect(out).toContain("NAME");
    expect(out).toContain("my-skill");
    expect(out).toContain("a fixture skill");
    expect(out).toContain("user");
  });

  it("supports a dir-per-skill layout", async () => {
    const dir = join(root, "nested-skill");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: nested-skill\ndescription: nested variant\n---\nbody\n",
    );
    const stdout = captureStream();
    const code = await skillsListAction({
      stdout: stdout.stream,
      stderr: captureStream().stream,
      roots: [{ path: root, source: "project" }],
    });
    expect(code).toBe(0);
    expect(stdout.read()).toContain("nested-skill");
  });
});

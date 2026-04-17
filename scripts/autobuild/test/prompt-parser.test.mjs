// prompt-parser.test.mjs — round-trip a minimal fixture prompt.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { parsePrompt } from "../lib/prompt-parser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("parsePrompt returns all required fields for sample fixture", () => {
  const parsed = parsePrompt(join(HERE, "fixtures", "sample.md"));
  assert.equal(parsed.id, "T9-99-sample-fixture");
  assert.equal(parsed.tier, 9);
  assert.equal(parsed.title, "Sample fixture for unit tests");
  assert.deepEqual(parsed.scope, ["engine/src/**/*.ts", "test/**/*"]);
  assert.equal(parsed.max_turns, 5);
  assert.equal(parsed.max_cost_usd, 1);
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.tests[0].kind, "shell");
  assert.equal(parsed.tests[0].name, "sample-echo");
  assert.match(parsed.body, /# T9-99 — Sample fixture/);
});

test("parsePrompt throws on missing required fields", () => {
  const bad = `---\nid: bad\ntier: 0\ntitle: x\nscope:\n  - a\n---\nbody\n`;
  const tmp = join(HERE, "fixtures", `.tmp-bad-${process.pid}.md`);
  writeFileSync(tmp, bad);
  try {
    assert.throws(() => parsePrompt(tmp), /required frontmatter/);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
});

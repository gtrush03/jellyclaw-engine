/**
 * One-off smoke script: discover + load skills from the default roots,
 * print a summary to stderr. Not wired into the CLI yet (Phase 10).
 *
 *   bun run engine/scripts/skills-dump.ts
 */

import { createLogger } from "../src/logger.js";
import { SkillRegistry } from "../src/skills/index.js";

const log = createLogger({ name: "skills-dump", pretty: true });

const registry = new SkillRegistry();
await registry.loadAll({ logger: log });

const skills = registry.list();
log.info({ count: skills.length }, "loaded skills");
for (const s of skills) {
  log.info(
    {
      name: s.name,
      source: s.source,
      path: s.path,
      description: s.frontmatter.description,
      bodyBytes: Buffer.byteLength(s.body, "utf8"),
    },
    s.name,
  );
}

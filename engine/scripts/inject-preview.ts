/**
 * Smoke: load all skills from the default roots, render the progressive-
 * disclosure injection block, and print it to stdout. Does NOT start the
 * watcher.
 *
 *   bun run engine/scripts/inject-preview.ts
 */

import { createLogger } from "../src/logger.js";
import { buildSkillInjection, SkillRegistry } from "../src/skills/index.js";

const log = createLogger({ name: "inject-preview", pretty: true });

const registry = new SkillRegistry();
await registry.loadAll({ logger: log });

const result = buildSkillInjection({ skills: registry.list(), logger: log });

log.info(
  {
    included: result.included,
    dropped: result.dropped,
    bytes: Buffer.byteLength(result.block, "utf8"),
  },
  "injection summary",
);

process.stdout.write("\n===== INJECTION BLOCK =====\n");
process.stdout.write(result.block);
process.stdout.write("\n===== END =====\n");

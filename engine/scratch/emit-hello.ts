/**
 * Scratch — hand-drive the adapter + emitter against the golden
 * OpenCode fixture and print NDJSON to stdout. Useful for eyeballing
 * the end-to-end shape without booting a real OpenCode server (which
 * needs `ANTHROPIC_API_KEY`).
 *
 * Run:
 *   $ bun run engine/scratch/emit-hello.ts                  # jellyclaw-full
 *   $ bun run engine/scratch/emit-hello.ts claude-code-compat
 *   $ bun run engine/scratch/emit-hello.ts claurst-min
 *
 * Delete or ignore — not part of the public engine surface.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OutputFormat } from "@jellyclaw/shared";
import { createAdapterFromSource } from "../src/adapters/opencode-events.js";
import { StreamEmitter } from "../src/stream/emit.js";

const FIXTURE = fileURLToPath(new URL("../../test/golden/hello.opencode.jsonl", import.meta.url));

// biome-ignore lint/suspicious/useAwait: async generator — yield satisfies the intent; no await needed
async function* pumpFixture(): AsyncIterable<string> {
  const lines = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  for (const l of lines) yield l;
}

async function main(): Promise<void> {
  const format = (process.argv[2] ?? "jellyclaw-full") as OutputFormat;
  let tick = 0;
  const clock = () => {
    tick += 1;
    return tick;
  };
  const handle = createAdapterFromSource({
    source: pumpFixture(),
    sessionId: "ses-scratch",
    clock,
    cwd: process.cwd(),
    model: "claude-opus-4-6",
    tools: ["bash"],
    config: {
      provider: "anthropic",
      anthropic: { apiKey: "sk-ant-scratch-fixture-do-not-commit" },
      model: "claude-opus-4-6",
    },
  });
  const emitter = new StreamEmitter(process.stdout, format);
  for await (const ev of handle) {
    await emitter.emit(ev);
  }
  await emitter.finish();
}

void main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

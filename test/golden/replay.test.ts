/**
 * Golden replay test.
 *
 * Reads `hello.opencode.jsonl` (raw OpenCode SSE frames, one JSON object
 * per line — each is the `data:` payload of a real SSE event), feeds
 * every payload into `createAdapterFromSource`, and asserts the emitted
 * jellyclaw events byte-match `hello.jellyclaw.jsonl` after
 * normalisation.
 *
 * Why synthetic goldens: a live capture requires a real
 * `ANTHROPIC_API_KEY` and a running OpenCode child process. This
 * machine does not have the credential (see `.env.example` — template
 * only, no `.env`), so the hand-written fixture stands in. The file
 * shape is 1:1 with what `engine/src/bootstrap/opencode-server.ts` +
 * `GET /event` emit against v1.4.5; the frame shapes mirror those used
 * in `engine/src/adapters/opencode-events.test.ts`.
 *
 * When a live capture becomes available, run:
 *   $ GOLDEN_UPDATE=1 bun run test test/golden/replay.test.ts
 * to regenerate `hello.jellyclaw.jsonl` from the current adapter logic.
 *
 * The normaliser strips only:
 *   - `ts`                 → 0
 *   - `session_id`         → "ses-golden"
 *   - `stats.duration_ms`  → 0  (on `result` events)
 *   - `duration_ms`        → 0  (on `tool.call.end` events)
 *
 * It does NOT touch `tool_use_id` (they are already stable in the
 * fixture) nor any payload content — so any drift in the adapter's
 * projection shape surfaces the test, not the normaliser.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Event } from "@jellyclaw/shared";
import { describe, expect, it } from "vitest";
import { createAdapterFromSource } from "../../engine/src/adapters/opencode-events.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OPENCODE_PATH = `${HERE}hello.opencode.jsonl`;
const JELLYCLAW_PATH = `${HERE}hello.jellyclaw.jsonl`;

function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

function normalise(e: Event): Event {
  // Deep clone via JSON so the mutation below can't leak.
  const out = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
  if ("ts" in out) out.ts = 0;
  if ("session_id" in out) out.session_id = "ses-golden";
  if (out.type === "result") {
    const r = out as { stats?: { duration_ms?: number } };
    if (r.stats) r.stats.duration_ms = 0;
  }
  if (out.type === "tool.call.end" && "duration_ms" in out) {
    out.duration_ms = 0;
  }
  return out as unknown as Event;
}

// biome-ignore lint/suspicious/useAwait: returns a synchronous wrapper; async signature kept for symmetry with a future live-capture variant
async function fromLines(lines: readonly string[]): Promise<AsyncIterable<string>> {
  // biome-ignore lint/suspicious/useAwait: async generator — yield satisfies the intent
  async function* gen(): AsyncIterableIterator<string> {
    for (const l of lines) {
      // The opencode fixture is one `data:` payload per line — the
      // adapter's source iterable receives just the payload string.
      yield l;
    }
  }
  return { [Symbol.asyncIterator]: gen };
}

async function runAdapter(rawLines: readonly string[]): Promise<Event[]> {
  const source = await fromLines(rawLines);
  let tick = 0;
  const clock = () => {
    tick += 1;
    return tick;
  };
  const handle = createAdapterFromSource({
    source,
    sessionId: "ses-live",
    clock,
    cwd: "/tmp",
    model: "claude-opus-4-6",
    tools: ["bash"],
    config: {
      provider: "anthropic",
      anthropic: { apiKey: "sk-ant-goldenfixturekey0123" },
      model: "claude-opus-4-6",
    },
    orderingTimeoutMs: 2_000,
    costTickEvery: 5,
  });
  const out: Event[] = [];
  for await (const e of handle) out.push(e);
  return out;
}

describe("golden replay: hello", () => {
  it("adapter replay of the OpenCode fixture matches the jellyclaw golden", async () => {
    const rawLines = readLines(OPENCODE_PATH);
    const events = await runAdapter(rawLines);
    const normalisedLines = events.map((e) => JSON.stringify(normalise(e)));

    if (process.env.GOLDEN_UPDATE === "1") {
      writeFileSync(JELLYCLAW_PATH, `${normalisedLines.join("\n")}\n`);
    }

    const expected = readLines(JELLYCLAW_PATH);
    expect(normalisedLines).toEqual(expected);
  });

  it("normaliser is narrow — mutating a payload field breaks the match", () => {
    const sample = {
      type: "assistant.delta" as const,
      session_id: "x",
      text: "hi",
      ts: 42,
    };
    const norm = normalise(sample);
    const mutated = { ...sample, text: "HI" };
    const mutatedNorm = normalise(mutated);
    expect(JSON.stringify(norm)).not.toBe(JSON.stringify(mutatedNorm));
  });
});

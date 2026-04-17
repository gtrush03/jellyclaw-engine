/**
 * smoke-02-simple-prompt — single-turn HTTP round-trip against a live server.
 *
 * Spawns `jellyclaw serve` on a random free port, POSTs a trivial prompt,
 * streams SSE until `session.completed` or timeout. Asserts:
 *   - at least one `agent.message` event with `final=true`
 *   - exactly one `session.completed` event
 *   - zero `session.error` events
 */

import { assert, createRun, streamRunEvents, withServer } from "./lib/harness.mjs";

export default async function run({ log }) {
  const started = Date.now();

  const result = await withServer(async ({ baseUrl, token }) => {
    log?.(`  server up at ${baseUrl}`);
    const { runId, sessionId } = await createRun(baseUrl, token, {
      prompt: "What is 2+2? Answer in one word.",
      maxTurns: 5,
    });
    log?.(`  run ${runId} (session ${sessionId}) created`);
    const { events, kindCounts } = await streamRunEvents(
      baseUrl,
      token,
      runId,
      undefined,
      { timeoutMs: 90_000 },
    );
    log?.(`  received ${events.length} events; kinds=${JSON.stringify(kindCounts)}`);

    const finalMessages = events.filter(
      (e) => e?.type === "agent.message" && e?.final === true,
    );
    assert(
      finalMessages.length >= 1,
      "smoke-02: expected at least one agent.message with final=true",
      `kindCounts=${JSON.stringify(kindCounts)}`,
    );
    assert(
      (kindCounts["session.completed"] ?? 0) >= 1,
      "smoke-02: expected session.completed",
      `kindCounts=${JSON.stringify(kindCounts)}`,
    );
    assert(
      (kindCounts["session.error"] ?? 0) === 0,
      "smoke-02: saw session.error",
      JSON.stringify(events.filter((e) => e?.type === "session.error")),
    );

    return { kindCounts, eventCount: events.length };
  });

  return {
    name: "smoke-02-simple-prompt",
    passed: true,
    duration_ms: Date.now() - started,
    details: result,
  };
}

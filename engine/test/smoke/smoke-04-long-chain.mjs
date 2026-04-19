/**
 * smoke-04-long-chain — multi-turn sequential Bash chain.
 *
 * Forces 6 sequential Bash turns. Asserts:
 *   - ≥5 tool.called events with tool_name === "Bash"
 *   - session.completed emitted
 *   - no session.error
 *   - max input_tokens seen across usage.updated < 50k (no context blow-up)
 */

import { assert, createRun, maxInputTokens, streamRunEvents, withServer } from "./lib/harness.mjs";

export default async function run({ log }) {
  const started = Date.now();

  const result = await withServer(async ({ baseUrl, token }) => {
    log?.(`  server up at ${baseUrl}`);
    const { runId } = await createRun(baseUrl, token, {
      prompt:
        "Do these separately, one tool per turn: " +
        "(1) Bash: 'echo step-1' " +
        "(2) Bash: 'echo step-2' " +
        "(3) Bash: 'echo step-3' " +
        "(4) Bash: 'echo step-4' " +
        "(5) Bash: 'echo step-5' " +
        "(6) Bash: 'echo step-6'. " +
        "Then summarize.",
      maxTurns: 20,
    });
    log?.(`  run ${runId} created`);

    const { events, kindCounts } = await streamRunEvents(baseUrl, token, runId, undefined, {
      timeoutMs: 240_000,
    });
    log?.(`  received ${events.length} events; kinds=${JSON.stringify(kindCounts)}`);

    let bashCalls = 0;
    for (const e of events) {
      if (e?.type === "tool.called" && e?.tool_name === "Bash") bashCalls++;
    }
    const peakInput = maxInputTokens(events);
    log?.(`  bashCalls=${bashCalls} peakInputTokens=${peakInput}`);

    assert(bashCalls >= 5, "smoke-04: expected ≥5 tool.called Bash events", `got ${bashCalls}`);
    assert(
      (kindCounts["session.completed"] ?? 0) >= 1,
      "smoke-04: expected session.completed",
      `kindCounts=${JSON.stringify(kindCounts)}`,
    );
    assert(
      (kindCounts["session.error"] ?? 0) === 0,
      "smoke-04: saw session.error",
      JSON.stringify(events.filter((e) => e?.type === "session.error")),
    );
    assert(
      peakInput < 50_000,
      "smoke-04: peak input_tokens exceeded 50k (context explosion)",
      `peak=${peakInput}`,
    );

    return { bashCalls, peakInputTokens: peakInput, kindCounts, eventCount: events.length };
  });

  return {
    name: "smoke-04-long-chain",
    passed: true,
    duration_ms: Date.now() - started,
    details: result,
  };
}

/**
 * smoke-03-parallel-tools — parallel tool-call dispatch.
 *
 * Forces the agent to call Glob, Read, and Grep in the same turn. Asserts
 * ≥2 of {Glob, Read, Grep} fire via `tool.called`, session completes cleanly.
 */

import { assert, createRun, streamRunEvents, withServer } from "./lib/harness.mjs";

export default async function run({ log }) {
  const started = Date.now();

  const result = await withServer(async ({ baseUrl, token }) => {
    log?.(`  server up at ${baseUrl}`);
    const { runId } = await createRun(baseUrl, token, {
      prompt:
        "Use Glob to list *.md files in /tmp, Read /etc/hosts, and Grep for 'localhost' in /etc/hosts. Do all three in parallel.",
      maxTurns: 10,
      cwd: "/tmp",
    });
    log?.(`  run ${runId} created`);

    const { events, kindCounts } = await streamRunEvents(
      baseUrl,
      token,
      runId,
      undefined,
      { timeoutMs: 120_000 },
    );
    log?.(`  received ${events.length} events; kinds=${JSON.stringify(kindCounts)}`);

    const targetTools = new Set(["Glob", "Read", "Grep"]);
    const toolsSeen = new Set();
    for (const e of events) {
      if (e?.type === "tool.called" && typeof e.tool_name === "string") {
        if (targetTools.has(e.tool_name)) toolsSeen.add(e.tool_name);
      }
    }

    assert(
      toolsSeen.size >= 2,
      "smoke-03: expected tool.called for ≥2 of {Glob,Read,Grep}",
      `saw: ${[...toolsSeen].join(",")}`,
    );
    assert(
      (kindCounts["session.error"] ?? 0) === 0,
      "smoke-03: saw session.error",
      JSON.stringify(events.filter((e) => e?.type === "session.error")),
    );
    assert(
      (kindCounts["session.completed"] ?? 0) >= 1,
      "smoke-03: expected session.completed",
      `kindCounts=${JSON.stringify(kindCounts)}`,
    );

    return { toolsSeen: [...toolsSeen], kindCounts, eventCount: events.length };
  });

  return {
    name: "smoke-03-parallel-tools",
    passed: true,
    duration_ms: Date.now() - started,
    details: result,
  };
}

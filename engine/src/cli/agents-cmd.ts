/**
 * `jellyclaw agents list` — Phase 10.01.
 *
 * Phase 06 (subagents) is still stubbed — see `engine/src/subagents/stub.ts`.
 * The stub's `dispatch()` throws `SubagentsNotImplementedError` and there
 * is no `list()` surface yet. We print a friendly placeholder and exit 0
 * so the CLI ergonomics mirror the post-Phase-06 shape without blocking
 * smoke tests on an empty registry.
 *
 * When Phase 06 lands and `SubagentService` grows a `.list()` method,
 * swap the body here to enumerate registered agents.
 */

export interface AgentsListDeps {
  readonly stdout?: NodeJS.WritableStream;
}

export function agentsListAction(deps: AgentsListDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  stdout.write(
    "No agents registered (subagents service is a Phase 06 stub — `.list()` returns [])\n",
  );
  return Promise.resolve(0);
}

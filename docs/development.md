# Development

## Upstream rebase checklist

Whenever the pinned `opencode-ai` version is bumped (see `package.json`), run:

```bash
bun run test:hook-patch
```

This is the regression-gate for [OpenCode issue #5894](https://github.com/sst/opencode/issues/5894)
— the subagent tool-hook bypass that jellyclaw originally intended to fix via a
`patch-package` diff.

### Why this is not a real `.patch` anymore

The npm distribution of `opencode-ai` is a **compiled Bun-built standalone binary**.
There is no consumer-side TypeScript to diff against, so `patch-package` has
nothing to write hunks against. The three originally-planned patches were
therefore reimplemented as first-class jellyclaw code; the hook-fire fix lives
as an in-process plugin at `engine/src/plugin/agent-context.ts`.

Because there is no real patch file, `test:hook-patch` validates the jellyclaw
in-process replacement along with the dispatcher's event-stream behavior. It
performs two checks:

1. **Static surface** — the design-intent record
   (`patches/001-subagent-hook-fire.design.md`) is still present and marked
   `STATUS: superseded`, `patches/README.md` exists, and the live replacement
   at `engine/src/plugin/agent-context.ts` still exports
   `enrichHookEnvelope`, `createCachedResolver`, and `MAX_AGENT_CHAIN_DEPTH`.

2. **Dynamic behavior** — the integration test at
   `test/integration/subagent-hooks.test.ts` is spawned under vitest and must
   pass. This exercises the dispatcher-level event-stream behavior that the
   original upstream bug would have broken.

A failure in either step means either upstream #5894 has resurfaced against the
newly-pinned `opencode-ai` binary or the jellyclaw dispatcher itself has
regressed. Do not bump the pin until this passes.

### References

- `scripts/verify-hook-patch.ts` — the verification script itself.
- `test/integration/subagent-hooks.test.ts` — dispatcher-level regression test.
- `engine/src/plugin/agent-context.ts` — the live in-process replacement.
- `patches/README.md` — full explanation of the compiled-binary pivot and why
  `patch-package` has nothing to diff against for `opencode-ai`.
- `patches/001-subagent-hook-fire.design.md` — the original design-intent
  record, retained as historical provenance.

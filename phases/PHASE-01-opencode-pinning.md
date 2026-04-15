---
phase: 01
name: "OpenCode pinning and patching"
duration: "1 day"
depends_on: [00]
blocks: [02, 03, 04, 05, 06, 07, 08, 09, 10]
---

# Phase 01 — OpenCode pinning and patching

## Dream outcome

Running `pnpm --filter engine start` launches OpenCode's headless server bound to `127.0.0.1`, authenticated by `OPENCODE_SERVER_PASSWORD`, on a known port. The `issue #5894` subagent-hook-bypass patch is applied via `patch-package`, verified by a unit test that drives a subagent task and observes the `PreToolUse` hook firing inside the subagent. A reinstall reapplies the patch automatically.

## Deliverables

- `engine/package.json` with pinned deps:
  - `opencode-ai@>=1.4.4 <2`
  - `@opencode-ai/sdk@<matching>`
  - `@opencode-ai/plugin@<matching>`
- `engine/src/plugin/agent-context.ts` (replaces the #5894-style patch; enriches `tool.execute.before/after` envelopes with `agent`, `parentSessionID`, `agentChain`)
- `engine/src/plugin/secret-scrub.ts` (replaces the credential-scrub patch)
- `engine/src/bootstrap/opencode-server.ts` — spawns the server hostname-locked to `127.0.0.1`, asserts the kernel-reported bind address (getsockname-equivalent) and port fall inside the ephemeral range, returns `{url, token}`
- `engine/src/bootstrap/opencode-server.test.ts` — smoke test
- Unit tests for both plugins under `engine/src/plugin/*.test.ts`
- Updated `patches/README.md` describing the pivot to plugin-based controls

## Step-by-step

### Step 1 — Create engine package
```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/engine
cat > package.json <<'EOF'
{
  "name": "@jellyclaw/engine",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "test": "vitest run",
    "start": "tsx src/bootstrap/opencode-server.ts"
  },
  "dependencies": {
    "opencode-ai": ">=1.4.4 <2",
    "@opencode-ai/sdk": "*",
    "@opencode-ai/plugin": "*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
EOF
```
Create `engine/tsconfig.json` extending `../tsconfig.base.json`, `outDir: dist`, `include: ["src/**/*"]`.

### Step 2 — Install + record exact versions
```bash
pnpm install
pnpm --filter @jellyclaw/engine ls opencode-ai @opencode-ai/sdk @opencode-ai/plugin
```
Expected: versions printed. Record them in `patches/README.md`. If `opencode-ai` resolves to `<1.4.4`, force: `pnpm add opencode-ai@1.4.4 --filter @jellyclaw/engine`.

### Step 3 — Verify CVE-22812 fix is present
OpenCode `1.4.4` patched CVE-22812 (arbitrary file read via path traversal in `/file` endpoint). Sanity-check:
```bash
pnpm --filter @jellyclaw/engine exec node -e "console.log(require('opencode-ai/package.json').version)"
```
Expected: `1.4.4` or higher. If lower, bump.

### Step 4 — Characterize the real #5894 gap before writing the plugin
At v1.4.5 hooks **do** fire for subagent tool calls (plugins are Instance-scoped via `plugin/index.ts`'s `InstanceState.get(state)` path). The real gap is envelope identity: none of the three `plugin.trigger("tool.execute.*", …)` sites in `prompt.ts` pass `agent` / `parentSessionID` / `agentChain`. Write a throwaway script in `engine/scratch/repro-5894.ts` that spawns the server, registers a stub plugin recording every `tool.execute.before` envelope, and dispatches a Task tool call. Expected observation pre-plugin: envelopes fire for both root and subagent calls, but all are missing the `agent` field.

### Step 5 — Author the plugin replacements

Source-level patching is not available: `opencode-ai` ships as a compiled Bun-built standalone binary on npm (see `engine/opencode-research-notes.md` §1, §3.3, §5, §6.1, §6.2). All three originally-planned patches are reimplemented as jellyclaw-side modules:

| Replaces                                    | Implement at                                        | Target behavior                                                                                                                                                |
|---------------------------------------------|------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `001-subagent-hook-fire.patch`              | `engine/src/plugin/agent-context.ts`                 | Jellyclaw plugin loaded ahead of user plugins; enriches `tool.execute.before/after` envelopes with `agent`, `parentSessionID`, `agentChain` from the session graph it maintains. |
| `002-bind-localhost-only.patch`             | `engine/src/bootstrap/opencode-server.ts`            | Spawn opencode serve with `--hostname 127.0.0.1` hard-coded; after listen, assert the kernel-reported bind address (getsockname-equivalent) is loopback and the resolved port is in `[49152, 65535]`. Exit 3 on violation. |
| `003-secret-scrub-tool-results.patch`       | `engine/src/plugin/secret-scrub.ts`                  | Jellyclaw plugin; in the `tool.execute.after` path, scrub credential patterns (Anthropic/OpenAI/OpenRouter/Stripe/AWS/Google/GitHub/JWT/Bearer/env-line/URL creds) from the tool result before it reaches the LLM. |

The original `.patch` files have been renamed to `.design.md` under `patches/` as historical records — keep them for provenance; do not delete them.

### Step 6 — Wire the plugin into bootstrap
Ensure `engine/src/bootstrap/opencode-server.ts` loads `agent-context.ts` and `secret-scrub.ts` at session start, **before** any user-supplied plugins, so downstream plugins see the enriched envelopes. Re-run `pnpm install` from a clean slate (`rm -rf node_modules engine/node_modules`) as a sanity check that `patch-package`'s `postinstall` is a no-op (no patches to apply) and nothing fails loudly.

### Step 7 — Re-run repro → expect envelope enrichment
Re-run `repro-5894.ts` with the plugins loaded. Expected: every recorded `tool.execute.before` envelope contains `agent`, `parentSessionID`, and `agentChain`; nested-subagent calls resolve `agent` to the subagent's name, not the root.

### Step 8 — Server bootstrap module
`engine/src/bootstrap/opencode-server.ts`:
```ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface OpenCodeHandle { url: string; token: string; kill: () => void; }

export async function startOpenCode(opts: { port?: number } = {}): Promise<OpenCodeHandle> {
  const token = process.env.OPENCODE_SERVER_PASSWORD ?? randomBytes(16).toString("hex");
  const port = opts.port ?? 0; // let kernel pick
  const proc = spawn("npx", ["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: token },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const url = await new Promise<string>((resolve, reject) => {
    proc.stdout!.on("data", (b) => {
      const m = String(b).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    proc.once("exit", (code) => reject(new Error(`opencode exited ${code}`)));
    setTimeout(() => reject(new Error("opencode serve timeout")), 10_000);
  });
  return { url, token, kill: () => proc.kill("SIGTERM") };
}
```

### Step 9 — Smoke test
`engine/src/bootstrap/opencode-server.test.ts`:
```ts
import { expect, test } from "vitest";
import { startOpenCode } from "./opencode-server.js";

test("opencode serve binds to 127.0.0.1 and requires token", async () => {
  const h = await startOpenCode();
  try {
    const r401 = await fetch(`${h.url}/config`);
    expect(r401.status).toBe(401);
    const r200 = await fetch(`${h.url}/config`, { headers: { Authorization: `Bearer ${h.token}` } });
    expect(r200.ok).toBe(true);
  } finally { h.kill(); }
});
```
Run: `pnpm --filter @jellyclaw/engine test`. Expected: both assertions pass.

### Step 10 — patches/README.md

Rewrite `patches/README.md` to reflect the pivot:

- Lead with "zero active patches against `opencode-ai`" and the compiled-binary rationale (link to `engine/opencode-research-notes.md` §1, §3.3, §5, §6.1, §6.2).
- Map each originally-planned patch to its plugin/bootstrap replacement (see Step 5 table).
- Explain that `patch-package` is retained in the toolchain for future non-binary dependencies and still runs on `postinstall`, but currently applies nothing.
- Keep the upstream-candidacy taxonomy (`[upstream-candidate]` / `[upstream-unlikely]` / `[genie-specific]`) for when a real patch is added.
- Point to the three `.design.md` historical records in the same directory.

## Acceptance criteria

- [ ] `opencode-ai@>=1.4.4` installed and locked in `pnpm-lock.yaml`
- [ ] `engine/src/plugin/agent-context.ts` and `engine/src/plugin/secret-scrub.ts` exist with passing unit tests
- [ ] `engine/src/bootstrap/opencode-server.ts` asserts loopback bind (getsockname-equivalent) and ephemeral-range port after listen; exits 3 on violation
- [ ] Smoke test passes
- [ ] Hook observability test: a stub plugin records every `tool.execute.before` envelope during a subagent task and asserts `input.agent` resolves to the subagent's name on nested calls (proves Layer A enrichment works)
- [ ] Server binds `127.0.0.1` only (not `0.0.0.0`)
- [ ] Unauthenticated requests return `401`

## Risks + mitigations

- **Upstream OpenCode plugin API change breaks the envelope enrichment** → since we cannot patch the compiled binary, our surface area is the `@opencode-ai/plugin` hook contract. Add a CI job that runs on a matrix of `opencode-ai@latest` + pinned and asserts the enriched envelope still reaches downstream user plugins unchanged.
- **SDK/plugin version skew** → pin all three to exact versions that shipped together.
- **Headless server leaks port on test failure** → `kill` in `finally`; add a `beforeEach`/`afterEach` global in vitest config if needed.

## Dependencies to install

```
opencode-ai@>=1.4.4 <2
@opencode-ai/sdk@<matching>
@opencode-ai/plugin@<matching>
zod@^3.23
tsx@^4.19
```

## Files touched

- `engine/package.json`, `engine/tsconfig.json`
- `engine/src/bootstrap/opencode-server.ts`
- `engine/src/bootstrap/opencode-server.test.ts`
- `engine/src/plugin/agent-context.ts` (+ test)
- `engine/src/plugin/secret-scrub.ts` (+ test)
- `patches/README.md` (pivot narrative)
- `patches/001-subagent-hook-fire.design.md` (renamed from `.patch`, STATUS block prepended)
- `patches/002-bind-localhost-only.design.md` (renamed from `.patch`, STATUS block prepended)
- `patches/003-secret-scrub-tool-results.design.md` (renamed from `.patch`, STATUS block prepended)
- `engine/scratch/repro-5894.ts` (gitignored after verification)

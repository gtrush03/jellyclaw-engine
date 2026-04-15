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
- `patches/opencode-ai+<version>.patch` (the #5894 subagent hook fix)
- `engine/src/bootstrap/opencode-server.ts` — spawns the server, returns `{url, token}`
- `engine/src/bootstrap/opencode-server.test.ts` — smoke test
- Documented patch provenance in `patches/README.md`

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

### Step 4 — Reproduce #5894 (subagent hook bypass) before patching
Write a throwaway script in `engine/scratch/repro-5894.ts` that spawns the server, registers a `PreToolUse` hook that writes to `/tmp/hook-hit.log`, and dispatches a Task tool call. Run it. Expected pre-patch: no log entry written when the tool fires inside the subagent.

### Step 5 — Author the patch
Locate the upstream fix (PR linked in issue #5894). Apply the diff to `node_modules/opencode-ai/...` manually. Typically the bug lives in `dist/agent/subagent.js` where hook dispatch is not invoked for nested tool calls. Replace the direct tool invocation with the hook-dispatching wrapper.

Then generate the patch:
```bash
npx patch-package opencode-ai
```
Expected output: `Created file patches/opencode-ai+<version>.patch`.

### Step 6 — Verify postinstall reapplies
```bash
rm -rf node_modules engine/node_modules
pnpm install
```
Expected: `patch-package` log line `opencode-ai@<version> ✔`.

### Step 7 — Re-run repro → expect fix
Re-run `repro-5894.ts`. Expected: `/tmp/hook-hit.log` contains the `PreToolUse` entry.

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
Document: OpenCode version, CVE-22812 notes, issue #5894 link, patch summary, how to refresh when upstream rebases.

## Acceptance criteria

- [ ] `opencode-ai@>=1.4.4` installed and locked in `pnpm-lock.yaml`
- [ ] `patches/opencode-ai+<version>.patch` committed
- [ ] `pnpm install` after `rm -rf node_modules` reapplies the patch
- [ ] Smoke test passes
- [ ] Repro script shows hook fires inside subagent post-patch
- [ ] Server binds `127.0.0.1` only (not `0.0.0.0`)
- [ ] Unauthenticated requests return `401`

## Risks + mitigations

- **Upstream OpenCode refactor breaks our patch** → add a `CI` job that runs `pnpm install` on a matrix of `opencode-ai@latest` + pinned; alert on patch conflict.
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
- `patches/opencode-ai+<version>.patch`
- `patches/README.md`
- `engine/scratch/repro-5894.ts` (gitignored after verification)

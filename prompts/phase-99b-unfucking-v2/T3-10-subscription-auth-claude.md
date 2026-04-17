---
id: T3-10-subscription-auth-claude
tier: 3
title: "Add Claude Pro/Max subscription OAuth login for free worker runs"
scope:
  - "engine/src/cli/auth-cmd.ts"
  - "engine/src/cli/auth-cmd.test.ts"
  - "engine/src/cli/main.ts"
  - "engine/src/cli/credentials.ts"
  - "engine/src/cli/credentials.test.ts"
  - "engine/src/providers/subscription-auth.ts"
  - "engine/src/providers/subscription-auth.test.ts"
depends_on_fix: []
tests:
  - name: login-subscription-populates-creds
    kind: shell
    description: "running `jellyclaw auth login-subscription` with a stubbed claude binary writes a subscription field to credentials.json"
    command: "bun run test engine/src/cli/auth-cmd -t login-subscription-populates-creds"
    expect_exit: 0
    timeout_sec: 45
  - name: credentials-schema-accepts-subscription
    kind: shell
    description: "CredentialsSchema validates and round-trips a populated subscription field"
    command: "bun run test engine/src/cli/credentials -t subscription-round-trip"
    expect_exit: 0
    timeout_sec: 30
  - name: provider-prefers-subscription-when-worker
    kind: shell
    description: "provider picks subscription creds over API key when JELLYCLAW_ROLE=worker"
    command: "bun run test engine/src/providers/subscription-auth -t worker-prefers-subscription"
    expect_exit: 0
    timeout_sec: 30
human_gate: true
max_turns: 60
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 90
---

# T3-10 — Claude Pro/Max subscription login

## Context
The autobuild rig runs free under George's Claude Max subscription (per `AUTOBUILD-PHASES.md:112`). Testers run on the paid API (per the $10/session hard cap). Today jellyclaw has no mechanism to use subscription credentials — every run hits the API key and racks up cost. We need to port the subscription OAuth capture from the capital-J `Jelly-Claw` project so workers run free.

## Root cause (from audit)
- `engine/src/cli/credentials.ts:37-40` — `CredentialsSchema` accepts `anthropicApiKey` + `openaiApiKey` only. No `subscription` branch.
- Reference implementation: `/Users/gtrush/Downloads/Jelly-Claw/genie-server/src/core/dispatcher.mjs:164` logs `"Claude auth mode: subscription OAuth (from Jelly-Claw credentials file)"` and `:767-770` scrubs `ANTHROPIC_API_KEY` when subscription OAuth is present so it doesn't override a fresh login. This is the pattern to port.
- ANALYSIS.md in the capital-J project (`/Users/gtrush/Downloads/Jelly-Claw/ANALYSIS.md:99`) notes the correct CLI verb is `claude setup-token`, NOT `claude auth login` — do NOT copy the broken ghost-command from earlier ecosystem research.
- `engine/src/cli/main.ts:372` — the commander tree; we need a new `auth login-subscription` subcommand.

## Fix — exact change needed
1. **Widen credentials schema `engine/src/cli/credentials.ts:37-42`:**
   ```ts
   export const SubscriptionCredentialsSchema = z.object({
     kind: z.literal("oauth"),
     accessToken: z.string().min(10),
     refreshToken: z.string().min(10).optional(),
     expiresAt: z.number().int().nonnegative().optional(),  // unix ms
     obtainedAt: z.number().int().nonnegative(),
   });
   export const CredentialsSchema = z.object({
     anthropicApiKey: z.string().min(10).optional(),
     openaiApiKey: z.string().min(10).optional(),
     subscription: SubscriptionCredentialsSchema.optional(),
   });
   ```
2. **New module `engine/src/providers/subscription-auth.ts`** exposing:
   ```ts
   /** Run `claude setup-token`, capture tokens from its stdout / the Claude CLI credentials file. */
   export async function obtainSubscriptionCredentials(opts: {
     readonly claudeBinary?: string;  // default: "claude"
     readonly timeoutMs?: number;     // default: 120_000 (user needs time to log in)
     readonly stdio?: "inherit" | "pipe";  // default: "inherit" — interactive OAuth browser flow
     readonly signal?: AbortSignal;
   }): Promise<SubscriptionCredentials>;

   /** Select auth source for a given role. Never logs the token value. */
   export function selectAuth(
     creds: Credentials,
     role: "worker" | "tester" | "default",
   ): { kind: "subscription"; token: string } | { kind: "apiKey"; key: string } | null;
   ```
   - `obtainSubscriptionCredentials` spawns `claude setup-token` via `child_process.spawn(bin, ["setup-token"], { stdio: "inherit" })`. After it exits 0, read `~/.claude/.credentials.json` (the Claude CLI's auth file) — if it contains `{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }`, return that shape. If the file is missing or malformed, throw.
   - `selectAuth`: role `"worker"` → subscription if present, else error. Role `"tester"` → apiKey if present, else subscription. Role `"default"` → apiKey preferred, fall back to subscription.
3. **New subcommand `engine/src/cli/auth-cmd.ts`:**
   Register at `engine/src/cli/main.ts:372`. Shape:
   ```
   jellyclaw auth login-subscription   # runs `claude setup-token`, captures tokens, saves to credentials.json
   jellyclaw auth logout-subscription  # deletes the subscription field; leaves apiKey untouched
   jellyclaw auth status               # prints which auth modes are present (never prints tokens)
   ```
   Use commander subcommands. No shell interpolation.
4. **Role env var.** Read `process.env.JELLYCLAW_ROLE` — `worker` | `tester` | `default` (default: `default`). Plumb into provider construction. Workers refuse to start if no subscription creds exist (fail fast with an actionable message).
5. **Scrub API key when running as worker.** Mirror the Jelly-Claw dispatcher pattern: when `selectAuth` returns subscription creds, drop `ANTHROPIC_API_KEY` from the env passed to the provider adapter to avoid silent override.
6. **Tests:**
   - `engine/src/cli/credentials.test.ts` — `subscription-round-trip` asserts a populated object survives a write+read cycle.
   - `engine/src/cli/auth-cmd.test.ts` — `login-subscription-populates-creds` stubs the `claude` binary (put a script on PATH that writes a fake `~/.claude/.credentials.json` with a known payload) and asserts `credentials.json` ends up with `subscription.accessToken === <fake>`.
   - `engine/src/providers/subscription-auth.test.ts` — `worker-prefers-subscription` exercises `selectAuth` with both creds present across all three roles.

## Acceptance criteria
- `jellyclaw auth login-subscription` succeeds end-to-end on a machine with Claude CLI installed (maps to `login-subscription-populates-creds`).
- Credentials schema round-trips (maps to `credentials-schema-accepts-subscription`).
- Role-based auth selection works (maps to `provider-prefers-subscription-when-worker`).
- Tokens are NEVER logged. Verify via grep on `engine/src/` — no `logger.info` / `console.log` references to `accessToken` / `refreshToken`.
- `bun run typecheck` + `bun run lint` clean.

## Why `human_gate: true`
Auth changes + shelling out to a third-party binary + new credential fields = review-worthy. George should sanity-check the `claude setup-token` command surface before we auto-commit, and confirm the field name `subscription` in the schema doesn't collide with future plans.

## Out of scope
- Do NOT implement OAuth token refresh logic — when `expiresAt` is past, re-prompt user to re-login. Refresh is a T4 prompt.
- Do NOT add a TUI modal for subscription login — CLI subcommand only.
- Do NOT change how the dispatcher in `.autobuild/` spawns workers — it already respects env vars; plumbing `JELLYCLAW_ROLE` into it is a dispatcher-side change, out of scope here.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/cli/auth-cmd
bun run test engine/src/cli/credentials
bun run test engine/src/providers/subscription-auth
grep -rn "accessToken\|refreshToken" engine/src | grep -v test | grep -v subscription-auth.ts
```

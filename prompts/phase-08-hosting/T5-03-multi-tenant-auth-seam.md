# Phase 08 Hosting — Prompt T5-03: Multi-tenant auth seam (AuthProvider + Principal)

**When to run:** Any time after T5-01. Independent of T5-02 / T5-04 / T5-05.
**Estimated duration:** 3–5 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

`docs/hosting/02-public-api-design.md` §10 lays out the single-interface introduction that unlocks multi-tenant hosted jellyclaw on Fly. Today `engine/src/server/auth.ts:36-72` is a constant-time compare: one `authToken` in, pass/fail out. That's the right posture for self-hosted single-user mode and it must be preserved verbatim. For the hosted path we need the same middleware to return a richer `Principal` (org, tier, scopes, optional BYOK key) so every route can make tenancy-aware decisions.

Agent 2's observation: the existing middleware is already an indirection layer. Converting it to a pluggable `AuthProvider` is ~600 LOC, zero breaking change, and does NOT land the full user / account / Stripe / magic-link stack. Those come later. **This prompt ships the INTERFACE** — `AuthProvider`, `Principal`, `BearerAuthProvider` (wraps today's compare), plus stub recognition of `x-api-key` and `x-anthropic-api-key` headers that return a placeholder Principal. No DB, no migrations, no billing. That's the whole discipline.

## Research task

1. Read `engine/src/server/auth.ts` in full. Lines 36-72 = middleware. Lines 80-91 = constant-time compare helper. Both stay callable; the compare moves INTO `BearerAuthProvider` behind the interface.
2. Read `engine/src/server/app.ts:86-88` — the one line where auth is wired: `app.use("*", createAuthMiddleware({ authToken: opts.config.authToken }))`. That's the seam point.
3. Read `engine/src/server/types.ts` — locate `AppVariables`. You add `principal: Principal` to it; also add optional `authProvider?: AuthProvider` to `ServerConfig` as a DI override seam.
4. Read `engine/src/server/auth.test.ts` — every existing case must still pass byte-equivalent.
5. Read `docs/hosting/02-public-api-design.md` §10.1–10.3 (lines 887-965) — the concrete LOC breakdown. This prompt implements steps 1–3 of §10.2 only. Steps 4–5 (session store with tenant scoping) are later phases.
6. Read `engine/src/server/routes/health.ts` — mounted BEFORE auth; don't accidentally start guarding it.
7. Grep `engine/src/server/routes/` for `c.get("authenticated")` — every route that uses this boolean should keep working (back-compat). `c.get("principal")` is the new richer hook.

## Implementation task

Scope: introduce `AuthProvider` + `Principal`; rewire middleware to call a provider; ship `BearerAuthProvider` as self-hosted default; stub-recognize `x-api-key` and `x-anthropic-api-key` headers. NO DB, NO Stripe, NO account system. Just the seam. ~600 LOC.

### Files to create / modify

- `engine/src/server/auth/provider.ts` — **new.** The `AuthProvider` interface (~15 LOC).
- `engine/src/server/auth/principal.ts` — **new.** `Principal` type + `selfHostedPrincipal()` helper (~60 LOC).
- `engine/src/server/auth/bearer-provider.ts` — **new.** Wraps today's `timingSafeEqual` compare (~45 LOC).
- `engine/src/server/auth/multi-tenant-provider.ts` — **new (stub).** Recognizes `x-api-key` + `x-anthropic-api-key`. `TODO(T5-future)` for DB lookup (~70 LOC).
- `engine/src/server/auth/composite-provider.ts` — **new.** Tries providers in order; first non-null wins (~15 LOC).
- `engine/src/server/auth.ts` — MODIFY. Keep `createAuthMiddleware` signature + `constantTimeTokenCompare` export. Rewrite body to call `provider.authenticate(req, ip)`, set `c.var.principal` AND `c.var.authenticated = true` (back-compat).
- `engine/src/server/app.ts` — MODIFY lines 86-88. Construct provider from config/env; pass into middleware.
- `engine/src/server/types.ts` — add `principal: Principal` to `AppVariables`; `authProvider?: AuthProvider` to `ServerConfig`.
- `engine/src/server/auth.test.ts` — MODIFY. Existing tests pass; add provider-null → 401, BYOK header → Principal, unknown API key → 401.
- `engine/src/server/auth/provider.test.ts` — **new.** Unit tests for each provider.
- `engine/src/server/auth/composite-provider.test.ts` — **new.**
- `COMPLETION-LOG.md` — append entry.

### `principal.ts` contract

```ts
export interface Principal {
  readonly kind: "bearer" | "api_key" | "jwt" | "anon";
  readonly accountId: string;
  readonly orgId: string;
  readonly tier: "anon" | "free" | "paid" | "byok";
  readonly scopes: readonly Scope[];
  readonly rateLimits: RateLimitSnapshot;
  readonly byok: { readonly anthropicApiKey: string } | null;
}

export type Scope = "threads:read" | "threads:write" | "mcp:write" | "billing:read" | "*";

export interface RateLimitSnapshot {
  readonly runsPerMin: number;
  readonly runsPerDay: number;
  readonly concurrentRuns: number;
  readonly usdPerDay: number | null; // null = unmetered
}

export function selfHostedPrincipal(): Principal {
  return {
    kind: "bearer", accountId: "self-hosted", orgId: "self-hosted",
    tier: "byok", scopes: ["*"],
    rateLimits: { runsPerMin: 300, runsPerDay: Number.POSITIVE_INFINITY, concurrentRuns: 20, usdPerDay: null },
    byok: null,
  };
}
```

### `provider.ts` contract

```ts
export interface AuthProvider {
  /** Return Principal on success, null on failure. Never throws for unauth — null is the signal. */
  authenticate(req: Request, ip: string): Promise<Principal | null>;
}
```

### `bearer-provider.ts` contract

Uses the exact `timingSafeEqual`-over-zero-padded-buffers pattern from today's `auth.ts:80-91`. The helper `constantTimeTokenCompare` can live here OR stay exported from `auth.ts` — pick one and commit. Returns `selfHostedPrincipal()` on match, `null` on mismatch. Throws in constructor only if `authToken` is empty.

### `multi-tenant-provider.ts` — STUB shape

```ts
// Recognize headers; return placeholder Principal; NO DB lookup.
// TODO(T5-future): replace body with argon2id verify against Postgres.

// x-anthropic-api-key: sk-ant-* → BYOK Principal (tier "byok", byok.anthropicApiKey populated)
// x-api-key: jk_live_* or jk_test_* → Free-tier Principal with stub accountId sha8(key)
// Authorization: Bearer jk_live_* — same as x-api-key
// else → null
```

Hash the key with `createHash("sha256")...slice(0,8)` to produce a stable `accountId: "stub:<hash>"`. Don't log the key. Don't persist it.

### `composite-provider.ts` contract

```ts
// Try each provider in order. First non-null wins. All null → null.
export function createCompositeAuthProvider(providers: readonly AuthProvider[]): AuthProvider;
```

### Middleware rewire — `auth.ts`

```ts
export interface AuthMiddlewareOptions {
  /** @deprecated Pass `provider` instead. Kept for one-release back-compat. */
  readonly authToken?: string;
  readonly provider?: AuthProvider;
}

// Derive provider: if options.provider → use it; else if options.authToken → build BearerAuthProvider.
// Throw at construct time if neither.
// In the middleware: extract IP (Fly-Client-IP, then X-Forwarded-For first hop, else "0.0.0.0");
//   OPTIONS → await next() and return;
//   provider.authenticate(c.req.raw, ip) → null → 401;
//   else → c.set("authenticated", true); c.set("principal", result); await next();
```

### `app.ts` wire-up (lines 86-88)

```ts
const provider = opts.config.authProvider
  ?? (process.env.JELLYCLAW_MODE === "managed"
    ? createCompositeAuthProvider([
        createMultiTenantAuthProviderStub(),
        createBearerAuthProvider({ authToken: opts.config.authToken }),
      ])
    : createBearerAuthProvider({ authToken: opts.config.authToken }));
app.use("*", createAuthMiddleware({ provider }));
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/server/auth.test.ts
bun run test engine/src/server/auth/
bun run test engine/src/server/
bun run lint
bun run build

# Self-hosted regression — existing bearer flow must pass byte-equivalent
PORT=48123 TOKEN="test-$RANDOM"
JELLYCLAW_MODE=self-hosted /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw serve \
  --host 127.0.0.1 --port "$PORT" --auth-token "$TOKEN" &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w "missing=%{http_code} " http://127.0.0.1:$PORT/v1/sessions                             # 401
curl -s -o /dev/null -w "wrong=%{http_code} "   -H "Authorization: Bearer wrong" http://127.0.0.1:$PORT/v1/sessions  # 401
curl -s -o /dev/null -w "right=%{http_code}\n"  -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/v1/sessions # 2xx (not 401)
kill $SERVER_PID

# Managed-mode BYOK smoke
JELLYCLAW_MODE=managed /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw serve \
  --host 127.0.0.1 --port "$PORT" --auth-token "$TOKEN" &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w "byok=%{http_code}\n" \
  -H "x-anthropic-api-key: sk-ant-fake-for-stub" http://127.0.0.1:$PORT/v1/sessions
# Expect: NOT 401 (stub accepts any sk-ant-* prefix; route may 400 for missing body — that's fine)
kill $SERVER_PID
```

### Expected output

- All existing `auth.test.ts` cases pass byte-equivalent.
- Self-hosted mode (default / `JELLYCLAW_MODE` unset / `=self-hosted`) behaves identically to today.
- Managed mode (`JELLYCLAW_MODE=managed`) accepts BYOK + stub API keys in addition to bearer.
- Every route handler can now read `c.get("principal")` for caller identity.
- `engine/src/cli/*` unchanged — CLI layer is unaffected.
- Zero DB, zero Stripe, zero magic-link. Interface only.

### Tests to add

- `provider.test.ts`: BearerAuth → valid token → self-hosted Principal; invalid → null.
- `provider.test.ts`: MultiTenant stub → `sk-ant-*` → Principal with `tier:"byok"` and `byok.anthropicApiKey`; `jk_live_*` → Principal with `tier:"free"`; anything else → null.
- `composite-provider.test.ts`: first non-null wins; all null → null; order is respected.
- `auth.test.ts` additions: provider-null → 401; middleware sets `c.var.principal`; legacy `authenticated:true` still set.

### Common pitfalls

- **Don't change self-hosted wire behavior.** The existing bearer tests are the contract. Run `auth.test.ts` first — if anything changed, the refactor is wrong.
- **Don't land the DB.** This is INTERFACE ONLY. Writing `CREATE TABLE` means you're doing the wrong prompt.
- **Don't touch routes.** Adding tenancy enforcement ("session belongs to `principal.accountId`") is a LATER prompt. Scope discipline is the whole point.
- **Constant-time compare stays.** `BearerAuthProvider`'s timing-safe compare is load-bearing per `engine/CVE-MITIGATION.md`. Don't refactor into a shared util that might short-circuit on length.
- **IP extraction — Fly first.** `Fly-Client-IP` header is authoritative on Fly. Fallback: first element of `X-Forwarded-For`. Never trust `c.req.raw.socket.remoteAddress` — it's the proxy.
- **`ServerConfig.authProvider` is test-only.** DI seam for unit tests; the CLI is the only blessed production caller and it passes an explicit provider.
- **Scopes `"*"` wildcard.** Self-hosted Principal holds `["*"]`. Later RBAC checks should special-case it. Don't design the scope check here.
- **BYOK key is on the Principal, not stored.** Provider attaches `byok.anthropicApiKey` for the request lifetime. Never persist. Never log.
- **`c.req.raw` is the Fetch-API Request.** `provider.authenticate(req, ip)` receives that. Test fixtures build a `new Request(...)` — easy to mock.
- **OPTIONS preflight bypass.** Preserve the existing `if (method === "OPTIONS") next(); return;` short-circuit — CORS middleware terminates preflight before auth; this is defense-in-depth.

## Closeout

1. Update `COMPLETION-LOG.md` with `08.T5-03 ✅` — file counts, test count, regression note.
2. Print `DONE: T5-03`.

On fatal failure: `FAIL: T5-03 <reason>`.

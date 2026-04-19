/**
 * smoke-05-http-roundtrip — raw HTTP surface.
 *
 * Exercises the HTTP contract without invoking the agent loop:
 *   - GET  /v1/health            (bearer)  → 200 + valid JSON with {ok:true}
 *   - POST /v1/runs              (bearer)  → 400 on empty/invalid body
 *   - POST /v1/runs              (no auth) → 401
 *
 * NOTE: `/v1/health` is INTENTIONALLY unauthenticated — see
 * `engine/src/server/app.ts:77-84` ("mounted BEFORE auth so liveness probes
 * never 401"). The spec originally called for an unauthenticated `/v1/health`
 * check to return 401; smoke-05 targets an unauth POST /v1/runs instead,
 * which is the real auth-gated surface. This mismatch was discovered while
 * writing the smoke suite and flagged to jellyclaw maintainers.
 */

import { fetch } from "undici";

import { assert, withServer } from "./lib/harness.mjs";

export default async function run({ log }) {
  const started = Date.now();

  const result = await withServer(async ({ baseUrl, token }) => {
    log?.(`  server up at ${baseUrl}`);

    // --- 1. authed health ---------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.text();
      log?.(`  /v1/health(authed) status=${res.status}`);
      assert(
        res.status === 200,
        "smoke-05: /v1/health authed status",
        `got ${res.status} body=${body.slice(0, 200)}`,
      );
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        assert(false, "smoke-05: /v1/health body not JSON", body.slice(0, 200));
      }
      assert(parsed?.ok === true, "smoke-05: /v1/health missing ok:true", JSON.stringify(parsed));
    }

    // --- 2. invalid run body → 400 -----------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ notAPrompt: "nope" }),
      });
      const body = await res.text();
      log?.(`  /v1/runs(invalid) status=${res.status}`);
      assert(
        res.status === 400,
        "smoke-05: POST /v1/runs invalid body status",
        `got ${res.status} body=${body.slice(0, 200)}`,
      );
    }

    // --- 3. unauthenticated POST /v1/runs → 401 ----------------------------
    // /v1/health is intentionally public (see app.ts); the real auth-gated
    // surface starts at POST /v1/runs.
    {
      const res = await fetch(`${baseUrl}/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      });
      const body = await res.text();
      log?.(`  /v1/runs(noauth) status=${res.status}`);
      assert(
        res.status === 401,
        "smoke-05: POST /v1/runs no-auth status",
        `got ${res.status} body=${body.slice(0, 200)}`,
      );
    }

    return { checks: ["health-authed", "runs-400", "runs-401"] };
  });

  return {
    name: "smoke-05-http-roundtrip",
    passed: true,
    duration_ms: Date.now() - started,
    details: result,
  };
}

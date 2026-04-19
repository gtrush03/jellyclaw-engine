/**
 * Phase 10.02 — Hono app factory + `@hono/node-server` binding.
 *
 * Middleware order (critical):
 *   1. request-id     — sets `c.var.requestId` so every log line + error
 *                       response can be correlated.
 *   2. CORS           — terminates preflight (OPTIONS) BEFORE auth so
 *                       browsers aren't 401'd on preflight.
 *   3. auth           — mandatory bearer; 401 on anything else.
 *   4. routes         — mounted under `/v1`.
 *
 * Bind safety: `createServer` refuses any host that is not `127.0.0.1` or
 * `::1`. The `jellyclaw serve` CLI (Agent B) is the only caller permitted to
 * override via `--i-know-what-im-doing`, and that override does not flow
 * through this file — it is expressed by the CLI passing a different host
 * after it has printed its warning banner. This module always treats
 * non-loopback as an error.
 */

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { Logger } from "pino";

import { createAuthMiddleware } from "./auth.js";
import {
  createBearerAuthProvider,
  createCompositeAuthProvider,
  createMultiTenantAuthProviderStub,
} from "./auth/index.js";
import { createCorsMiddleware } from "./cors.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerPermissionRoutes } from "./routes/permissions.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { createSessionManager, type SessionManager } from "./session-manager.js";
import type { AppVariables, RunManager, ServerConfig } from "./types.js";
import { BindSafetyError } from "./types.js";

export interface CreateAppOptions {
  readonly config: ServerConfig;
  readonly runManager: RunManager;
  readonly logger: Logger;
  readonly configSnapshot: Record<string, unknown>;
  readonly version: string;
  readonly startedAt?: number;
  /**
   * Optional pre-built {@link SessionManager}. Injected by tests; in normal
   * operation the factory constructs one from `runManager` + `logger`.
   */
  readonly sessionManager?: SessionManager;
}

/**
 * Build the Hono app.
 *
 * Routes under `/v1/runs/*` are attached by
 * `engine/src/cli/serve.ts#productionDeps` after `createApp()` returns —
 * they need RunManager DI and `sessionPaths`, so mounting happens at the
 * caller layer. Tests can build a bare app without runs routes.
 */
export function createApp(opts: CreateAppOptions): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const startedAt = opts.startedAt ?? Date.now();

  // 1. request-id
  app.use("*", async (c, next) => {
    const rid = c.req.header("X-Request-Id") ?? randomUUID();
    c.set("requestId", rid);
    c.header("X-Request-Id", rid);
    await next();
  });

  // 2. CORS (empties preflight before auth sees it)
  app.use("*", createCorsMiddleware(opts.config.corsOrigins));

  // 3. health — mounted BEFORE auth so liveness probes (embedded-server
  //    spawn, load balancers, oncall scripts) never 401. Status-only,
  //    exposes no secrets.
  registerHealthRoutes(app, {
    version: opts.version,
    runManager: opts.runManager,
    startedAt,
  });

  // 4. auth — mandatory bearer for everything below
  // Provider construction: DI override → managed mode composite → self-hosted bearer
  const provider =
    opts.config.authProvider ??
    (process.env.JELLYCLAW_MODE === "managed"
      ? createCompositeAuthProvider([
          createMultiTenantAuthProviderStub(),
          createBearerAuthProvider({ authToken: opts.config.authToken }),
        ])
      : createBearerAuthProvider({ authToken: opts.config.authToken }));
  app.use("*", createAuthMiddleware({ provider }));

  // 5. routes
  const sessionManager =
    opts.sessionManager ??
    createSessionManager({ runManager: opts.runManager, logger: opts.logger });

  registerConfigRoutes(app, { configSnapshot: opts.configSnapshot });
  registerSessionRoutes(app, {
    runManager: opts.runManager,
    sessionManager,
    logger: opts.logger,
  });
  registerMessageRoutes(app, {
    runManager: opts.runManager,
    sessionManager,
    logger: opts.logger,
  });
  registerPermissionRoutes(app, {
    sessionManager,
    logger: opts.logger,
  });
  registerEventRoutes(app, {
    sessionManager,
    logger: opts.logger,
  });

  app.onError((err, c) => {
    const rid = c.get("requestId");
    opts.logger.error({ err, requestId: rid }, "server: unhandled error");
    return c.json({ error: "internal_error", requestId: rid }, 500);
  });

  return app;
}

export interface CreateServerResult {
  readonly server: Server;
  /** Actual bound port (useful when `config.port === 0`). */
  readonly port: number;
}

/**
 * Bind the Hono app to a TCP socket via `@hono/node-server`.
 *
 * Enforces loopback-only bind. Non-loopback hostnames throw
 * {@link BindSafetyError}; the CLI layer is responsible for the operator
 * override policy (see patches/002-bind-localhost-only.design.md).
 */
export function createServer(opts: {
  config: ServerConfig;
  app: Hono<{ Variables: AppVariables }>;
  logger: Logger;
  /**
   * When true, skip the loopback check. The CLI layer sets this only after
   * the operator has passed `--i-know-what-im-doing` AND supplied an explicit
   * auth token. See `patches/002-bind-localhost-only.design.md`.
   */
  allowNonLoopback?: boolean;
}): Promise<CreateServerResult> {
  if (opts.allowNonLoopback !== true) {
    assertLoopback(opts.config.host);
  }

  return new Promise<CreateServerResult>((resolve, reject) => {
    try {
      const server = serve(
        {
          fetch: opts.app.fetch,
          hostname: opts.config.host,
          port: opts.config.port,
        },
        (info: AddressInfo) => {
          opts.logger.info(
            { host: opts.config.host, port: info.port },
            "jellyclaw: http server listening",
          );
          resolve({ server: server as unknown as Server, port: info.port });
        },
      );
      (server as unknown as Server).on("error", (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Throw {@link BindSafetyError} unless `host` is a loopback literal.
 *
 * Accepted: `127.0.0.1`, `::1`. No hostname resolution: this is a literal
 * allow-list. `localhost` is intentionally excluded — DNS could resolve it
 * to a non-loopback IP on a misconfigured host.
 */
export function assertLoopback(host: string): void {
  if (host === "127.0.0.1" || host === "::1") return;
  throw new BindSafetyError(
    `refusing to bind http server to non-loopback host "${host}". ` +
      `jellyclaw binds 127.0.0.1 by default; the CLI layer must opt in explicitly.`,
  );
}

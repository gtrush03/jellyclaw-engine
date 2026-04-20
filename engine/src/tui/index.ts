/**
 * Phase 99-06 — TUI module barrel + `launchTui()` entry point.
 *
 * Public surface:
 *   - `launchTui(opts)` — mounts the Ink `<App />`, optionally walking through
 *     the API-key prompt + spawning an embedded `jellyclaw serve` first.
 *   - re-exports of the typed jellyclaw HTTP client.
 *
 * The `tui` CLI command (`engine/src/cli/tui.ts`) is the only production
 * caller. Tests inject the credentials, spawn-server, and signal-registration
 * seams via `LaunchTuiOptions`.
 */

import React from "react";

import { loadCredentials, updateCredentials } from "../cli/credentials.js";
import {
  type EmbeddedServerHandle,
  spawnEmbeddedServer,
  waitForHealth,
} from "../cli/shared/spawn-server.js";
import { App, type AppProps } from "./app.js";
import { createClient } from "./client.js";
import { ApiKeyPrompt } from "./components/api-key-prompt.js";

// Re-exports — the only client surface consumers should touch.
export type {
  CreateClientOptions,
  CreateRunInput,
  HealthResponse,
  JellyclawClient,
  SessionMeta,
} from "./client.js";
export { createClient, JellyclawClientError } from "./client.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LaunchTuiCredentialsHooks {
  load: () => Promise<{ anthropicApiKey?: string }>;
  save: (key: string) => Promise<void>;
}

export type SpawnServerFn = typeof spawnEmbeddedServer;
export type WaitForHealthFn = typeof waitForHealth;

export interface LaunchTuiOptions {
  /** ATTACH mode: url of an already-running server. If set, skip spawn + creds. */
  readonly url?: string;
  /** Bearer token for attach mode. */
  readonly token?: string;
  readonly cwd?: string;
  /** Override credentials flow (tests). Default: loadCredentials/updateCredentials. */
  readonly credentials?: LaunchTuiCredentialsHooks;
  /** Override embedded server spawner (tests). */
  readonly spawnServer?: SpawnServerFn;
  /** Override health waiter (tests). */
  readonly waitForHealth?: WaitForHealthFn;
  /** Override signal registration (tests). */
  readonly onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => () => void;
  /** Session flags (from CLI). */
  readonly resumeSessionId?: string;
  readonly continueLast?: boolean;
  /**
   * Test-only: skip mounting Ink. Receives whatever element we'd render
   * (`<App />` or `<ApiKeyPrompt />`) and returns an unmount handle. When
   * omitted, Ink mounts for real.
   */
  readonly renderImpl?: (element: React.ReactElement) => { unmount: () => void };
}

export interface LaunchTuiHandle {
  readonly cwd: string;
  readonly onExit: Promise<number>;
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIGINT_EXIT = 130;
const SIGTERM_EXIT = 143;
const CLEAN_EXIT = 0;

const defaultCredentials: LaunchTuiCredentialsHooks = {
  load: async () => {
    const c = await loadCredentials();
    const out: { anthropicApiKey?: string } = {};
    if (typeof c.anthropicApiKey === "string") out.anthropicApiKey = c.anthropicApiKey;
    return out;
  },
  save: async (key) => {
    await updateCredentials({ anthropicApiKey: key });
  },
};

function defaultOnSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void {
  process.on(signal, handler);
  return (): void => {
    process.off(signal, handler);
  };
}

// ---------------------------------------------------------------------------
// launchTui
// ---------------------------------------------------------------------------

export async function launchTui(opts: LaunchTuiOptions): Promise<LaunchTuiHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const onSignal = opts.onSignal ?? defaultOnSignal;

  // Single shared exit promise — settled exactly once.
  let exitResolve!: (code: number) => void;
  const onExit = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });

  let settled = false;
  const settle = (code: number): void => {
    if (settled) return;
    settled = true;
    exitResolve(code);
  };

  // Track teardown handles so dispose() can fan them all out idempotently.
  let activeUnmount: (() => void) | null = null;
  let serverHandle: EmbeddedServerHandle | null = null;
  let signalHandlersOff: Array<() => void> = [];

  const offAllSignals = (): void => {
    for (const off of signalHandlersOff) {
      try {
        off();
      } catch {
        /* best-effort */
      }
    }
    signalHandlersOff = [];
  };

  const installSignals = (): void => {
    signalHandlersOff.push(
      onSignal("SIGINT", () => settle(SIGINT_EXIT)),
      onSignal("SIGTERM", () => settle(SIGTERM_EXIT)),
    );
  };

  // ---- Attach mode -----------------------------------------------------------
  if (typeof opts.url === "string" && opts.url.length > 0) {
    const client = createClient({ baseUrl: opts.url, token: opts.token ?? "" });
    installSignals();
    activeUnmount = mountApp(
      {
        client,
        cwd,
        onExit: settle,
        ...(typeof opts.resumeSessionId === "string" && opts.resumeSessionId.length > 0
          ? { resumeSessionId: opts.resumeSessionId }
          : {}),
        ...(opts.continueLast === true ? { continueLast: true } : {}),
      },
      opts.renderImpl,
    );

    return makeHandle({
      cwd,
      onExit,
      dispose: async () => {
        if (activeUnmount !== null) {
          try {
            activeUnmount();
          } catch {
            /* already torn down */
          }
          activeUnmount = null;
        }
        offAllSignals();
        settle(CLEAN_EXIT);
      },
    });
  }

  // ---- Spawn mode ------------------------------------------------------------
  const credsHooks = opts.credentials ?? defaultCredentials;
  const spawn = opts.spawnServer ?? spawnEmbeddedServer;
  const wait = opts.waitForHealth ?? waitForHealth;
  installSignals();

  const launchAfterKey = async (apiKey: string): Promise<void> => {
    process.env.ANTHROPIC_API_KEY = apiKey;
    serverHandle = await spawn({ cwd });
    await wait(serverHandle.baseUrl, serverHandle.token);
    const client = createClient({
      baseUrl: serverHandle.baseUrl,
      token: serverHandle.token,
    });
    activeUnmount = mountApp(
      {
        client,
        cwd,
        onExit: settle,
        ...(typeof opts.resumeSessionId === "string" && opts.resumeSessionId.length > 0
          ? { resumeSessionId: opts.resumeSessionId }
          : {}),
        ...(opts.continueLast === true ? { continueLast: true } : {}),
      },
      opts.renderImpl,
    );
  };

  const creds = await credsHooks.load();
  // Env-var fallback · ANTHROPIC_API_KEY is the canonical way the engine
  // is configured in Fly/Docker/CI. Before prompting, accept it as if it
  // came from ~/.jellyclaw/credentials.json.
  const envKey = process.env.ANTHROPIC_API_KEY;
  const effectiveKey =
    typeof creds.anthropicApiKey === "string" && creds.anthropicApiKey.length > 0
      ? creds.anthropicApiKey
      : typeof envKey === "string" && envKey.length > 0
        ? envKey
        : null;
  if (effectiveKey !== null) {
    try {
      await launchAfterKey(effectiveKey);
    } catch (err) {
      offAllSignals();
      throw err;
    }
  } else {
    // Mount the API-key prompt first; on accept, transition.
    activeUnmount = mountElement(
      React.createElement(ApiKeyPrompt, {
        onAccepted: (key) => {
          // Tear down the prompt, then mount the chat UI.
          if (activeUnmount !== null) {
            try {
              activeUnmount();
            } catch {
              /* ignore */
            }
            activeUnmount = null;
          }
          void (async (): Promise<void> => {
            try {
              await credsHooks.save(key);
              await launchAfterKey(key);
            } catch (err) {
              // Surface the failure to stderr so the operator sees why the
              // TUI bailed instead of a blank "exit 1".
              try {
                process.stderr.write(
                  `jellyclaw tui: failed to launch after accepting key: ${String(
                    (err as Error)?.message ?? err,
                  )}\n`,
                );
              } catch {
                /* best-effort */
              }
              settle(1);
            }
          })();
        },
        onCancelled: () => {
          if (activeUnmount !== null) {
            try {
              activeUnmount();
            } catch {
              /* ignore */
            }
            activeUnmount = null;
          }
          settle(SIGINT_EXIT);
        },
        saveImpl: credsHooks.save,
      }),
      opts.renderImpl,
    );
  }

  return makeHandle({
    cwd,
    onExit,
    dispose: async () => {
      if (activeUnmount !== null) {
        try {
          activeUnmount();
        } catch {
          /* already torn down */
        }
        activeUnmount = null;
      }
      if (serverHandle !== null) {
        try {
          await serverHandle.stop();
        } catch {
          /* swallow */
        }
        serverHandle = null;
      }
      offAllSignals();
      settle(CLEAN_EXIT);
    },
  });
}

// ---------------------------------------------------------------------------
// Mount helpers
// ---------------------------------------------------------------------------

function mountApp(props: AppProps, renderImpl: LaunchTuiOptions["renderImpl"]): () => void {
  return mountElement(React.createElement(App, props), renderImpl);
}

function mountElement(
  element: React.ReactElement,
  renderImpl: LaunchTuiOptions["renderImpl"],
): () => void {
  if (renderImpl !== undefined) {
    const handle = renderImpl(element);
    return (): void => {
      handle.unmount();
    };
  }
  // Synchronous-style mount that lazy-imports Ink. Ink's `render` itself is
  // synchronous once the module is loaded.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // We use a top-level dynamic import resolved lazily; consumers under test
  // should pass `renderImpl` to bypass this path entirely.
  let unmounted = false;
  let realUnmount: (() => void) | null = null;
  void (async (): Promise<void> => {
    const ink = await import("ink");
    if (unmounted) return;
    const instance = ink.render(element);
    realUnmount = (): void => {
      try {
        instance.unmount();
      } catch {
        /* already gone */
      }
    };
  })();
  return (): void => {
    unmounted = true;
    if (realUnmount !== null) realUnmount();
  };
}

function makeHandle(args: {
  cwd: string;
  onExit: Promise<number>;
  dispose: () => Promise<void>;
}): LaunchTuiHandle {
  let disposed = false;
  return {
    cwd: args.cwd,
    onExit: args.onExit,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await args.dispose();
    },
  };
}

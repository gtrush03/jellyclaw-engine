/**
 * Phase 99-06 — Ink `<App />` root.
 *
 * Owns the reducer that turns SSE `AgentEvent`s into `UiState`, dispatches the
 * input/permission/cancel UI affordances against an injected `JellyclawClient`,
 * and renders the StatusBar / Transcript / PermissionModal / InputBox stack
 * laid out top-to-bottom.
 *
 * Keep this module thin: business logic lives in `state/reducer.ts` and the
 * component leaves on `components/*`. The integrator wires lifecycle here.
 */

import { Box, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { AgentEvent } from "../events.js";
import type { JellyclawClient } from "./client.js";
import { InputBox } from "./components/input-box.js";
import { PermissionModal } from "./components/permission-modal.js";
import { Splash } from "./components/splash.js";
import { StatusBar } from "./components/status-bar.js";
import { Transcript } from "./components/transcript.js";
import { useEvents } from "./hooks/use-events.js";
import { useReducedMotion } from "./hooks/use-reduced-motion.js";
import {
  type CommandContext,
  executeCommand,
  parseSlash,
  type UiCommandAction,
} from "./commands/dispatch.js";
import { reduce } from "./state/reducer.js";
import { createInitialState, type UiAction, type UiState } from "./state/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AppProps {
  readonly client: JellyclawClient;
  readonly cwd: string;
  /** If set, resume from this session on mount. */
  readonly resumeSessionId?: string;
  /** If true, fetch last session id from ~/.jellyclaw/state.json and resume. */
  readonly continueLast?: boolean;
  /** Called when user requests exit (e.g. Ctrl-C twice). Integrator unmounts. */
  readonly onExit: (code: number) => void;
  /**
   * Test-only: seed the reducer with a non-default state so snapshot tests can
   * capture mid-session frames without having to drive a fake SSE stream. Not
   * exercised in production code paths.
   */
  readonly initialState?: UiState;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SECOND_CTRL_C_WINDOW_MS = 2_000;
const TRANSCRIPT_FALLBACK_ROWS = 24;

export function App(props: AppProps): JSX.Element {
  const { client, cwd, onExit, initialState, resumeSessionId, continueLast } = props;
  const reducedMotion = useReducedMotion();
  const { stdout } = useStdout();
  const inkApp = useApp();

  const [state, dispatch] = useReducer(reduce, initialState ?? createInitialState({ cwd }));
  const [draft, setDraft] = useState("");
  const [confirmExitMsg, setConfirmExitMsg] = useState<string | null>(null);
  const confirmExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitArmed = useRef(false);
  const lastRunIdRef = useRef<string | null>(null);

  // Keep a ref to the latest runId so signal handlers can address it without
  // triggering a re-subscribe in `useEvents`.
  useEffect(() => {
    lastRunIdRef.current = state.runId;
  }, [state.runId]);

  // ---- SSE pump --------------------------------------------------------------
  const handleEvent = useCallback((ev: AgentEvent): void => {
    dispatch(ev);
  }, []);
  const handleError = useCallback((_err: unknown): void => {
    // Fold transient stream failures into a system error item — the reducer
    // does not see a synthesised AgentEvent here because `session.error` shapes
    // are server-issued. Surface a UI-only error item instead.
    dispatch({ kind: "clear-error" });
  }, []);
  useEvents({ client, runId: state.runId, onEvent: handleEvent, onError: handleError });

  // ---- Resume / continue (best-effort, fire-and-forget) ----------------------
  useEffect(() => {
    let cancelled = false;
    const resume = async (sessionId: string): Promise<void> => {
      try {
        for await (const ev of client.resumeSession(sessionId)) {
          if (cancelled) break;
          dispatch(ev);
        }
      } catch {
        // Ignore — replay failures fall back to a fresh session on first prompt.
      }
    };

    if (typeof resumeSessionId === "string" && resumeSessionId.length > 0) {
      void resume(resumeSessionId);
    } else if (continueLast === true) {
      void (async (): Promise<void> => {
        const id = await readLastSessionId();
        if (id !== null && !cancelled) await resume(id);
      })();
    }
    return (): void => {
      cancelled = true;
    };
    // We intentionally only run this on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Submit handler --------------------------------------------------------
  const onSubmit = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      setDraft("");

      // Slash-command short-circuit: parse + execute locally, never hit the
      // model. The parser returns null for non-slash input and for bare `/`.
      const parsed = parseSlash(trimmed);
      if (parsed !== null) {
        const pushSystem = (body: string): void => {
          dispatch({
            kind: "system-message",
            id: `sys-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            text: body,
          });
        };
        // Echo the user's command line so it appears in the transcript like a
        // normal prompt would — helpful scrollback context.
        const echoId = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        dispatch({ kind: "user-prompt", text: trimmed, id: echoId });

        const ctx: CommandContext = {
          client,
          cwd,
          sessionId: state.sessionId,
          runId: state.runId,
          currentModel: state.currentModel,
          usage: state.usage,
          pushSystem,
          exit: (code) => {
            try {
              inkApp.exit();
            } catch {
              /* already unmounted */
            }
            onExit(code);
          },
          dispatchAction: (a: UiCommandAction) => {
            // Map the commands-module action enum onto the reducer's UiAction
            // enum. They are intentionally decoupled so the commands package
            // has no compile-time dep on the reducer shape.
            const mapped: UiAction = a;
            dispatch(mapped);
          },
          dispatchEvent: (ev) => dispatch(ev),
        };
        void executeCommand(parsed, ctx);
        return;
      }

      const localId = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      dispatch({ kind: "user-prompt", text: trimmed, id: localId });
      void (async (): Promise<void> => {
        try {
          const input: {
            prompt: string;
            cwd?: string;
            sessionId?: string;
            model?: string;
          } = {
            prompt: trimmed,
            cwd,
          };
          if (state.sessionId !== null) input.sessionId = state.sessionId;
          if (state.currentModel.length > 0) input.model = state.currentModel;
          const { runId, sessionId } = await client.createRun(input);
          dispatch({ kind: "run-started", runId, sessionId });
        } catch {
          // Surface a UI-only error item by clearing then leaving the user to retry.
          dispatch({ kind: "clear-error" });
        }
      })();
    },
    [
      client,
      cwd,
      state.sessionId,
      state.runId,
      state.currentModel,
      state.usage,
      inkApp,
      onExit,
    ],
  );

  // ---- Permission resolve ----------------------------------------------------
  const onResolvePermission = useCallback(
    (granted: boolean): void => {
      const pending = state.pendingPermission;
      if (pending === null) return;
      void client.resolvePermission(pending.requestId, granted).catch(() => {
        // Server may already have resolved (e.g. timeout). Swallow — the SSE
        // stream remains the source of truth via permission.granted/denied.
      });
    },
    [client, state.pendingPermission],
  );

  // ---- Ctrl-C / quit handling ------------------------------------------------
  const armExitConfirm = useCallback((): void => {
    exitArmed.current = true;
    setConfirmExitMsg("press Ctrl-C again to quit");
    if (confirmExitTimer.current !== null) clearTimeout(confirmExitTimer.current);
    confirmExitTimer.current = setTimeout(() => {
      exitArmed.current = false;
      setConfirmExitMsg(null);
      confirmExitTimer.current = null;
    }, SECOND_CTRL_C_WINDOW_MS);
  }, []);

  useEffect(() => {
    return (): void => {
      if (confirmExitTimer.current !== null) {
        clearTimeout(confirmExitTimer.current);
        confirmExitTimer.current = null;
      }
    };
  }, []);

  useInput((_input, key) => {
    // Ctrl-C — Ink reports it as `key.ctrl` + `input === 'c'`.
    if (key.ctrl && _input === "c") {
      if (exitArmed.current) {
        if (confirmExitTimer.current !== null) {
          clearTimeout(confirmExitTimer.current);
          confirmExitTimer.current = null;
        }
        try {
          inkApp.exit();
        } catch {
          /* unmounted already */
        }
        onExit(130);
        return;
      }
      const runId = lastRunIdRef.current;
      if (runId !== null) {
        void client.cancel(runId).catch(() => undefined);
        dispatch({ kind: "run-cancelled" });
      }
      armExitConfirm();
    }
  });

  // ---- Layout ----------------------------------------------------------------
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? TRANSCRIPT_FALLBACK_ROWS;
  // Reserve ~3 rows for status bar + input box.
  const transcriptRows = Math.max(1, rows - 5);
  void cols;

  const inputDisabled = state.status === "streaming" || state.status === "awaiting-permission";
  const placeholder =
    state.runId === null && state.items.length === 0 ? "type a prompt to start" : "send a message";

  return (
    <Box flexDirection="column">
      <StatusBar
        sessionId={state.sessionId}
        model={state.model}
        usage={state.usage}
        status={state.status}
        tick={state.tick}
        reducedMotion={reducedMotion}
      />
      {/* Splash stays pinned at top for the duration of the session — new
          content scrolls below it, it never unmounts. */}
      <Splash cwd={cwd} model={state.model} sessionId={state.sessionId} />
      <Box flexDirection="column" flexGrow={1}>
        {state.items.length > 0 || state.runId !== null ? (
          <Transcript items={state.items} rows={transcriptRows} sessionId={state.sessionId} />
        ) : null}
      </Box>
      {state.pendingPermission !== null ? (
        <PermissionModal permission={state.pendingPermission} onResolve={onResolvePermission} />
      ) : null}
      <InputBox
        value={draft}
        onChange={setDraft}
        onSubmit={onSubmit}
        disabled={inputDisabled}
        placeholder={confirmExitMsg ?? placeholder}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readLastSessionId(): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(homedir(), ".jellyclaw", "state.json");
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { lastSessionId?: unknown };
    if (typeof parsed.lastSessionId === "string" && parsed.lastSessionId.length > 0) {
      return parsed.lastSessionId;
    }
    return null;
  } catch {
    return null;
  }
}

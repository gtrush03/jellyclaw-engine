/**
 * Phase 99-06 — `<App />` snapshot suite.
 *
 * Mounts the component via `ink-testing-library` against a stub
 * `JellyclawClient` and seeds the reducer through the test-only
 * `initialState` prop so each frame captures a deterministic UI snapshot.
 *
 * Snapshots are pinned to 80-column terminals; ink-testing-library defaults to
 * 100 columns but we never override stdout dimensions in the renderer because
 * the components' layout is responsive and our snapshots only assert the
 * stable substrings (status bar tokens, transcript glyphs) — not pixel-precise
 * column positions.
 */

import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../src/events.js";
import { App } from "../../src/tui/app.js";
import type { JellyclawClient } from "../../src/tui/client.js";
import {
  createInitialState,
  type ToolCallMessage,
  type UiState,
} from "../../src/tui/state/types.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<JellyclawClient> = {}): JellyclawClient {
  const empty: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: async function* () {
      // never yields
    },
  };
  const noop = async (): Promise<void> => undefined;
  return {
    health: async () => ({ ok: true, version: "0.0.0" }),
    createRun: async () => ({ runId: "run-test", sessionId: "sess-test" }),
    events: () => empty,
    cancel: noop,
    resolvePermission: noop,
    listSessions: async () => [],
    resumeSession: () => empty,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  delete process.env.JELLYCLAW_REDUCED_MOTION;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe("App snapshots", () => {
  it("welcome (idle, empty transcript)", async () => {
    const { lastFrame, unmount } = render(
      <App
        client={makeClient()}
        cwd="/tmp"
        onExit={() => undefined}
        initialState={createInitialState({ cwd: "/tmp", model: "claude-sonnet-4" })}
      />,
    );
    await flush();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it("streaming assistant message mid-stream", async () => {
    const state: UiState = createInitialState({
      cwd: "/tmp",
      model: "claude-sonnet-4",
      sessionId: "sess-abc",
      runId: "run-1",
      status: "streaming",
      items: [
        {
          kind: "text",
          id: "user-1",
          role: "user",
          text: "say pong",
          done: true,
        },
        {
          kind: "text",
          id: "assistant-1",
          role: "assistant",
          text: "po",
          done: false,
        },
      ],
    });
    const { lastFrame, unmount } = render(
      <App client={makeClient()} cwd="/tmp" onExit={() => undefined} initialState={state} />,
    );
    await flush();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it("completed tool-call card (bash → 3 files)", async () => {
    const tool: ToolCallMessage = {
      kind: "tool",
      id: "tool-1",
      toolId: "tool-1",
      toolName: "bash",
      input: { command: "ls /tmp" },
      output: "a.txt\nb.txt\nc.txt",
      durationMs: 12,
      status: "ok",
    };
    const state = createInitialState({
      cwd: "/tmp",
      model: "claude-sonnet-4",
      sessionId: "sess-abc",
      items: [tool],
    });
    const { lastFrame, unmount } = render(
      <App client={makeClient()} cwd="/tmp" onExit={() => undefined} initialState={state} />,
    );
    await flush();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it("pending tool-call card", async () => {
    const tool: ToolCallMessage = {
      kind: "tool",
      id: "tool-2",
      toolId: "tool-2",
      toolName: "read",
      input: { path: "/tmp/foo.txt" },
      status: "pending",
    };
    const state = createInitialState({
      cwd: "/tmp",
      model: "claude-sonnet-4",
      sessionId: "sess-abc",
      items: [tool],
      status: "streaming",
    });
    const { lastFrame, unmount } = render(
      <App client={makeClient()} cwd="/tmp" onExit={() => undefined} initialState={state} />,
    );
    await flush();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it("errored tool-call card", async () => {
    const tool: ToolCallMessage = {
      kind: "tool",
      id: "tool-3",
      toolId: "tool-3",
      toolName: "bash",
      input: { command: "false" },
      errorCode: "EXIT_NONZERO",
      errorMessage: "command failed (exit 1)",
      durationMs: 8,
      status: "error",
    };
    const state = createInitialState({
      cwd: "/tmp",
      model: "claude-sonnet-4",
      sessionId: "sess-abc",
      items: [tool],
    });
    const { lastFrame, unmount } = render(
      <App client={makeClient()} cwd="/tmp" onExit={() => undefined} initialState={state} />,
    );
    await flush();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it("permission modal overlay", async () => {
    const state = createInitialState({
      cwd: "/tmp",
      model: "claude-sonnet-4",
      sessionId: "sess-abc",
      pendingPermission: {
        requestId: "req-1",
        toolName: "bash",
        reason: "execute shell command",
        inputPreview: { command: "rm -rf /tmp/scratch" },
      },
      status: "awaiting-permission",
    });
    const { lastFrame, unmount } = render(
      <App client={makeClient()} cwd="/tmp" onExit={() => undefined} initialState={state} />,
    );
    await flush();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it("reduced-motion: spinner shows static frame", async () => {
    process.env.JELLYCLAW_REDUCED_MOTION = "1";
    const state = createInitialState({
      cwd: "/tmp",
      model: "claude-sonnet-4",
      sessionId: "sess-abc",
      status: "streaming",
    });
    const { lastFrame, unmount } = render(
      <App client={makeClient()} cwd="/tmp" onExit={() => undefined} initialState={state} />,
    );
    await flush();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });
});

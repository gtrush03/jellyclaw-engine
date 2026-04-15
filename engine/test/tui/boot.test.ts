/**
 * Phase 99-06 — `launchTui()` boot tests.
 *
 * Exercises the spawn-mode flow with stubbed credentials, server spawner, and
 * health waiter. Uses `renderImpl` to bypass real Ink mounting so the tests can
 * observe the mounted element type without spinning up a TTY.
 */

import type React from "react";
import { describe, expect, it, vi } from "vitest";

import { App } from "../../src/tui/app.js";
import { ApiKeyPrompt } from "../../src/tui/components/api-key-prompt.js";
import { launchTui } from "../../src/tui/index.js";

interface RenderHarness {
  impl: (el: React.ReactElement) => { unmount: () => void };
  records: Array<{ type: unknown; props: unknown }>;
  unmountCount: { value: number };
}

function makeRenderImpl(): RenderHarness {
  const records: Array<{ type: unknown; props: unknown }> = [];
  const unmountCount = { value: 0 };
  const impl = (el: React.ReactElement): { unmount: () => void } => {
    records.push({ type: el.type, props: el.props });
    return {
      unmount: () => {
        unmountCount.value += 1;
      },
    };
  };
  return { impl, records, unmountCount };
}

function fakeSpawn(): typeof import("../../src/cli/shared/spawn-server.js").spawnEmbeddedServer {
  return (async () => ({
    baseUrl: "http://127.0.0.1:51234",
    token: "tok",
    stop: async () => undefined,
  })) as never;
}

function fakeWait(): typeof import("../../src/cli/shared/spawn-server.js").waitForHealth {
  return (async () => undefined) as never;
}

describe("launchTui — spawn mode", () => {
  it("with creds present: skips ApiKeyPrompt and mounts <App /> directly", async () => {
    const r = makeRenderImpl();
    const handle = await launchTui({
      cwd: "/tmp/proj",
      credentials: {
        load: async () => ({ anthropicApiKey: "sk-test-existing-key-1234" }),
        save: async () => undefined,
      },
      spawnServer: fakeSpawn(),
      waitForHealth: fakeWait(),
      onSignal: () => () => undefined,
      renderImpl: r.impl,
    });

    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.type).toBe(App);
    expect(handle.cwd).toBe("/tmp/proj");

    await handle.dispose();
    expect(r.unmountCount.value).toBe(1);
    expect(await handle.onExit).toBe(0);
  });

  it("without creds + cancel: mounts ApiKeyPrompt and onExit resolves to 130", async () => {
    const r = makeRenderImpl();
    const handle = await launchTui({
      cwd: "/tmp/proj",
      credentials: {
        load: async () => ({}),
        save: async () => undefined,
      },
      spawnServer: fakeSpawn(),
      waitForHealth: fakeWait(),
      onSignal: () => () => undefined,
      renderImpl: r.impl,
    });

    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.type).toBe(ApiKeyPrompt);

    // Drive the prompt's onCancelled — the renderImpl captured the element's
    // props pre-mount, so we can invoke the wired callbacks directly.
    const props = r.records[0]?.props as { onCancelled?: () => void };
    props.onCancelled?.();
    expect(await handle.onExit).toBe(130);

    await handle.dispose();
  });

  it("dispose() unmounts cleanly with no orphan timers", async () => {
    vi.useFakeTimers();
    try {
      const r = makeRenderImpl();
      const handle = await launchTui({
        cwd: "/tmp/proj",
        credentials: {
          load: async () => ({ anthropicApiKey: "sk-test-existing-key-1234" }),
          save: async () => undefined,
        },
        spawnServer: fakeSpawn(),
        waitForHealth: fakeWait(),
        onSignal: () => () => undefined,
        renderImpl: r.impl,
      });
      await handle.dispose();
      // No pending timers from launchTui's own machinery (signal handlers are
      // unregistered via the onSignal seam, the prompt is unmounted, server
      // is stopped). Ink's own internals are not mounted (renderImpl bypassed).
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

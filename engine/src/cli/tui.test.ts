/**
 * Phase 10.5 Prompt 03 — `tuiAction` unit tests.
 *
 * All dependencies are injected via the `options` DI surface on `tuiAction`:
 * `launchTui`, `spawnEmbeddedServer`, `waitForHealth`, and `platform`. No real
 * subprocess, no real network, no real TTY.
 *
 * Coverage:
 *   1. attach path skips spawn.
 *   2. embedded path spawns → waits → launches → stops.
 *   3. SIGINT → 130.
 *   4. SIGTERM → 143.
 *   5. health timeout → 124.
 *   6. `--ascii` sets JELLYCLAW_BRAND_GLYPH.
 *   7. `--no-color` sets NO_COLOR.
 *   8. `--cwd` is forwarded to spawn + launchTui.
 *   9. Windows → exit 2.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddedServerHandle, SpawnEmbeddedServerOptions } from "./shared/spawn-server.js";
import { TuiHealthTimeoutError } from "./shared/spawn-server.js";
import type { LaunchTuiFn, SpawnEmbeddedServerFn, WaitForHealthFn } from "./tui.js";
import { flagsToEnvPatch, tuiAction } from "./tui.js";

interface Recorder {
  spawnCalls: SpawnEmbeddedServerOptions[];
  waitCalls: Array<{ baseUrl: string; timeoutMs?: number }>;
  launchCalls: Array<{
    url?: string;
    token?: string;
    cwd?: string;
    spawnForwarded?: boolean;
    waitForwarded?: boolean;
  }>;
  stops: number;
  disposes: number;
}

function makeRec(): Recorder {
  return { spawnCalls: [], waitCalls: [], launchCalls: [], stops: 0, disposes: 0 };
}

function makeSpawn(
  rec: Recorder,
  base = "http://127.0.0.1:51234",
  token = "srv-tok",
): SpawnEmbeddedServerFn {
  return async (opts) => {
    rec.spawnCalls.push(opts ?? {});
    const handle: EmbeddedServerHandle = {
      baseUrl: base,
      token,
      stop: async () => {
        rec.stops += 1;
      },
    };
    return handle;
  };
}

function makeWait(rec: Recorder): WaitForHealthFn {
  return async (baseUrl, timeoutMs) => {
    rec.waitCalls.push({ baseUrl, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  };
}

function makeWaitThrow(): WaitForHealthFn {
  return async () => {
    throw new TuiHealthTimeoutError("health never came up");
  };
}

function makeLaunch(rec: Recorder, onExit: Promise<number> | undefined): LaunchTuiFn {
  return async (opts) => {
    const entry: Recorder["launchCalls"][number] = {
      ...(opts.url !== undefined ? { url: opts.url } : {}),
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      spawnForwarded: opts.spawnServer !== undefined,
      waitForwarded: opts.waitForHealth !== undefined,
    };
    rec.launchCalls.push(entry);

    // Embedded-path simulation: if launchTui was handed a spawnServer +
    // waitForHealth, drive them so the rest of the test recording mirrors
    // the real launchTui's lifecycle.
    if (
      opts.spawnServer !== undefined &&
      opts.waitForHealth !== undefined &&
      opts.url === undefined
    ) {
      const handle = await opts.spawnServer({ cwd: opts.cwd ?? process.cwd() });
      await opts.waitForHealth(handle.baseUrl);
      const stopHandle = handle;
      return {
        dispose: async () => {
          rec.disposes += 1;
          await stopHandle.stop();
        },
        ...(onExit !== undefined ? { onExit } : {}),
      };
    }

    return {
      dispose: async () => {
        rec.disposes += 1;
      },
      ...(onExit !== undefined ? { onExit } : {}),
    };
  };
}

// Silent stderr stub.
function makeStderr(): NodeJS.WritableStream & { chunks: string[] } {
  const chunks: string[] = [];
  const stream = {
    chunks,
    write(chunk: string | Uint8Array): boolean {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  } as unknown as NodeJS.WritableStream & { chunks: string[] };
  return stream;
}

afterEach(() => {
  delete process.env.JELLYCLAW_TUI;
  delete process.env.JELLYCLAW_USER_CWD;
  delete process.env.NO_COLOR;
  delete process.env.JELLYCLAW_BRAND_GLYPH;
  delete process.env.JELLYCLAW_LOG_LEVEL;
  delete process.env.JELLYCLAW_MODEL;
  delete process.env.JELLYCLAW_PROVIDER;
  delete process.env.JELLYCLAW_RESUME_SESSION;
  delete process.env.JELLYCLAW_CONTINUE;
  delete process.env.JELLYCLAW_SERVER_URL;
  delete process.env.JELLYCLAW_SERVER_TOKEN;
  delete process.env.JELLYCLAW_TOKEN;
});

describe("flagsToEnvPatch", () => {
  it("maps all flags to env vars", () => {
    const patch = flagsToEnvPatch({
      color: false,
      ascii: true,
      verbose: true,
      model: "claude-opus-4",
      provider: "primary",
      resume: "sess-1",
      continue: true,
    });
    expect(patch).toEqual({
      NO_COLOR: "1",
      JELLYCLAW_BRAND_GLYPH: "ascii",
      JELLYCLAW_LOG_LEVEL: "debug",
      JELLYCLAW_MODEL: "claude-opus-4",
      JELLYCLAW_PROVIDER: "primary",
      JELLYCLAW_RESUME_SESSION: "sess-1",
      JELLYCLAW_CONTINUE: "1",
    });
  });

  it("omits undefined flags", () => {
    expect(flagsToEnvPatch({})).toEqual({});
    expect(flagsToEnvPatch(undefined)).toEqual({});
  });
});

describe("tuiAction — attach path", () => {
  beforeEach(() => {
    delete process.env.JELLYCLAW_SERVER_URL;
    delete process.env.JELLYCLAW_SERVER_TOKEN;
  });

  it("skips spawn and hands URL+token to launchTui", async () => {
    const rec = makeRec();
    const code = await tuiAction({
      args: ["attach", "http://10.0.0.5:1234"],
      flags: {},
      env: { JELLYCLAW_SERVER_TOKEN: "attach-tok" },
      platform: "linux",
      cwd: "/tmp/project",
      launchTui: makeLaunch(rec, Promise.resolve(0)),
      spawnEmbeddedServer: makeSpawn(rec),
      waitForHealth: makeWait(rec),
      stderr: makeStderr(),
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    expect(code).toBe(0);
    expect(rec.spawnCalls).toHaveLength(0);
    expect(rec.waitCalls).toHaveLength(0);
    expect(rec.launchCalls).toEqual([
      {
        url: "http://10.0.0.5:1234",
        token: "attach-tok",
        cwd: "/tmp/project",
        spawnForwarded: false,
        waitForwarded: false,
      },
    ]);
  });
});

describe("tuiAction — embedded path", () => {
  it("forwards spawn + wait seams to launchTui (which owns the lifecycle)", async () => {
    const rec = makeRec();
    const code = await tuiAction({
      args: ["tui"],
      flags: { cwd: "/tmp/project", verbose: true },
      platform: "linux",
      launchTui: makeLaunch(rec, Promise.resolve(0)),
      spawnEmbeddedServer: makeSpawn(rec, "http://127.0.0.1:40000", "boot-tok"),
      waitForHealth: makeWait(rec),
      stderr: makeStderr(),
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    expect(code).toBe(0);
    // Server lifecycle is now driven from inside the (test) launchTui that
    // received the seams; the simulation in `makeLaunch` calls them in turn.
    expect(rec.spawnCalls).toHaveLength(1);
    expect(rec.spawnCalls[0]?.cwd).toBe("/tmp/project");
    expect(rec.waitCalls).toEqual([{ baseUrl: "http://127.0.0.1:40000" }]);
    expect(rec.launchCalls).toHaveLength(1);
    expect(rec.launchCalls[0]?.cwd).toBe("/tmp/project");
    expect(rec.launchCalls[0]?.spawnForwarded).toBe(true);
    expect(rec.launchCalls[0]?.waitForwarded).toBe(true);
    expect(rec.launchCalls[0]?.url).toBeUndefined();
    expect(rec.stops).toBe(1);
  });

  it("propagates --ascii as JELLYCLAW_BRAND_GLYPH=ascii while TUI is mounted", async () => {
    const rec = makeRec();
    let seen: string | undefined;
    const launch: LaunchTuiFn = async (opts) => {
      rec.launchCalls.push({ url: opts.url, token: opts.token });
      seen = process.env.JELLYCLAW_BRAND_GLYPH;
      return { dispose: async () => undefined, onExit: Promise.resolve(0) };
    };
    const code = await tuiAction({
      args: ["tui"],
      flags: { ascii: true },
      platform: "linux",
      launchTui: launch,
      spawnEmbeddedServer: makeSpawn(rec),
      waitForHealth: makeWait(rec),
      stderr: makeStderr(),
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    expect(code).toBe(0);
    expect(seen).toBe("ascii");
    // restored after exit
    expect(process.env.JELLYCLAW_BRAND_GLYPH).toBeUndefined();
  });

  it("propagates --no-color as NO_COLOR=1 while TUI is mounted", async () => {
    const rec = makeRec();
    let seen: string | undefined;
    const launch: LaunchTuiFn = async (opts) => {
      rec.launchCalls.push({ url: opts.url, token: opts.token });
      seen = process.env.NO_COLOR;
      return { dispose: async () => undefined, onExit: Promise.resolve(0) };
    };
    const code = await tuiAction({
      args: ["tui"],
      flags: { color: false },
      platform: "linux",
      launchTui: launch,
      spawnEmbeddedServer: makeSpawn(rec),
      waitForHealth: makeWait(rec),
      stderr: makeStderr(),
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    expect(code).toBe(0);
    expect(seen).toBe("1");
    expect(process.env.NO_COLOR).toBeUndefined();
  });

  it("forwards --cwd to both spawn and launchTui", async () => {
    const rec = makeRec();
    await tuiAction({
      args: ["tui"],
      flags: { cwd: "/opt/work/repo" },
      platform: "linux",
      launchTui: makeLaunch(rec, Promise.resolve(0)),
      spawnEmbeddedServer: makeSpawn(rec),
      waitForHealth: makeWait(rec),
      stderr: makeStderr(),
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    expect(rec.spawnCalls[0]?.cwd).toBe("/opt/work/repo");
    expect(rec.launchCalls[0]?.cwd).toBe("/opt/work/repo");
  });
});

describe("tuiAction — signals", () => {
  it("maps SIGINT to exit code 130", async () => {
    const rec = makeRec();
    const neverExit = new Promise<number>(() => {
      /* never resolves */
    });
    const pending = tuiAction({
      args: ["tui"],
      flags: {},
      platform: "linux",
      launchTui: makeLaunch(rec, neverExit),
      spawnEmbeddedServer: makeSpawn(rec),
      waitForHealth: makeWait(rec),
      stderr: makeStderr(),
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    // Let the action progress past spawn+wait+launch.
    await new Promise((r) => setTimeout(r, 10));
    process.emit("SIGINT");
    expect(await pending).toBe(130);
    expect(rec.stops).toBe(1);
  });

  it("maps SIGTERM to exit code 143", async () => {
    const rec = makeRec();
    const neverExit = new Promise<number>(() => {
      /* never resolves */
    });
    const pending = tuiAction({
      args: ["tui"],
      flags: {},
      platform: "linux",
      launchTui: makeLaunch(rec, neverExit),
      spawnEmbeddedServer: makeSpawn(rec),
      waitForHealth: makeWait(rec),
      stderr: makeStderr(),
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    await new Promise((r) => setTimeout(r, 10));
    process.emit("SIGTERM");
    expect(await pending).toBe(143);
    expect(rec.stops).toBe(1);
  });
});

describe("tuiAction — health timeout", () => {
  it("returns 124 when waitForHealth throws TuiHealthTimeoutError", async () => {
    const rec = makeRec();
    const stderr = makeStderr();
    const code = await tuiAction({
      args: ["tui"],
      flags: {},
      platform: "linux",
      launchTui: makeLaunch(rec, Promise.resolve(0)),
      spawnEmbeddedServer: makeSpawn(rec),
      waitForHealth: makeWaitThrow(),
      stderr,
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    expect(code).toBe(124);
    // launchTui *was* invoked (it owns the spawn+wait lifecycle now); the
    // health-timeout error bubbled out of its body before it returned a handle.
    expect(rec.launchCalls).toHaveLength(1);
    expect(stderr.chunks.join("")).toContain("health never came up");
  });
});

describe("tuiAction — Windows guard", () => {
  it("exits 2 on platform === win32", async () => {
    const stderr = makeStderr();
    const code = await tuiAction({
      args: ["tui"],
      flags: {},
      platform: "win32",
      stderr,
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });
    expect(code).toBe(2);
    expect(stderr.chunks.join("")).toContain("macOS/Linux only");
  });
});

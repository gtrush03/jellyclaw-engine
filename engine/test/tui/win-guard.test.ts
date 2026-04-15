/**
 * Phase 99-06 — `tuiAction` Windows guard.
 *
 * Verifies that on `platform === 'win32'` the action returns 2 immediately
 * without touching `launchTui` or `spawnEmbeddedServer`.
 */

import { describe, expect, it, vi } from "vitest";

import { tuiAction } from "../../src/cli/tui.js";

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

describe("tuiAction — Windows guard", () => {
  it("returns 2 immediately and never calls launchTui or spawnEmbeddedServer", async () => {
    const launchTui = vi.fn();
    const spawnEmbeddedServer = vi.fn();
    const waitForHealth = vi.fn();
    const stderr = makeStderr();

    const code = await tuiAction({
      args: ["tui"],
      flags: {},
      platform: "win32",
      launchTui: launchTui as never,
      spawnEmbeddedServer: spawnEmbeddedServer as never,
      waitForHealth: waitForHealth as never,
      stderr,
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    });

    expect(code).toBe(2);
    expect(launchTui).not.toHaveBeenCalled();
    expect(spawnEmbeddedServer).not.toHaveBeenCalled();
    expect(waitForHealth).not.toHaveBeenCalled();
    expect(stderr.chunks.join("")).toContain("macOS/Linux only");
  });
});

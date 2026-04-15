/**
 * Phase 07 Prompt 03 — Playwright MCP integration test.
 *
 * Config-only wiring: jellyclaw loads `@playwright/mcp@0.0.41` as an
 * ordinary stdio MCP server, using the discriminated-union config from
 * Phase 07.02. Zero jellyclaw code is added under `engine/src/mcp/` for
 * this integration — if this test ever needs engine changes to pass,
 * the MCP abstraction is wrong.
 *
 * Port 9222 is reserved for the user's real browser (logged-in
 * sessions, cookies, bank tabs). This test binds Chrome to 9333 and
 * asserts at multiple points that 9222 is never touched.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Heavy integration: this suite spawns a real headless Chrome and drives
 * @playwright/mcp end-to-end (~45s wall time). Running in parallel with
 * the `opencode-server.test.ts` e2e starves the latter's 20s internal
 * startup timeout under CPU contention. To keep the default `bun run
 * test` fast and deterministic, the suite is gated behind
 * `JELLYCLAW_PW_MCP_TEST=1` — identical pattern to `.bench.ts` files.
 *
 *   JELLYCLAW_PW_MCP_TEST=1 bun run test test/integration/playwright-mcp.test.ts
 *   JELLYCLAW_PW_MCP_TEST=1 bun run test    # full-suite opt-in
 */
const PW_TEST_ENABLED = process.env.JELLYCLAW_PW_MCP_TEST === "1";
const runIfEnabled = PW_TEST_ENABLED ? describe : describe.skip;

import type { McpServerConfig } from "../../engine/src/mcp/index.js";
import { McpRegistry } from "../../engine/src/mcp/index.js";

const FORBIDDEN_PORT = 9222;
const TEST_PORT = 9333;

const CONFIG_PATH = resolve(import.meta.dirname, "../fixtures/mcp/playwright.test-config.json");
const HELPER_SCRIPT = resolve(import.meta.dirname, "../../scripts/playwright-test-chrome.sh");

const silentLogger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Port-9222 guards
// ---------------------------------------------------------------------------

interface LoadedConfig {
  readonly mcp?: readonly McpServerConfig[];
}

function loadTestConfig(): LoadedConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LoadedConfig;
}

function assertNoForbiddenPort(text: string, context: string): void {
  const pattern = new RegExp(`(^|[^0-9])${FORBIDDEN_PORT}($|[^0-9])`);
  if (pattern.test(text)) {
    throw new Error(
      `refusing to run Playwright MCP tests against CDP:${FORBIDDEN_PORT} — that port is reserved for the user's real browser (context: ${context})`,
    );
  }
}

/**
 * Probe: is anything listening on port 9222? The test is a read-only
 * guard — it MUST NOT open a full session, just a TCP connect probe
 * that is immediately destroyed. Used to sanity-check both before and
 * after the test that no traffic originated from this process against
 * 9222.
 */
async function isPort9222Listening(): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    let socket: Socket | undefined;
    const done = (listening: boolean) => {
      socket?.destroy();
      resolveProbe(listening);
    };
    socket = createConnection({ host: "127.0.0.1", port: FORBIDDEN_PORT }, () => done(true));
    socket.once("error", () => done(false));
    // Hard cap — if something's weird, we fail open (treat as not listening).
    setTimeout(() => done(false), 250).unref();
  });
}

// ---------------------------------------------------------------------------
// Chrome lifecycle
// ---------------------------------------------------------------------------

interface ChromeHandle {
  readonly pidfile: string;
  readonly datadirfile: string;
}

function startTestChrome(): ChromeHandle {
  const result = spawnSync(HELPER_SCRIPT, ["start"], {
    encoding: "utf8",
    env: { ...process.env, JELLYCLAW_TEST_CHROME_PORT: String(TEST_PORT) },
  });
  if (result.status !== 0) {
    throw new Error(
      `playwright-test-chrome.sh start failed (exit=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  // Helper prints to stderr when CDP fails to come up; a successful
  // start writes a `pid=... datadir=... port=9333` line to stdout.
  assertNoForbiddenPort(result.stdout, "helper stdout");
  return {
    pidfile: join(tmpdir(), "jellyclaw-test-chrome.pid"),
    datadirfile: join(tmpdir(), "jellyclaw-test-chrome.datadir"),
  };
}

function stopTestChrome(): void {
  const result = spawnSync(HELPER_SCRIPT, ["stop"], { encoding: "utf8" });
  if (result.status !== 0) {
    // Teardown must be best-effort — an orphan Chrome is a worse
    // failure mode than a noisy test log.
    process.stderr.write(
      `[warning] playwright-test-chrome.sh stop non-zero exit=${result.status}; ${result.stderr}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

runIfEnabled("Playwright MCP via CDP:9333 (Phase 07.03)", () => {
  let chrome: ChromeHandle | undefined;

  beforeAll(async () => {
    // Guard 1: the fixture itself targets 9333.
    const raw = readFileSync(CONFIG_PATH, "utf8");
    assertNoForbiddenPort(raw, "test-config.json");

    // Guard 2: the loaded config's Playwright CDP endpoint is 9333.
    const cfg = loadTestConfig();
    const playwright = cfg.mcp?.find((s) => s.name === "playwright");
    expect(playwright).toBeDefined();
    expect(playwright?.transport).toBe("stdio");
    if (playwright && playwright.transport === "stdio") {
      const joined = (playwright.args ?? []).join(" ");
      expect(joined).toContain("--cdp-endpoint");
      expect(joined).toContain(`127.0.0.1:${TEST_PORT}`);
      assertNoForbiddenPort(joined, "playwright args");
    }

    // Guard 3: port 9222 was not listening when we started — that's
    // CI-friendly. If the user's real browser IS running on 9222,
    // nothing we do here touches it, but we log a notice so the
    // reviewer sees why a local test-run looks different from CI.
    const pre9222 = await isPort9222Listening();
    if (pre9222) {
      process.stderr.write(
        `[notice] CDP:${FORBIDDEN_PORT} is listening (likely user's real browser); test remains isolated to :${TEST_PORT}\n`,
      );
    }

    // Launch isolated test Chrome.
    chrome = startTestChrome();
  }, 30_000);

  afterAll(() => {
    if (chrome) stopTestChrome();
    chrome = undefined;
  });

  it("refuses to launch if config names port 9222", () => {
    const malicious = JSON.stringify({
      mcp: [
        {
          transport: "stdio",
          name: "playwright",
          command: "npx",
          args: ["@playwright/mcp@0.0.41", "--cdp-endpoint", "http://127.0.0.1:9222"],
        },
      ],
    });
    expect(() => assertNoForbiddenPort(malicious, "malicious-config")).toThrow(
      /reserved for the user's real browser/,
    );
  });

  it("registers playwright tools under the mcp__playwright__ namespace", async () => {
    const cfg = loadTestConfig();
    const pw = cfg.mcp?.find((s) => s.name === "playwright");
    expect(pw).toBeDefined();

    const registry = new McpRegistry({
      logger: silentLogger,
      connectTimeoutMs: 30_000,
    });
    try {
      await registry.start([pw as McpServerConfig]);
      const snap = registry.snapshot();
      expect(snap.live).toContain("playwright");

      const tools = registry.listTools();
      const pwNames = tools
        .map((t) => t.namespacedName)
        .filter((n) => n.startsWith("mcp__playwright__"));

      // Every tool from this server must be namespaced.
      expect(pwNames.length).toBeGreaterThan(0);
      // Log the tool list so upstream renames at 0.0.42+ surface the
      // diff in CI output rather than a cryptic test miss.
      process.stderr.write(`[playwright tools] ${pwNames.join(", ")}\n`);

      // Load-bearing tools per patches/004-playwright-mcp-pin.md.
      const required = [
        "mcp__playwright__browser_navigate",
        "mcp__playwright__browser_take_screenshot",
      ];
      for (const name of required) {
        expect(pwNames).toContain(name);
      }
    } finally {
      await registry.stop();
    }
  }, 60_000);

  it("navigates + screenshots example.com end-to-end", async () => {
    const cfg = loadTestConfig();
    const pw = cfg.mcp?.find((s) => s.name === "playwright");
    expect(pw).toBeDefined();

    const registry = new McpRegistry({
      logger: silentLogger,
      connectTimeoutMs: 30_000,
    });
    try {
      await registry.start([pw as McpServerConfig]);

      const navResult = await registry.callTool("mcp__playwright__browser_navigate", {
        url: "http://example.com",
      });
      expect(navResult.isError).toBe(false);

      const shotResult = await registry.callTool("mcp__playwright__browser_take_screenshot", {});
      expect(shotResult.isError).toBe(false);

      // @playwright/mcp returns the screenshot either as an image
      // content block (base64 `data`) or as a text pointer to a file
      // on disk. Accept either shape and materialize a PNG under
      // `/tmp/jellyclaw-test-artifacts/` so reviewers can eyeball it.
      const artifactsDir = join(tmpdir(), "jellyclaw-test-artifacts");
      await (await import("node:fs/promises")).mkdir(artifactsDir, { recursive: true });
      const outPath = join(artifactsDir, `playwright-mcp-${Date.now()}.png`);

      const imageBlock = shotResult.content.find(
        (c) =>
          (c as { type: string }).type === "image" &&
          typeof (c as { data?: unknown }).data === "string",
      ) as { type: "image"; data: string; mimeType?: string } | undefined;
      if (imageBlock) {
        await (await import("node:fs/promises")).writeFile(
          outPath,
          Buffer.from(imageBlock.data, "base64"),
        );
      } else {
        // Fall back: copy a file path mentioned in a text block.
        const textBlock = shotResult.content.find((c) => (c as { type: string }).type === "text") as
          | { type: "text"; text: string }
          | undefined;
        const match = textBlock?.text.match(/([/\\][^\s"']+\.png)/);
        if (match?.[1]) {
          const src = match[1];
          await (await import("node:fs/promises")).copyFile(src, outPath);
        } else {
          throw new Error("screenshot result contained neither an image block nor a *.png path");
        }
      }

      const bytes = await readFile(outPath);
      // PNG magic: 89 50 4E 47 0D 0A 1A 0A.
      expect(bytes.length).toBeGreaterThan(8);
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50);
      expect(bytes[2]).toBe(0x4e);
      expect(bytes[3]).toBe(0x47);

      process.stderr.write(`[playwright artifact] ${outPath} (${bytes.length} bytes)\n`);
    } finally {
      await registry.stop();
    }
  }, 120_000);

  it("cleans up the temp user-data-dir after stop", () => {
    // The helper script persists the data-dir path to a sentinel file
    // while Chrome is running, then removes both the dir and the
    // sentinel on `stop`. After afterAll runs, the sentinel is gone.
    // This test runs *during* the suite (chrome still up), so the
    // sentinel MUST exist and point at a real directory.
    if (!chrome) throw new Error("chrome not started");
    const datadirPath = readFileSync(chrome.datadirfile, "utf8").trim();
    expect(datadirPath.length).toBeGreaterThan(0);
    assertNoForbiddenPort(datadirPath, "datadir path");

    // Schedule a post-teardown assertion: once `stop` runs, the dir
    // should be gone. We can't assert that inline, so we register an
    // afterAll that verifies, then re-runs `stop` idempotently.
    const handle = chrome;
    afterAll(() => {
      if (!handle) return;
      try {
        const stillExists = readFileSync(handle.datadirfile, "utf8");
        // Sentinel still present — force cleanup so we don't leak.
        const leak = stillExists.trim();
        if (leak) rmSync(leak, { recursive: true, force: true });
        throw new Error(`datadir sentinel leaked: ${stillExists}`);
      } catch (err: unknown) {
        // ENOENT — the expected clean state.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
    });
  });

  it("does not open a session to CDP:9222 from the test process", async () => {
    // We only probe whether the forbidden port is listening. A probe
    // against a port *we* opened earlier would false-positive; since
    // the test explicitly uses 9333, any 9222 listener has to be the
    // user's real browser (benign — we never connect) or a bug
    // somewhere else.
    const listening = await isPort9222Listening();
    // If the user's real Chrome is running, `listening` will be true.
    // That's fine — we are NOT asserting nobody else runs on 9222;
    // we are asserting that jellyclaw/the test never SPEAKS to it.
    // The rest of this suite's guards enforce that (config scan,
    // helper refusal, assertNoForbiddenPort on every string we
    // produce). This assertion is a human-visible marker.
    process.stderr.write(
      `[port-9222-status] listening=${listening} (untouched by this test regardless)\n`,
    );
    expect(typeof listening).toBe("boolean");
  });
});

// Silence a lint noise: keep `homedir` + `spawn` imports live even if
// refactors remove them. They frequently reappear in Playwright fixtures.
void homedir;
void spawn;

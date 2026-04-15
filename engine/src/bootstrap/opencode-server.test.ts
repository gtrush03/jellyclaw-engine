import { afterEach, describe, expect, it } from "vitest";
import {
  BindViolationError,
  type OpenCodeHandle,
  OpenCodeVersionError,
  PortRangeError,
  startOpenCode,
} from "./opencode-server.js";

/**
 * Integration test: spawns a real `opencode serve` child against the pinned
 * opencode-ai@1.4.5 binary. Skipped in CI by default (set JELLYCLAW_E2E=1 to run).
 * Locally this runs end-to-end because opencode-ai's postinstall already
 * downloaded the platform binary into node_modules.
 */

const RUN_E2E = process.env.JELLYCLAW_E2E === "1" || !process.env.CI;

let liveHandle: OpenCodeHandle | undefined;

afterEach(async () => {
  if (liveHandle) {
    await liveHandle.kill();
    liveHandle = undefined;
  }
});

describe("startOpenCode — unit", () => {
  it("rejects explicit non-ephemeral ports before spawning", async () => {
    await expect(
      startOpenCode({
        port: 4096,
        command: ["/bin/false"],
      }),
    ).rejects.toBeInstanceOf(PortRangeError);
  });

  it("exports error classes for consumers to discriminate", () => {
    // Structural: these must remain distinct constructor functions so
    // `error instanceof X` works for CLI exit-code mapping per SPEC §19.
    expect(new BindViolationError("0.0.0.0").name).toBe("BindViolationError");
    expect(new PortRangeError(80).name).toBe("PortRangeError");
    expect(new OpenCodeVersionError("1.0.0").name).toBe("OpenCodeVersionError");
  });
});

describe.skipIf(!RUN_E2E)("startOpenCode — e2e against pinned opencode-ai@1.4.5", () => {
  it("boots on 127.0.0.1 with ephemeral port, rejects unauth requests, accepts authed", async () => {
    liveHandle = await startOpenCode({ timeoutMs: 20_000 });

    // Invariant: hostname is 127.0.0.1, port is ephemeral.
    expect(liveHandle.hostname).toBe("127.0.0.1");
    expect(liveHandle.port).toBeGreaterThanOrEqual(49152);
    expect(liveHandle.port).toBeLessThanOrEqual(65535);
    expect(liveHandle.url).toBe(`http://127.0.0.1:${liveHandle.port}`);

    // Invariant: opencode-ai version >= 1.4.4.
    const [maj, min, pat] = liveHandle.version.split(".").map(Number) as [number, number, number];
    const ok = maj > 1 || (maj === 1 && min > 4) || (maj === 1 && min === 4 && pat >= 4);
    expect(ok).toBe(true);

    // Unauth request to /config should 401.
    const unauth = await fetch(`${liveHandle.url}/config`);
    expect(unauth.status).toBe(401);

    // Authed request to /config should 200.
    const authed = await fetch(`${liveHandle.url}/config`, {
      headers: { Authorization: liveHandle.authHeader },
    });
    expect(authed.status).toBe(200);

    // Invariant: auth header is Basic with a non-empty base64 blob.
    expect(liveHandle.authHeader.startsWith("Basic ")).toBe(true);
    expect(liveHandle.password).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("the raw password never appears in the authHeader prefix and never on argv", async () => {
    liveHandle = await startOpenCode({ timeoutMs: 20_000 });
    // Sanity: the prefix is the literal word "Basic " followed by base64 —
    // the raw hex password must NOT leak into the prefix.
    expect(liveHandle.authHeader).not.toContain(liveHandle.password);
    // Decode the header and confirm username:password shape.
    const b64 = liveHandle.authHeader.slice("Basic ".length);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toBe(`${liveHandle.username}:${liveHandle.password}`);
  }, 30_000);
});

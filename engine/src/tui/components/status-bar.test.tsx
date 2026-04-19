/**
 * Tests for StatusBar component (T3-09, T1-04 polish).
 *
 * Covers:
 *   - Pill rendering: model (always), cost (> $0.01 only), context (<used>/<max>)
 *   - Narrow-terminal collapse: < 80 cols → model pill only
 *   - Session slug + cwd basename in the left label
 *   - Connection badges still surface when disconnected / reconnecting
 *   - 0600 perms for the persisted history file (spec acceptance)
 */

import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { HISTORY_FILE_MODE, saveHistory } from "../hooks/use-history.js";
import type { UiConnection } from "../state/types.js";
import { StatusBar } from "./status-bar.js";

const defaultProps = {
  sessionId: "abcdef0123456789",
  model: "opus-4-7",
  cwd: "/Users/alice/work/jellyclaw-engine",
  usage: {
    inputTokens: 5000,
    outputTokens: 3000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.25,
  },
  status: "idle" as const,
  tick: 0,
  reducedMotion: true,
  terminalWidth: 120,
};

describe("StatusBar: pills", () => {
  it("renders the model pill with the active model label", () => {
    const { lastFrame } = render(<StatusBar {...defaultProps} />);
    const plain = stripAnsi(lastFrame());
    expect(plain).toContain("opus-4-7");
  });

  it("renders the cost pill when costUsd is above $0.01", () => {
    const { lastFrame } = render(<StatusBar {...defaultProps} />);
    const plain = stripAnsi(lastFrame());
    expect(plain).toContain("$0.25");
  });

  it("suppresses the cost pill when costUsd is at or below $0.01", () => {
    const { lastFrame } = render(
      <StatusBar {...defaultProps} usage={{ ...defaultProps.usage, costUsd: 0.005 }} />,
    );
    const plain = stripAnsi(lastFrame());
    expect(plain).not.toContain("$0.00");
    expect(plain).not.toContain("$0.01");
  });

  it("renders the context pill as <used>/<max> tokens", () => {
    const { lastFrame } = render(
      <StatusBar
        {...defaultProps}
        contextMaxTokens={200_000}
        usage={{
          inputTokens: 12_000,
          outputTokens: 3_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.25,
        }}
      />,
    );
    const plain = stripAnsi(lastFrame());
    expect(plain).toContain("15k/200k");
  });

  it("renders session slug + cwd basename on the left", () => {
    const { lastFrame } = render(<StatusBar {...defaultProps} />);
    const plain = stripAnsi(lastFrame());
    expect(plain).toContain("abcdef01");
    expect(plain).toContain("jellyclaw-engine");
  });
});

describe("StatusBar: narrow collapse", () => {
  it("hides cost + context pills when terminalWidth < 80", () => {
    const { lastFrame } = render(<StatusBar {...defaultProps} terminalWidth={60} />);
    const plain = stripAnsi(lastFrame());
    expect(plain).toContain("opus-4-7");
    expect(plain).not.toContain("$0.25");
    expect(plain).not.toContain("/200k");
  });

  it("shows all pills when terminalWidth is exactly 80", () => {
    const { lastFrame } = render(<StatusBar {...defaultProps} terminalWidth={80} />);
    const plain = stripAnsi(lastFrame());
    expect(plain).toContain("opus-4-7");
    expect(plain).toContain("$0.25");
  });
});

describe("StatusBar: connection badges", () => {
  it("renders amber reconnecting badge when connection is reconnecting", () => {
    const connection: UiConnection = {
      kind: "reconnecting",
      attempt: 2,
      nextRetryMs: 2000,
    };

    const { lastFrame } = render(<StatusBar {...defaultProps} connection={connection} />);
    const frame = lastFrame();

    expect(frame).toContain("reconnecting");
    expect(frame).toContain("attempt 2");
  });

  it("renders disconnected badge when connection is disconnected", () => {
    const connection: UiConnection = {
      kind: "disconnected",
      reason: "network timeout",
    };

    const { lastFrame } = render(<StatusBar {...defaultProps} connection={connection} />);
    const frame = lastFrame();

    expect(frame).toContain("disconnected");
    expect(frame).toContain("network timeout");
  });

  it("does not render connection badge when connected", () => {
    const connection: UiConnection = { kind: "connected" };

    const { lastFrame } = render(<StatusBar {...defaultProps} connection={connection} />);
    const frame = lastFrame();

    expect(frame).not.toContain("reconnecting");
    expect(frame).not.toContain("disconnected");
  });

  it("does not render connection badge when connection prop is undefined", () => {
    const { lastFrame } = render(<StatusBar {...defaultProps} />);
    const frame = lastFrame();

    expect(frame).not.toContain("reconnecting");
    expect(frame).not.toContain("disconnected");
  });

  it("includes attempt number in reconnecting badge", () => {
    const connection: UiConnection = {
      kind: "reconnecting",
      attempt: 5,
      nextRetryMs: 16000,
    };

    const { lastFrame } = render(<StatusBar {...defaultProps} connection={connection} />);
    const frame = lastFrame();

    expect(frame).toContain("attempt 5");
  });
});

describe("useHistory perms", () => {
  it("writes history.jsonl with mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jellyclaw-history-"));
    const path = join(dir, "history.jsonl");
    await saveHistory(["hello", "world"], path);
    const s = await stat(path);
    // Strip type bits; compare only permission bits.
    const permBits = s.mode & 0o777;
    expect(permBits).toBe(HISTORY_FILE_MODE);
  });

  it("restores 0600 even if the file already existed with looser perms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jellyclaw-history-"));
    const path = join(dir, "history.jsonl");
    await saveHistory(["first"], path);
    // Simulate a prior write with loose perms.
    await chmod(path, 0o644);
    await saveHistory(["first", "second"], path);
    const s = await stat(path);
    const permBits = s.mode & 0o777;
    expect(permBits).toBe(HISTORY_FILE_MODE);
  });
});

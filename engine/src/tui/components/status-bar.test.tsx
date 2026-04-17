/**
 * Tests for StatusBar component (T3-09).
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { UiConnection } from "../state/types.js";
import { StatusBar } from "./status-bar.js";

const defaultProps = {
  sessionId: "test-session",
  model: "opus-4-5",
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
  },
  status: "idle" as const,
  tick: 0,
  reducedMotion: true,
};

describe("reconnecting-badge", () => {
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

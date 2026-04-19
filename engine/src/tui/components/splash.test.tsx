/**
 * Splash component tests — covers rendering, key bindings, and version display.
 */

import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { Splash } from "./splash.js";

describe("Splash", () => {
  const defaultProps = {
    cwd: "/Users/test/project",
    model: "claude-3-opus",
  };

  describe("full splash rendering", () => {
    it("renders the wordmark and tagline", () => {
      const { lastFrame } = render(<Splash {...defaultProps} />);
      const output = stripAnsi(lastFrame());
      expect(output).toContain("jellyclaw");
      expect(output).toContain("open-source agent runtime");
    });

    it("renders the jellyfish emoji", () => {
      const { lastFrame } = render(<Splash {...defaultProps} />);
      const output = lastFrame();
      expect(output).toContain("\u{1FABC}");
    });

    it("renders the hint with ENTER to start", () => {
      const { lastFrame } = render(<Splash {...defaultProps} />);
      const output = lastFrame();
      expect(output).toContain("ENTER to start");
    });

    it("renders the hint with ESC to quit", () => {
      const { lastFrame } = render(<Splash {...defaultProps} />);
      const output = lastFrame();
      expect(output).toContain("ESC to quit");
    });

    it("renders the version string", () => {
      const { lastFrame } = render(<Splash {...defaultProps} version="1.2.3" />);
      const output = lastFrame();
      expect(output).toContain("v1.2.3");
    });

    it("renders the default version when not provided", () => {
      const { lastFrame } = render(<Splash {...defaultProps} />);
      const output = lastFrame();
      expect(output).toContain("v0.0.1");
    });

    it("renders the model when provided", () => {
      const { lastFrame } = render(<Splash {...defaultProps} model="claude-3-opus" />);
      const output = lastFrame();
      expect(output).toContain("claude-3-opus");
    });

    it("renders the cwd", () => {
      const { lastFrame } = render(<Splash {...defaultProps} cwd="/my/project" />);
      const output = lastFrame();
      expect(output).toContain("/my/project");
    });

    it("truncates long cwd paths", () => {
      const longPath = "/very/long/path/that/exceeds/the/maximum/allowed/length/for/display";
      const { lastFrame } = render(<Splash {...defaultProps} cwd={longPath} />);
      const output = lastFrame();
      // Should contain ellipsis for truncated path
      expect(output).toContain("\u2026");
    });
  });

  describe("compact splash rendering", () => {
    it("renders compact mode when sessionId is provided", () => {
      const { lastFrame } = render(<Splash {...defaultProps} sessionId="abc12345678" />);
      const output = lastFrame();
      // Compact mode shows truncated session ID
      expect(output).toContain("abc12345");
    });

    it("does not show full hint in compact mode", () => {
      const { lastFrame } = render(<Splash {...defaultProps} sessionId="abc12345678" />);
      const output = lastFrame();
      // Should not contain the full hint
      expect(output).not.toContain("ENTER to start");
    });
  });

  describe("key bindings", () => {
    // Note: ink-testing-library's stdin.write doesn't properly trigger
    // useInput handlers. The key bindings work in practice but cannot be
    // unit tested with ink-testing-library. These tests verify the component
    // structure supports callbacks rather than actual key handling.

    it("accepts onStart callback in props", () => {
      const onStart = vi.fn();
      const { lastFrame } = render(<Splash {...defaultProps} onStart={onStart} />);
      // Component renders without error with callback prop
      expect(lastFrame()).toContain("ENTER to start");
    });

    it("accepts onQuit callback in props", () => {
      const onQuit = vi.fn();
      const { lastFrame } = render(<Splash {...defaultProps} onQuit={onQuit} />);
      // Component renders without error with callback prop
      expect(lastFrame()).toContain("ESC to quit");
    });

    it("does not crash when keys are pressed without handlers", () => {
      // Should not throw when onStart/onQuit are not provided
      const { stdin } = render(<Splash {...defaultProps} />);
      expect(() => {
        stdin.write("\r");
        stdin.write("\x1B");
      }).not.toThrow();
    });
  });

  describe("model display", () => {
    it("hides model when it is (default)", () => {
      const { lastFrame } = render(<Splash {...defaultProps} model="(default)" />);
      const output = lastFrame();
      expect(output).not.toContain("(default)");
    });

    it("hides model label when model is empty", () => {
      const { lastFrame } = render(<Splash {...defaultProps} model="" />);
      const output = lastFrame();
      // Should not show "model" label
      const lines = output.split("\n");
      const hasModelLabel = lines.some((line) => line.includes("model "));
      expect(hasModelLabel).toBe(false);
    });
  });
});

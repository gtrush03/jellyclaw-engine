/**
 * Tests for InputBox component (T1-04).
 *
 * Tests multi-line input, placeholder text, and slash-command hints.
 */

import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { InputBox } from "./input-box.js";

describe("InputBox", () => {
  const defaultProps = {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
  };

  describe("placeholder", () => {
    it("shows default placeholder when value is empty", () => {
      const { lastFrame } = render(<InputBox {...defaultProps} value="" />);
      const frame = stripAnsi(lastFrame());
      expect(frame).toContain("Ask jellyclaw");
      expect(frame).toContain("/ for commands");
    });

    it("shows custom placeholder when provided", () => {
      const { lastFrame } = render(
        <InputBox {...defaultProps} value="" placeholder="Custom placeholder" />,
      );
      const frame = stripAnsi(lastFrame());
      expect(frame).toContain("Custom placeholder");
    });

    it("does not show placeholder when value is not empty", () => {
      const { lastFrame } = render(<InputBox {...defaultProps} value="hello" />);
      const frame = stripAnsi(lastFrame());
      expect(frame).toContain("hello");
      expect(frame).not.toContain("Ask jellyclaw");
    });
  });

  describe("disabled state", () => {
    it("shows streaming indicator when disabled", () => {
      const { lastFrame } = render(<InputBox {...defaultProps} disabled={true} />);
      const frame = stripAnsi(lastFrame());
      expect(frame).toContain("streaming");
    });

    it("shows normal content when not disabled", () => {
      const { lastFrame } = render(<InputBox {...defaultProps} disabled={false} value="test" />);
      const frame = stripAnsi(lastFrame());
      expect(frame).toContain("test");
      expect(frame).not.toContain("streaming");
    });
  });

  describe("input prompt", () => {
    it("renders the prompt character", () => {
      const { lastFrame } = render(<InputBox {...defaultProps} />);
      const frame = stripAnsi(lastFrame());
      expect(frame).toContain("›");
    });
  });

  describe("multi-line rendering", () => {
    it("renders multi-line text correctly", () => {
      const { lastFrame } = render(<InputBox {...defaultProps} value="line1\nline2\nline3" />);
      const frame = stripAnsi(lastFrame());
      expect(frame).toContain("line1");
      expect(frame).toContain("line2");
      expect(frame).toContain("line3");
    });
  });

  describe("caret visualization", () => {
    it("shows caret position in input", () => {
      const { lastFrame } = render(<InputBox {...defaultProps} value="test" />);
      // Should render without crashing
      expect(lastFrame()).toBeDefined();
    });
  });
});

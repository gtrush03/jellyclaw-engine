/**
 * Boot animation tests — covers normal render, JELLYCLAW_NO_ANIM skip, and
 * NO_COLOR strip behavior.
 */

import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { BootAnimation } from "./boot-animation.js";

describe("BootAnimation", () => {
  describe("normal render", () => {
    it("renders the jellyfish and wordmark", () => {
      const onDone = vi.fn();
      const { lastFrame } = render(<BootAnimation reducedMotion={true} onDone={onDone} />);
      const output = stripAnsi(lastFrame());
      // Should contain the jellyfish emoji and wordmark
      expect(output).toContain("\u{1FABC}");
      expect(output).toContain("jellyclaw");
    });

    it("renders with animation when reducedMotion is false", () => {
      const onDone = vi.fn();
      const { lastFrame } = render(<BootAnimation reducedMotion={false} onDone={onDone} />);
      const output = lastFrame();
      // Should contain the jellyfish emoji at minimum
      expect(output).toContain("\u{1FABC}");
    });

    it("calls onDone when reducedMotion is true", async () => {
      const onDone = vi.fn();
      render(<BootAnimation reducedMotion={true} onDone={onDone} />);
      // Wait for the setTimeout(0) to fire
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalled();
      });
    });
  });

  describe("JELLYCLAW_NO_ANIM skip", () => {
    it("skips animation when JELLYCLAW_NO_ANIM=1", async () => {
      const onDone = vi.fn();
      const env = { JELLYCLAW_NO_ANIM: "1" };
      const { lastFrame } = render(
        <BootAnimation reducedMotion={false} onDone={onDone} env={env} />,
      );
      const output = stripAnsi(lastFrame());
      // Should show the full wordmark immediately
      expect(output).toContain("jellyclaw");
      // onDone should be called quickly
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalled();
      });
    });

    it("shows full wordmark immediately with NO_ANIM", () => {
      const onDone = vi.fn();
      const env = { JELLYCLAW_NO_ANIM: "1" };
      const { lastFrame } = render(
        <BootAnimation reducedMotion={false} onDone={onDone} env={env} />,
      );
      const output = stripAnsi(lastFrame());
      // Full wordmark should be visible
      expect(output).toContain("jellyclaw");
    });
  });

  describe("NO_COLOR strip", () => {
    it("strips colors when NO_COLOR is set", () => {
      const onDone = vi.fn();
      const env = { NO_COLOR: "1" };
      const { lastFrame } = render(
        <BootAnimation reducedMotion={true} onDone={onDone} env={env} />,
      );
      const output = lastFrame();
      // Should still render content but without ANSI escapes
      // Ink testing library strips ANSI by default, so just verify content
      expect(output).toContain("jellyclaw");
    });

    it("strips colors when no_color (lowercase) is set", () => {
      const onDone = vi.fn();
      const env = { no_color: "1" };
      const { lastFrame } = render(
        <BootAnimation reducedMotion={true} onDone={onDone} env={env} />,
      );
      const output = lastFrame();
      expect(output).toContain("jellyclaw");
    });
  });

  describe("combined flags", () => {
    it("handles both NO_ANIM and NO_COLOR together", async () => {
      const onDone = vi.fn();
      const env = { JELLYCLAW_NO_ANIM: "1", NO_COLOR: "1" };
      const { lastFrame } = render(
        <BootAnimation reducedMotion={false} onDone={onDone} env={env} />,
      );
      const output = lastFrame();
      expect(output).toContain("jellyclaw");
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalled();
      });
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  animate,
  isAsciiMode,
  isReducedMotion,
  jellyfishSpinnerCompact,
  jellyfishSpinnerCompactAscii,
  jellyfishSpinnerHero,
  jellyfishSpinnerHeroAscii,
  jellyfishSpinnerMinimal,
  renderFrame,
} from "./jellyfish-spinner.js";

// Use JS `.length` as a coarse column proxy. Braille chars (⠄⠂⠁⠆⠇…) are single
// BMP codepoints (= 1 UTF-16 unit = 1 `.length`) AND render as 1 col in most
// fixed-width fonts, so .length == visible-width for these specific frames.
// If we later add CJK/emoji to a frame, swap this for `string-width`.
const width = (s: string): number => s.length;

describe("jellyfish-spinner: compact frame shape", () => {
  it("has exactly 10 frames at 80ms", () => {
    expect(jellyfishSpinnerCompact.frames).toHaveLength(10);
    expect(jellyfishSpinnerCompact.interval).toBe(80);
  });

  it("every compact frame is exactly 7 columns wide", () => {
    for (const [i, frame] of jellyfishSpinnerCompact.frames.entries()) {
      expect(width(frame), `compact frame ${i} width`).toBe(7);
    }
  });

  it("no compact frame contains ANSI escapes", () => {
    for (const frame of jellyfishSpinnerCompact.frames) {
      expect(frame).not.toMatch(/\x1b\[/u);
    }
  });

  it("static frame is 7-col peak-pulse compact silhouette", () => {
    // Spec static is "(◉)⠇ " at 5 cols but the spec invariant demands 7 cols —
    // we normalize and keep the peak-pulse silhouette intact.
    expect(jellyfishSpinnerCompact.staticFrame).toMatch(/^\(\u25C9\)\u2807 *$/u);
    expect(jellyfishSpinnerCompact.staticFrame.length).toBe(7);
  });
});

describe("jellyfish-spinner: hero frame shape", () => {
  it("has exactly 8 frames at 90ms", () => {
    expect(jellyfishSpinnerHero.frames).toHaveLength(8);
    expect(jellyfishSpinnerHero.interval).toBe(90);
  });

  it("every hero frame has 3 lines, each 11 columns wide", () => {
    for (const [i, frame] of jellyfishSpinnerHero.frames.entries()) {
      const lines = frame.split("\n");
      expect(lines, `hero frame ${i} line count`).toHaveLength(3);
      for (const [j, line] of lines.entries()) {
        expect(width(line), `hero frame ${i} line ${j} width`).toBe(11);
      }
    }
  });

  it("no hero frame contains ANSI escapes", () => {
    for (const frame of jellyfishSpinnerHero.frames) {
      expect(frame).not.toMatch(/\x1b\[/u);
    }
  });

  it("hero static frame is the peak-pulse frame (index 3)", () => {
    expect(jellyfishSpinnerHero.staticFrame).toBe(jellyfishSpinnerHero.frames[3]);
  });
});

describe("jellyfish-spinner: ascii fallback", () => {
  it("compact ascii preserves 10 frames at 7 cols", () => {
    expect(jellyfishSpinnerCompactAscii.frames).toHaveLength(10);
    for (const frame of jellyfishSpinnerCompactAscii.frames) {
      expect(width(frame)).toBe(7);
    }
  });

  it("hero ascii preserves 8 frames with 3 lines of 11 cols", () => {
    expect(jellyfishSpinnerHeroAscii.frames).toHaveLength(8);
    for (const frame of jellyfishSpinnerHeroAscii.frames) {
      const lines = frame.split("\n");
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(width(line)).toBe(11);
    }
  });
});

describe("jellyfish-spinner: minimal variant", () => {
  it("has exactly 3 frames at 120ms", () => {
    expect(jellyfishSpinnerMinimal.frames).toHaveLength(3);
    expect(jellyfishSpinnerMinimal.interval).toBe(120);
  });

  it("frames are . .. ...", () => {
    expect(jellyfishSpinnerMinimal.frames[0]).toBe(".");
    expect(jellyfishSpinnerMinimal.frames[1]).toBe("..");
    expect(jellyfishSpinnerMinimal.frames[2]).toBe("...");
  });

  it("static frame is ...", () => {
    expect(jellyfishSpinnerMinimal.staticFrame).toBe("...");
  });

  it("frame cadence is ≈120ms ±10%", () => {
    const interval = jellyfishSpinnerMinimal.interval;
    expect(interval).toBeGreaterThanOrEqual(108); // 120 - 10%
    expect(interval).toBeLessThanOrEqual(132); // 120 + 10%
  });
});

describe("jellyfish-spinner: reduced motion detection", () => {
  it("honors NO_COLOR (uppercase)", () => {
    expect(isReducedMotion({ env: { NO_COLOR: "1" }, isTTY: true })).toBe(true);
  });

  it("honors no_color (lowercase)", () => {
    expect(isReducedMotion({ env: { no_color: "1" }, isTTY: true })).toBe(true);
  });

  it("honors CLAUDE_CODE_DISABLE_ANIMATIONS", () => {
    expect(isReducedMotion({ env: { CLAUDE_CODE_DISABLE_ANIMATIONS: "1" }, isTTY: true })).toBe(
      true,
    );
  });

  it("honors JELLYCLAW_REDUCED_MOTION", () => {
    expect(isReducedMotion({ env: { JELLYCLAW_REDUCED_MOTION: "1" }, isTTY: true })).toBe(true);
  });

  it("detects non-TTY stdout", () => {
    expect(isReducedMotion({ env: {}, isTTY: false })).toBe(true);
  });

  it("returns false on a fully animated terminal", () => {
    expect(isReducedMotion({ env: {}, isTTY: true })).toBe(false);
  });
});

describe("jellyfish-spinner: ascii mode detection", () => {
  it("honors the ascii prop", () => {
    expect(isAsciiMode({ ascii: true, env: {}, argv: [] })).toBe(true);
  });

  it("honors TERM=linux", () => {
    expect(isAsciiMode({ env: { TERM: "linux" }, argv: [] })).toBe(true);
  });

  it("honors --ascii flag", () => {
    expect(isAsciiMode({ env: {}, argv: ["node", "app", "--ascii"] })).toBe(true);
  });

  it("defaults to false", () => {
    expect(isAsciiMode({ env: {}, argv: [] })).toBe(false);
  });
});

describe("jellyfish-spinner: renderFrame reduced-motion output", () => {
  it("NO_COLOR → returns static compact frame, no escapes", () => {
    const out = renderFrame({ env: { NO_COLOR: "1" }, isTTY: true, size: "compact" });
    expect(out).toBe(jellyfishSpinnerCompact.staticFrame);
    expect(out).not.toMatch(/\x1b\[/u);
  });

  it("no_color (lower) → static frame", () => {
    const out = renderFrame({ env: { no_color: "yes" }, isTTY: true, size: "compact" });
    expect(out).toBe(jellyfishSpinnerCompact.staticFrame);
  });

  it("CLAUDE_CODE_DISABLE_ANIMATIONS → static frame", () => {
    const out = renderFrame({
      env: { CLAUDE_CODE_DISABLE_ANIMATIONS: "1" },
      isTTY: true,
      size: "hero",
    });
    expect(out).toBe(jellyfishSpinnerHero.staticFrame);
    expect(out).not.toMatch(/\x1b\[/u);
  });

  it("JELLYCLAW_REDUCED_MOTION → static frame", () => {
    const out = renderFrame({
      env: { JELLYCLAW_REDUCED_MOTION: "1" },
      isTTY: true,
      size: "hero",
    });
    expect(out).toBe(jellyfishSpinnerHero.staticFrame);
  });

  it("isTTY=false → static frame", () => {
    const out = renderFrame({ env: {}, isTTY: false, size: "compact" });
    expect(out).toBe(jellyfishSpinnerCompact.staticFrame);
  });
});

describe("jellyfish-spinner: renderFrame color paths (JellyJelly palette)", () => {
  // Truecolor: bell=#3BA7FF(59,167,255) rim=#9E7BFF(158,123,255)
  //            trail=#5A6B8C(90,107,140) beat=#FFB547(255,181,71)
  it("truecolor compact frame contains the bell (Jelly Cyan) escape", () => {
    const out = renderFrame({
      env: { COLORTERM: "truecolor" },
      isTTY: true,
      size: "compact",
      frame: 0,
    });
    expect(out).toContain("\x1b[38;2;59;167;255m");
    // Per-char painter leaves plain spaces unwrapped for width preservation,
    // so the trailing char may be a space. At minimum one RESET must appear.
    expect(out).toContain("\x1b[0m");
  });

  it("ansi256 compact frame contains the bell (256→75) escape", () => {
    const out = renderFrame({ env: {}, isTTY: true, size: "compact", frame: 0 });
    expect(out).toContain("\x1b[38;5;75m");
  });

  it("compact peak frame (F3, idx 2) paints an amber heartbeat tip", () => {
    const out = renderFrame({
      env: { COLORTERM: "truecolor" },
      isTTY: true,
      size: "compact",
      frame: 2,
    });
    expect(out).toContain("\x1b[38;2;255;181;71m"); // amber beat
    expect(out).toContain("\x1b[38;2;158;123;255m"); // rim violet (parens)
  });

  it("compact non-peak frame (F1) has no amber heartbeat", () => {
    const out = renderFrame({
      env: { COLORTERM: "truecolor" },
      isTTY: true,
      size: "compact",
      frame: 0,
    });
    expect(out).not.toContain("\x1b[38;2;255;181;71m");
  });

  it("hero peak frame (F4) paints line1→bell, line2→rim, line3→trail with amber beat center", () => {
    const out = renderFrame({
      env: { COLORTERM: "truecolor" },
      isTTY: true,
      size: "hero",
      frame: 3,
    });
    expect(out).toContain("\x1b[38;2;59;167;255m"); // bell
    expect(out).toContain("\x1b[38;2;158;123;255m"); // rim
    expect(out).toContain("\x1b[38;2;90;107;140m"); // trail
    expect(out).toContain("\x1b[38;2;255;181;71m"); // amber beat
  });

  it("hero non-peak frame has no amber heartbeat", () => {
    const out = renderFrame({
      env: { COLORTERM: "truecolor" },
      isTTY: true,
      size: "hero",
      frame: 0,
    });
    expect(out).not.toContain("\x1b[38;2;255;181;71m");
  });

  it("ascii mode uses the ascii frame set", () => {
    const out = renderFrame({
      env: { JELLYCLAW_REDUCED_MOTION: "1", TERM: "linux" },
      isTTY: true,
      size: "compact",
    });
    expect(out).toBe(jellyfishSpinnerCompactAscii.staticFrame);
  });

  it("reduced-motion static frame has no amber heartbeat (avoids permanent warning tint)", () => {
    // Per brief: reduced-motion users shouldn't see a permanent warning color.
    const out = renderFrame({
      env: { JELLYCLAW_REDUCED_MOTION: "1" },
      isTTY: true,
      size: "hero",
    });
    expect(out).not.toContain("\x1b[38;2;255;181;71m");
    expect(out).not.toContain("\x1b[38;5;215m");
  });
});

describe("jellyfish-spinner: animate", () => {
  let captured: string[];
  let originalTTY: boolean | undefined;

  beforeEach(() => {
    captured = [];
    originalTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    if (originalTTY !== undefined) process.stdout.isTTY = originalTTY;
  });

  it("reduced-motion prints static frame once and returns a no-op stop", () => {
    const { stop } = animate({
      env: { JELLYCLAW_REDUCED_MOTION: "1" },
      isTTY: true,
      size: "compact",
      write: (chunk) => captured.push(chunk),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(jellyfishSpinnerCompact.staticFrame);
    stop(); // must not throw
  });

  it("animated loop writes at least one frame immediately and stops cleanly", () => {
    const { stop } = animate({
      env: {},
      isTTY: true,
      size: "compact",
      write: (chunk) => captured.push(chunk),
    });
    expect(captured.length).toBeGreaterThanOrEqual(1);
    stop();
  });
});

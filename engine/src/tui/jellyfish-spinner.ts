/**
 * Jellyfish spinner — jellyclaw JellyJelly brand layer.
 *
 * Ships two variants (compact 1-line / hero 3-line) as plain-string frame data,
 * plus a pure render helper that paints ANSI color at call-time. Frames are
 * color-agnostic on disk so themes can recolor without editing strings.
 *
 * Brand application (from `jellyclaw-brand-brief.md`):
 *   - bell/dome       → primary  `#3BA7FF` Jelly Cyan (live, focus, bell)
 *   - rim / accent    → accent   `#9E7BFF` Medusa Violet (tentacle tips, glow)
 *   - trail tentacles → muted    `#5A6B8C` Tidewater
 *   - heartbeat tip   → warning  `#FFB547` Amber Eye (one frame per cycle,
 *                                           at peak pulse — compact F3/F8,
 *                                           hero F4)
 *
 * Motion verbs per frame (comments on each frame):
 *   Compact (10 frames, 80ms): rest → inhale → pulse → release → drift-a →
 *                              drift-b → coil → flare → crest → settle.
 *   Hero    (8 frames, 90ms):  rest → inhale → bloom → peak → thrust →
 *                              glide-a → glide-b → settle.
 *
 * Reduced-motion fallback is the hero/compact peak silhouette with NO amber
 * heartbeat — per brief, a permanent warning tint would misread as an error.
 *
 * Path deviation: the TUI-phase prompt specifies `component/jellyfish-spinner.tsx`
 * inside the vendored OpenCode tree as a Solid component. This repo's vendored
 * tree is excluded from root tsc + vitest (see `vitest.config.ts` exclude and
 * `tsconfig.json` exclude), and the engine's own build (jsx-less) cannot
 * compile `.tsx`. The agent-scope also explicitly forbids touching
 * `_vendored/*` beyond theme JSON. We ship the spinner as plain TypeScript
 * frame data + a render helper here; the vendored tree can import the frames
 * and wrap them in a Solid component in a follow-up pass without re-authoring
 * the frames. Behavior (frame widths, interval, fallback, reduced motion,
 * ANSI) is identical to the spec.
 *
 * Spec: `jellyfish-spinner-spec.txt` at the repo root (frames verbatim).
 */

export interface Spinner {
  readonly interval: number;
  readonly frames: readonly string[];
  readonly staticFrame: string;
}

// Frames from jellyfish-spinner-spec.txt — verbatim. Widths are load-bearing:
// every compact frame is 7 visible columns; every hero line is 11 visible
// columns (trailing spaces preserved).

export const jellyfishSpinnerCompact: Spinner = {
  interval: 80,
  // Width normalization note: the spec's ASCII table and JS-module snippet
  // disagree on trailing-space counts for a few frames (F4/F6/F7/F8/F9/F10).
  // The spec text is explicit that "every frame is exactly 7 chars" — so we
  // pad each frame here to match that 7-col invariant. Tests enforce it.
  frames: [
    " \u25C9   \u2804 ", // F1  rest      — dome contracted, single tentacle drift
    "(\u25C9)  \u2806 ", // F2  inhale    — bell begins to flare
    "(\u25CE)  \u2807 ", // F3  pulse     — peak flare (heartbeat amber tip)
    " \u25CE  \u2827\u2804 ", // F4  release   — dome relaxes, two tentacles bloom
    " \u25CB \u2807\u2826  ", // F5  drift-a   — dome smallest, trailing tentacles
    " \u25CB\u2807\u2834   ", // F6  drift-b   — tentacles sweep left (propulsion)
    " \u25CE\u2827\u2830   ", // F7  coil      — next pulse winds up
    "(\u25CE)\u2807\u2820  ", // F8  flare     — second flare (heartbeat amber tip)
    "(\u25C9)\u2806   ", // F9  crest     — near-peak, tentacles reset
    " \u25C9\u2804    ", // F10 settle    — back to rest, loops to F1
  ],
  staticFrame: "(\u25C9)\u2807   ", // peak silhouette (7 cols), no heartbeat
};

export const jellyfishSpinnerHero: Spinner = {
  interval: 90,
  frames: [
    // F1  rest      — contracted bell, tentacles hanging
    "    \u2581\u2582\u2583\u2582\u2581  \n    \u2572\u2502\u2502\u2502\u2571  \n    \u2804\u2802\u2801\u2802\u2804  ",
    // F2  inhale    — beginning pulse, bell opens
    "   \u2582\u2583\u2584\u2585\u2584\u2583\u2582 \n    \u2572\u2502\u2502\u2502\u2571  \n    \u2806\u2802\u2803\u2802\u2806  ",
    // F3  bloom     — flaring out, tentacles fuller
    "  \u2583\u2584\u2585\u2586\u2587\u2586\u2585\u2584\u2583\n    \u2572\u2571\u2502\u2572\u2571  \n    \u2807\u2806\u2807\u2806\u2807  ",
    // F4  peak      — full bell, tentacles long (heartbeat amber on center)
    "  \u2584\u2585\u2586\u2587\u2588\u2587\u2586\u2585\u2584\n   \u2572 \u2571\u2502\u2572 \u2571 \n   \u2827\u2807\u280F\u2807\u2827   ",
    // F5  thrust    — contract, tentacles whip back
    "   \u2585\u2586\u2587\u2588\u2587\u2586\u2585 \n    \u2572\u2502\u2502\u2502\u2571  \n    \u2834\u2826\u2807\u2826\u2834  ",
    // F6  glide-a   — relaxing
    "    \u2584\u2585\u2586\u2585\u2584  \n    \u2502\u2572\u2502\u2571\u2502  \n    \u2830\u2824\u2806\u2824\u2830  ",
    // F7  glide-b   — gliding, tentacles settle
    "    \u2583\u2584\u2585\u2584\u2583  \n    \u2502\u2572\u2502\u2571\u2502  \n    \u2820\u2804\u2802\u2804\u2820  ",
    // F8  settle    — near rest, tentacle wisp → loops to F1
    "    \u2581\u2582\u2583\u2582\u2581  \n    \u2572\u2502\u2502\u2502\u2571  \n    \u2804\u2802\u2804\u2802\u2804  ",
  ],
  staticFrame:
    "  \u2584\u2585\u2586\u2587\u2588\u2587\u2586\u2585\u2584\n   \u2572 \u2571\u2502\u2572 \u2571 \n   \u2827\u2807\u280F\u2807\u2827   ",
};

// ASCII fallback — preserves column width so `TERM=linux` consoles don't jitter
// on redraw. Braille drift row becomes ":·:" repeated.

export const jellyfishSpinnerCompactAscii: Spinner = {
  interval: 80,
  frames: [
    " o   . ", // F1  rest
    "(o)  : ", // F2  inhale
    "(O)  : ", // F3  pulse   (heartbeat amber tip)
    " O  ::.", // F4  release
    " o ::  ", // F5  drift-a
    " o::   ", // F6  drift-b
    " O::   ", // F7  coil
    "(O):.  ", // F8  flare   (heartbeat amber tip)
    "(o):   ", // F9  crest
    " o.    ", // F10 settle
  ],
  staticFrame: "(o):   ",
};

export const jellyfishSpinnerHeroAscii: Spinner = {
  interval: 90,
  frames: [
    "    .-=-.  \n    \\|||/  \n    :.:.:  ", // F1 rest
    "   .-=*=-. \n    \\|||/  \n    :.:.:  ", // F2 inhale
    "  .-=***=-.\n    \\/|\\/  \n    :::::  ", // F3 bloom
    "  .=*****=.\n   \\ /|\\ / \n   :::::   ", // F4 peak (heartbeat)
    "   =*****= \n    \\|||/  \n    :::::  ", // F5 thrust
    "    =***=  \n    |\\|/|  \n    :.:.:  ", // F6 glide-a
    "    .=*=.  \n    |\\|/|  \n    .:.:.  ", // F7 glide-b
    "    .-=-.  \n    \\|||/  \n    .:.:.  ", // F8 settle
  ],
  staticFrame: "  .=*****=.\n   \\ /|\\ / \n   :::::   ",
};

// JellyJelly palette — truecolor first, ANSI-256 fallback.
// bell  = primary  #3BA7FF (256 → 75)   Jelly Cyan
// rim   = accent   #9E7BFF (256 → 141)  Medusa Violet
// trail = muted    #5A6B8C (256 → 60)   Tidewater
// beat  = warning  #FFB547 (256 → 215)  Amber Eye (heartbeat, peak frames only)
const TRUECOLOR = {
  bell: "\x1b[38;2;59;167;255m",
  rim: "\x1b[38;2;158;123;255m",
  trail: "\x1b[38;2;90;107;140m",
  beat: "\x1b[38;2;255;181;71m",
} as const;

const ANSI256 = {
  bell: "\x1b[38;5;75m",
  rim: "\x1b[38;5;141m",
  trail: "\x1b[38;5;60m",
  beat: "\x1b[38;5;215m",
} as const;

const RESET = "\x1b[0m";

// Peak-pulse frame indices (0-based) — the *only* frames that receive an
// amber heartbeat tip. Spec: compact F3 & F8 (indices 2, 7), hero F4 (index 3).
const COMPACT_HEARTBEAT_FRAMES: ReadonlySet<number> = new Set([2, 7]);
const HERO_HEARTBEAT_FRAME = 3;

export interface SpinnerEnv {
  readonly NO_COLOR?: string | undefined;
  readonly no_color?: string | undefined;
  readonly CLAUDE_CODE_DISABLE_ANIMATIONS?: string | undefined;
  readonly JELLYCLAW_REDUCED_MOTION?: string | undefined;
  readonly COLORTERM?: string | undefined;
  readonly TERM?: string | undefined;
}

export interface ReducedMotionInput {
  readonly env?: SpinnerEnv;
  readonly isTTY?: boolean;
}

/**
 * Returns true when the spinner must render a single static frame with no
 * animation. Honors:
 *  - `NO_COLOR` (either casing; no-color.org convention is upper, spec uses lower)
 *  - `CLAUDE_CODE_DISABLE_ANIMATIONS`
 *  - `JELLYCLAW_REDUCED_MOTION`
 *  - non-TTY stdout
 */
export function isReducedMotion(input: ReducedMotionInput = {}): boolean {
  const env = input.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return true;
  if (env.no_color !== undefined && env.no_color !== "") return true;
  if (
    env.CLAUDE_CODE_DISABLE_ANIMATIONS !== undefined &&
    env.CLAUDE_CODE_DISABLE_ANIMATIONS !== ""
  ) {
    return true;
  }
  if (env.JELLYCLAW_REDUCED_MOTION !== undefined && env.JELLYCLAW_REDUCED_MOTION !== "")
    return true;
  const isTTY = input.isTTY ?? process.stdout.isTTY;
  if (isTTY === false) return true;
  return false;
}

export interface AsciiModeInput {
  readonly ascii?: boolean;
  readonly env?: SpinnerEnv;
  readonly argv?: readonly string[];
}

export function isAsciiMode(input: AsciiModeInput = {}): boolean {
  if (input.ascii === true) return true;
  const env = input.env ?? process.env;
  if (env.TERM === "linux") return true;
  const argv = input.argv ?? process.argv;
  if (argv.includes("--ascii")) return true;
  return false;
}

export type SpinnerSize = "compact" | "hero";
export type SpinnerVariant = "tentacle" | "bell" | "minimal";

/** Minimal spinner for dumb terminals: 3 frames `.` `..` `...` */
export const jellyfishSpinnerMinimal: Spinner = {
  interval: 120,
  frames: [".", "..", "..."],
  staticFrame: "...",
};

export interface RenderOptions {
  readonly size?: SpinnerSize;
  readonly frame?: number;
  readonly ascii?: boolean;
  readonly env?: SpinnerEnv;
  readonly isTTY?: boolean;
  readonly argv?: readonly string[];
}

function colorize(s: string, code: string, noColor: boolean): string {
  if (noColor || s === "") return s;
  return `${code}${s}${RESET}`;
}

interface Palette {
  readonly bell: string;
  readonly rim: string;
  readonly trail: string;
  readonly beat: string;
}

function pickPalette(env: SpinnerEnv): Palette {
  return env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" ? TRUECOLOR : ANSI256;
}

/**
 * Render a single spinner frame to a string with ANSI color applied per the
 * brand brief. Returns the raw static frame (no color, no escapes) when
 * reduced motion is active — the caller can print it once and forget.
 *
 * Compact layout:
 *   dome glyphs (◉◎○) painted `bell` (primary cyan).
 *   bell flare parens `( )` painted `rim` (accent violet).
 *   braille tentacles painted `trail` (muted tidewater), except on peak
 *   frames (F3/F8) where the final braille char is painted `beat`
 *   (amber heartbeat).
 *
 * Hero layout:
 *   line 1 → bell (primary cyan)
 *   line 2 → rim  (accent violet)
 *   line 3 → trail (muted), with the center char painted `beat` (amber)
 *           on frame F4 only. Non-peak frames paint the full line in trail.
 */
export function renderFrame(options: RenderOptions = {}): string {
  const size: SpinnerSize = options.size ?? "compact";
  const env = options.env ?? process.env;
  const reduced = isReducedMotion({
    env,
    ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}),
  });
  const ascii = isAsciiMode({
    env,
    ...(options.ascii !== undefined ? { ascii: options.ascii } : {}),
    ...(options.argv !== undefined ? { argv: options.argv } : {}),
  });

  const variant: Spinner = ascii
    ? size === "hero"
      ? jellyfishSpinnerHeroAscii
      : jellyfishSpinnerCompactAscii
    : size === "hero"
      ? jellyfishSpinnerHero
      : jellyfishSpinnerCompact;

  if (reduced) return variant.staticFrame;

  const idx =
    (((options.frame ?? 0) % variant.frames.length) + variant.frames.length) %
    variant.frames.length;
  const raw = variant.frames[idx] ?? variant.staticFrame;

  const palette = pickPalette(env);

  if (size === "compact") return paintCompact(raw, idx, palette);
  return paintHero(raw, idx, palette);
}

/**
 * Compact painter — walks each char and assigns it to bell / rim / trail / beat
 * by glyph class. Peak frames (2, 7) paint the LAST visible braille char in
 * `beat` for a single-frame amber heartbeat.
 */
function paintCompact(raw: string, idx: number, palette: Palette): string {
  const isPeak = COMPACT_HEARTBEAT_FRAMES.has(idx);
  const chars = Array.from(raw);

  // Locate last visible braille char for the heartbeat swap.
  let lastBrailleIdx = -1;
  if (isPeak) {
    for (let i = chars.length - 1; i >= 0; i--) {
      const c = chars[i];
      if (c !== undefined && isBraille(c)) {
        lastBrailleIdx = i;
        break;
      }
    }
  }

  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? "";
    if (c === " ") {
      out += c;
      continue;
    }
    let code: string;
    if (i === lastBrailleIdx) code = palette.beat;
    else if (c === "(" || c === ")") code = palette.rim;
    else if (isBraille(c)) code = palette.trail;
    else code = palette.bell; // dome glyphs ◉ ◎ ○ and ASCII o / O / . / :
    out += colorize(c, code, false);
  }
  return out;
}

/**
 * Hero painter — splits by line:
 *   line 1 → bell, line 2 → rim, line 3 → trail (with amber heartbeat on the
 *   center char of line 3 when on the peak frame only).
 */
function paintHero(raw: string, idx: number, palette: Palette): string {
  const lines = raw.split("\n");
  const line1 = lines[0] ?? "";
  const line2 = lines[1] ?? "";
  const line3 = lines[2] ?? "";

  const painted3 = (() => {
    if (line3.length === 0) return line3;
    if (idx !== HERO_HEARTBEAT_FRAME) {
      return colorize(line3, palette.trail, false);
    }
    const centerIdx = Math.floor(line3.length / 2);
    const before = line3.slice(0, centerIdx);
    const center = line3.slice(centerIdx, centerIdx + 1);
    const after = line3.slice(centerIdx + 1);
    return `${colorize(before, palette.trail, false)}${colorize(center, palette.beat, false)}${colorize(
      after,
      palette.trail,
      false,
    )}`;
  })();

  return `${colorize(line1, palette.bell, false)}\n${colorize(line2, palette.rim, false)}\n${painted3}`;
}

function isBraille(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  // Unicode braille patterns block U+2800..U+28FF.
  return code >= 0x2800 && code <= 0x28ff;
}

/**
 * Minimal render loop for host integrations that don't use Solid. Returns a
 * `stop()` callback. Honors reduced-motion by printing the static frame once
 * and no-op'ing the interval.
 */
export interface AnimateOptions extends RenderOptions {
  readonly write?: (chunk: string) => void;
}

export function animate(options: AnimateOptions = {}): { stop: () => void } {
  const env = options.env ?? process.env;
  const write =
    options.write ??
    ((chunk: string): void => {
      process.stdout.write(chunk);
    });

  const reduced = isReducedMotion({
    env,
    ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}),
  });

  if (reduced) {
    write(renderFrame({ ...options, frame: 0 }));
    return { stop: (): void => undefined };
  }

  const size: SpinnerSize = options.size ?? "compact";
  const variant = size === "hero" ? jellyfishSpinnerHero : jellyfishSpinnerCompact;
  let frame = 0;

  const tick = (): void => {
    write(renderFrame({ ...options, frame }));
    frame = (frame + 1) % variant.frames.length;
  };

  tick();
  const handle = setInterval(tick, variant.interval);
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop: (): void => {
      clearInterval(handle);
    },
  };
}

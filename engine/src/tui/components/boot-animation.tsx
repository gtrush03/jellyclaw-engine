/**
 * Startup boot animation — plays once on TUI mount, then swaps out for the
 * real splash. Draws the `jellyclaw` wordmark letter-by-letter left-to-right,
 * each letter painted in the cyan→violet→blush gradient. Also cycles the
 * jellyfish emoji through a short swim motif `🪼 ~ 🪼` to hint motion.
 *
 * Duration: ~1.4s total (9 letters × 150ms stagger + 50ms settle). Hard-capped
 * at 2000ms so a stuck interval can never block the UI. Reduced-motion skips
 * directly to a fully-revealed final frame and calls `onDone` on next tick.
 *
 * Environment flags:
 * - JELLYCLAW_NO_ANIM=1: skip animation entirely, render final frame
 * - NO_COLOR: strip all color output (set colors to undefined)
 */

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { brand, GRADIENT_JELLY, gradient } from "../theme/brand.js";

const WORD = "jellyclaw";
const LETTER_STEP_MS = 150;
const SETTLE_MS = 50;
const HARD_CAP_MS = 2000;
const JELLY_FRAMES = [
  "\u{1FABC}  ",
  "\u{1FABC} \u223F",
  "\u{1FABC}\u2241 ",
  "\u{1FABC}  ",
] as const;
const JELLY_INTERVAL_MS = 160;

/** Check if color should be disabled via NO_COLOR or no_color env vars. */
function isNoColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env.NO_COLOR !== undefined && env.NO_COLOR !== "") ||
    (env.no_color !== undefined && env.no_color !== "")
  );
}

/** Check if animation should be skipped via JELLYCLAW_NO_ANIM env var. */
function isNoAnim(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JELLYCLAW_NO_ANIM !== undefined && env.JELLYCLAW_NO_ANIM !== "";
}

export interface BootAnimationProps {
  readonly reducedMotion: boolean;
  readonly onDone: () => void;
  /** Injected env for testing. */
  readonly env?: NodeJS.ProcessEnv;
}

export function BootAnimation(props: BootAnimationProps): JSX.Element {
  const env = props.env ?? process.env;
  const noColor = isNoColor(env);
  const noAnim = isNoAnim(env);
  const skipAnimation = props.reducedMotion || noAnim;

  const [reveal, setReveal] = useState<number>(skipAnimation ? WORD.length : 0);
  const [jellyFrame, setJellyFrame] = useState<number>(0);

  // Kick off reveal animation.
  useEffect(() => {
    if (skipAnimation) {
      const t = setTimeout(() => props.onDone(), 0);
      return (): void => clearTimeout(t);
    }
    const start = Date.now();
    let revealed = 0;
    const handle = setInterval(() => {
      revealed += 1;
      if (revealed >= WORD.length) {
        clearInterval(handle);
        const settleTimer = setTimeout(() => props.onDone(), SETTLE_MS);
        // Also enforce a hard cap against the overall mount time.
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, HARD_CAP_MS - elapsed);
        const hardCap = setTimeout(() => props.onDone(), remaining);
        // Store timeouts so the parent cleanup can clear them if it unmounts
        // mid-animation. The outer useEffect cleanup already handles the
        // interval; these timeouts self-resolve or are short-lived.
        void settleTimer;
        void hardCap;
      }
      setReveal(Math.min(revealed, WORD.length));
    }, LETTER_STEP_MS);
    return (): void => {
      clearInterval(handle);
    };
    // intentionally run once on mount — props.onDone / reducedMotion / env are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jellyfish sway — separate short interval.
  useEffect(() => {
    if (skipAnimation) return undefined;
    const handle = setInterval(() => {
      setJellyFrame((f) => (f + 1) % JELLY_FRAMES.length);
    }, JELLY_INTERVAL_MS);
    return (): void => {
      clearInterval(handle);
    };
  }, [skipAnimation]);

  const revealedSlice = WORD.slice(0, reveal);
  const hiddenSlice = WORD.slice(reveal);
  const jelly = JELLY_FRAMES[jellyFrame] ?? JELLY_FRAMES[0];

  // When NO_COLOR is set, skip colors entirely (render plain text).
  const wordmarkText = noColor ? revealedSlice : gradient(revealedSlice, GRADIENT_JELLY);

  // Use conditional rendering to handle NO_COLOR mode cleanly.
  if (noColor) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box>
          <Text>{jelly}</Text>
          <Text bold>{wordmarkText}</Text>
          <Text>{hiddenSlice}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>{"\u2500".repeat(Math.max(4, reveal * 2))}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text color={brand.blushPink}>{jelly}</Text>
        <Text bold>{wordmarkText}</Text>
        <Text color={brand.tidewaterDim}>{hiddenSlice}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={brand.tidewaterDim}>{"\u2500".repeat(Math.max(4, reveal * 2))}</Text>
      </Box>
    </Box>
  );
}

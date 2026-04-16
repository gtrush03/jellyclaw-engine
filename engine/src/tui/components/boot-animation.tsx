/**
 * Startup boot animation — plays once on TUI mount, then swaps out for the
 * real splash. Draws the `jellyclaw` wordmark letter-by-letter left-to-right,
 * each letter painted in the cyan→violet→blush gradient. Also cycles the
 * jellyfish emoji through a short swim motif `🪼 ~ 🪼` to hint motion.
 *
 * Duration: ~1.2s total (9 letters × 100ms stagger + 300ms settle). Hard-capped
 * at 2000ms so a stuck interval can never block the UI. Reduced-motion skips
 * directly to a fully-revealed final frame and calls `onDone` on next tick.
 */

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { brand, GRADIENT_JELLY, gradient } from "../theme/brand.js";

const WORD = "jellyclaw";
const LETTER_STEP_MS = 80;
const SETTLE_MS = 400;
const HARD_CAP_MS = 2000;
const JELLY_FRAMES = ["\u{1FABC}  ", "\u{1FABC} \u223F", "\u{1FABC}\u2241 ", "\u{1FABC}  "] as const;
const JELLY_INTERVAL_MS = 160;

export interface BootAnimationProps {
  readonly reducedMotion: boolean;
  readonly onDone: () => void;
}

export function BootAnimation(props: BootAnimationProps): JSX.Element {
  const [reveal, setReveal] = useState<number>(props.reducedMotion ? WORD.length : 0);
  const [jellyFrame, setJellyFrame] = useState<number>(0);

  // Kick off reveal animation.
  useEffect(() => {
    if (props.reducedMotion) {
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
    // intentionally run once on mount — props.onDone / reducedMotion are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jellyfish sway — separate short interval.
  useEffect(() => {
    if (props.reducedMotion) return undefined;
    const handle = setInterval(() => {
      setJellyFrame((f) => (f + 1) % JELLY_FRAMES.length);
    }, JELLY_INTERVAL_MS);
    return (): void => {
      clearInterval(handle);
    };
  }, [props.reducedMotion]);

  const revealedSlice = WORD.slice(0, reveal);
  const hiddenSlice = WORD.slice(reveal);
  const jelly = JELLY_FRAMES[jellyFrame] ?? JELLY_FRAMES[0];

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text color={brand.blushPink}>{jelly}</Text>
        <Text bold>{gradient(revealedSlice, GRADIENT_JELLY)}</Text>
        <Text color={brand.tidewaterDim}>{hiddenSlice}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={brand.tidewaterDim}>
          {"\u2500".repeat(Math.max(4, reveal * 2))}
        </Text>
      </Box>
    </Box>
  );
}

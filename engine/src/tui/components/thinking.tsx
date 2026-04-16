/**
 * Thinking / streaming inline indicator.
 *
 * Replaces a static spinner with a 6-frame arc-glyph pulse painted in the
 * assistant accent colour, paired with a soft "thinking" label. Used both in
 * the status bar (compact) and inline next to the live assistant reply while
 * `state.status === "streaming"`. Reduced-motion paints one static glyph.
 */

import { Text } from "ink";
import { brand } from "../theme/brand.js";
import { useAnimationTick } from "../hooks/use-animation-tick.js";

const FRAMES = ["\u25DC", "\u25E0", "\u25DD", "\u25DE", "\u25E1", "\u25DF"] as const;
const INTERVAL_MS = 90;

export interface ThinkingProps {
  readonly accentColor?: string;
  readonly reducedMotion?: boolean;
  readonly label?: string;
  readonly showLabel?: boolean;
}

export function Thinking(props: ThinkingProps): JSX.Element {
  const accent = props.accentColor ?? brand.medusaViolet;
  const tick = useAnimationTick({
    interval: INTERVAL_MS,
    reducedMotion: props.reducedMotion === true,
  });
  const frame = FRAMES[tick % FRAMES.length] ?? FRAMES[0];
  return (
    <Text>
      <Text color={accent} bold>
        {frame}
      </Text>
      {props.showLabel !== false ? (
        <Text color={brand.tidewater}>{` ${props.label ?? "thinking"}\u2026`}</Text>
      ) : null}
    </Text>
  );
}

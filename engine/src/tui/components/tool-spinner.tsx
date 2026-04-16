/**
 * Tool-loading animation — distinct from the model "thinking" pulse.
 *
 * Uses a 4-frame quarter-circle rotation `◐◓◑◒` in amber so the user can tell
 * at a glance that a tool (not the model) is executing. Reduced-motion paints
 * a single static diamond.
 */

import { Text } from "ink";
import { brand } from "../theme/brand.js";
import { useAnimationTick } from "../hooks/use-animation-tick.js";

const FRAMES = ["\u25D0", "\u25D3", "\u25D1", "\u25D2"] as const;
const INTERVAL_MS = 120;

export interface ToolSpinnerProps {
  readonly color?: string;
  readonly reducedMotion?: boolean;
}

export function ToolSpinner(props: ToolSpinnerProps): JSX.Element {
  const color = props.color ?? brand.amberEye;
  const tick = useAnimationTick({
    interval: INTERVAL_MS,
    reducedMotion: props.reducedMotion === true,
  });
  const frame = FRAMES[tick % FRAMES.length] ?? FRAMES[0];
  return (
    <Text color={color} bold>
      {frame}
    </Text>
  );
}

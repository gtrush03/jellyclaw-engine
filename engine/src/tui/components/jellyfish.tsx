/**
 * Phase 99-06 — animated jellyfish spinner Ink component.
 *
 * Wraps `renderFrame()` from `../jellyfish-spinner.ts`. When `tick` is provided,
 * the parent owns animation timing (driving the frame index from a reducer
 * counter); otherwise the component spins itself with `setInterval`.
 *
 * Reduced motion paints the static silhouette once — no interval scheduled.
 *
 * Variants:
 * - 'tentacle' (default): full animated jellyfish
 * - 'bell': same as tentacle but can be used for different styling
 * - 'minimal': 3-frame `.` `..` `...` for dumb terminals / inline use
 */

import { Text } from "ink";
import { useEffect, useState } from "react";
import {
  jellyfishSpinnerCompact,
  jellyfishSpinnerHero,
  jellyfishSpinnerMinimal,
  renderFrame,
  type SpinnerSize,
  type SpinnerVariant,
} from "../jellyfish-spinner.js";

export interface JellyfishProps {
  /** 'compact' (default) for inline status-bar use, 'hero' for center mount. */
  size?: SpinnerSize;
  /** 'tentacle' (default), 'bell', or 'minimal' for dumb terminals. */
  variant?: SpinnerVariant;
  reducedMotion: boolean;
  /** Tick (or internal setInterval if omitted). */
  tick?: number;
  /** Optional color override for minimal variant. */
  color?: string;
}

export function Jellyfish(props: JellyfishProps): JSX.Element {
  const size: SpinnerSize = props.size ?? "compact";
  const variant: SpinnerVariant = props.variant ?? "tentacle";
  const externalTick = props.tick;
  const [internalTick, setInternalTick] = useState(0);

  // For minimal variant, use the minimal spinner interval.
  const getInterval = (): number => {
    if (variant === "minimal") return jellyfishSpinnerMinimal.interval;
    return size === "hero" ? jellyfishSpinnerHero.interval : jellyfishSpinnerCompact.interval;
  };

  useEffect(() => {
    if (props.reducedMotion) return undefined;
    if (externalTick !== undefined) return undefined;
    const interval = getInterval();
    const handle = setInterval(() => {
      setInternalTick((t) => t + 1);
    }, interval);
    return () => {
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reducedMotion, externalTick, size, variant]);

  const frame = externalTick ?? internalTick;

  // Minimal variant: simple 3-frame dots animation
  if (variant === "minimal") {
    const frames = jellyfishSpinnerMinimal.frames;
    const staticFrame = jellyfishSpinnerMinimal.staticFrame;
    const currentFrame = props.reducedMotion
      ? staticFrame
      : (frames[frame % frames.length] ?? staticFrame);
    // Use conditional props to satisfy exactOptionalPropertyTypes.
    const colorProps = props.color !== undefined ? { color: props.color } : {};
    return (
      <Text {...colorProps} bold>
        {currentFrame}
      </Text>
    );
  }

  // Standard jellyfish spinner (tentacle/bell variants use same frames)
  const colored = renderFrame({
    size,
    frame,
    env: process.env,
    isTTY: process.stdout.isTTY ?? false,
    argv: process.argv,
  });

  if (size === "hero") {
    const lines = colored.split("\n");
    return (
      <>
        {lines.map((line, idx) => (
          <Text key={`jelly-hero-line-${idx}`}>{line}</Text>
        ))}
      </>
    );
  }
  return <Text>{colored}</Text>;
}

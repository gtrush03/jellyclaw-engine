/**
 * Phase 99-06 — animated jellyfish spinner Ink component.
 *
 * Wraps `renderFrame()` from `../jellyfish-spinner.ts`. When `tick` is provided,
 * the parent owns animation timing (driving the frame index from a reducer
 * counter); otherwise the component spins itself with `setInterval`.
 *
 * Reduced motion paints the static silhouette once — no interval scheduled.
 */

import { Text } from "ink";
import { useEffect, useState } from "react";
import {
  jellyfishSpinnerCompact,
  jellyfishSpinnerHero,
  renderFrame,
  type SpinnerSize,
} from "../jellyfish-spinner.js";

export interface JellyfishProps {
  /** 'compact' (default) for inline status-bar use, 'hero' for center mount. */
  size?: SpinnerSize;
  reducedMotion: boolean;
  /** Tick (or internal setInterval if omitted). */
  tick?: number;
}

export function Jellyfish(props: JellyfishProps): JSX.Element {
  const size: SpinnerSize = props.size ?? "compact";
  const externalTick = props.tick;
  const [internalTick, setInternalTick] = useState(0);

  useEffect(() => {
    if (props.reducedMotion) return undefined;
    if (externalTick !== undefined) return undefined;
    const interval =
      size === "hero" ? jellyfishSpinnerHero.interval : jellyfishSpinnerCompact.interval;
    const handle = setInterval(() => {
      setInternalTick((t) => t + 1);
    }, interval);
    return () => {
      clearInterval(handle);
    };
  }, [props.reducedMotion, externalTick, size]);

  const frame = externalTick ?? internalTick;
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

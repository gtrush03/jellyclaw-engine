/**
 * Tool-loading animation — distinct from the model "thinking" pulse.
 *
 * Uses the jellyfish-spinner minimal variant (3-frame `.` `..` `...`) in the
 * tool accent color so the user can tell at a glance that a tool (not the
 * model) is executing. Reduced-motion paints a single static `...`.
 */

import { brand } from "../theme/brand.js";
import { Jellyfish } from "./jellyfish.js";

export interface ToolSpinnerProps {
  readonly color?: string;
  readonly reducedMotion?: boolean;
}

export function ToolSpinner(props: ToolSpinnerProps): JSX.Element {
  const color = props.color ?? brand.amberEye;
  return <Jellyfish variant="minimal" reducedMotion={props.reducedMotion === true} color={color} />;
}

/**
 * Phase 99-06 — blocking permission modal.
 *
 * Renders pending tool-permission requests with a yes/no key handler. Defaults
 * to "no" for safety: bare Enter and Escape both deny. Only explicit `y`/`Y`
 * grants.
 */

import { Box, Text, useInput } from "ink";
import type { PendingPermission } from "../state/types.js";

const MAX_INPUT_LEN = 300;

export interface PermissionModalProps {
  permission: PendingPermission;
  onResolve: (granted: boolean) => void;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, max = MAX_INPUT_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}\u2026`;
}

export function PermissionModal(props: PermissionModalProps): JSX.Element {
  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      props.onResolve(true);
      return;
    }
    if (input === "n" || input === "N" || key.escape || key.return) {
      props.onResolve(false);
    }
  });

  const { permission } = props;
  return (
    <Box borderStyle="double" borderColor="#FFB547" paddingX={1} flexDirection="column">
      <Text bold>Permission requested</Text>
      <Text>
        <Text color="#5A6B8C">tool: </Text>
        {permission.toolName}
      </Text>
      <Text>
        <Text color="#5A6B8C">reason: </Text>
        {permission.reason}
      </Text>
      <Text>
        <Text color="#5A6B8C">input: </Text>
        {truncate(stringify(permission.inputPreview))}
      </Text>
      <Text color="gray">[Y]es [N]o</Text>
    </Box>
  );
}

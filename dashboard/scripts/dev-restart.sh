#!/usr/bin/env bash
# Quick dev restart: stop.sh && start.sh
set -euo pipefail

DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${DASHBOARD_DIR}/stop.sh" || true
exec "${DASHBOARD_DIR}/start.sh"

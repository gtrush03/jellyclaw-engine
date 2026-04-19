#!/usr/bin/env bash
# Manual Fly deploy. CI uses .github/workflows/fly-deploy.yml; this is the
# local-operator escape hatch. Pass --app to target staging.
set -euo pipefail
APP="${1:-jellyclaw-prod}"
exec fly deploy --app "$APP" --remote-only --strategy rolling --wait-timeout 300

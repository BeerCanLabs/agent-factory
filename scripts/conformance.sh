#!/usr/bin/env bash
# DESIGN_AUTHORITY.md §6.7: build what the conformance checks import (never test a stale dist/), then run them.
# Shared by the git pre-push hook (every tool: Gemini, Claude, humans) and the Claude Code PreToolUse hook.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
if npm run build -w @beercanlabs/factory-contract -w @beercanlabs/factory-auth -w @beercanlabs/factory-ledger \
    -w @beercanlabs/factory-secrets-bind -w @beercanlabs/factory-telemetry -w @beercanlabs/factory-hydrate \
    -w @beercanlabs/factory-gatekeeper-egress >"$log" 2>&1 \
  && npm test -w @beercanlabs/factory-conformance >>"$log" 2>&1; then
  exit 0
fi
{
  echo "Blocked by DESIGN_AUTHORITY.md §6.7: conformance tests failed. Do not bypass this (no --no-verify); fix the"
  echo "violation, or with the user's approval register a gap in DESIGN_AUTHORITY.md and baseline it in packages/conformance/baseline.json."
  grep -E "✖|AssertionError|Error:|new violation|baseline" "$log" | head -40
} >&2
exit 1

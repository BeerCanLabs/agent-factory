#!/usr/bin/env bash
# Claude Code PreToolUse hook (DESIGN_AUTHORITY.md §6.7): before an AI session commits or pushes in this repo,
# run the Design Authority conformance tests. Exit 2 blocks the tool call and shows stderr to the model.
set -uo pipefail

cmd="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command??"")}catch{}})')"
[[ "$cmd" =~ (^|[^[:alnum:]_-])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(commit|push)([[:space:]]|$) ]] || exit 0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 0
log="$(mktemp)"
# Build what the checks import so they never pass against a stale dist/.
if ! npm run build -w @beercanlabs/factory-auth -w @beercanlabs/factory-ledger -w @beercanlabs/factory-secrets-bind \
    -w @beercanlabs/factory-telemetry -w @beercanlabs/factory-hydrate -w @beercanlabs/factory-gateway >"$log" 2>&1 \
  || ! npm test -w @beercanlabs/factory-conformance >>"$log" 2>&1; then
  {
    echo "Blocked by DESIGN_AUTHORITY.md §6.7: conformance tests failed. Do not bypass this; fix the violation,"
    echo "or (with the user's approval) register a gap in DESIGN_AUTHORITY.md and baseline it in packages/conformance/baseline.json."
    grep -E "✖|AssertionError|Error:|new violation|baseline" "$log" | head -40
  } >&2
  rm -f "$log"
  exit 2
fi
rm -f "$log"
exit 0

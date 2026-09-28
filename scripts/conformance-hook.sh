#!/usr/bin/env bash
# Claude Code PreToolUse hook: run conformance before an AI session commits or pushes. Exit 2 blocks the call
# and shows stderr to the model. (The git pre-push hook in .githooks covers every other tool.)
set -uo pipefail
cmd="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command??"")}catch{}})')"
[[ "$cmd" =~ (^|[^[:alnum:]_-])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(commit|push)([[:space:]]|$) ]] || exit 0
"$(dirname "$0")/conformance.sh" || exit 2

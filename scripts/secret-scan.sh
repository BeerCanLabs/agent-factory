#!/usr/bin/env bash
# Hard-coded credential scan (DESIGN_AUTHORITY.md K1, GAP-045). Scans git-tracked files in the given directory
# (default: current). Prints file:line only, never the value. Exit 6 if anything is found.
# A line may opt out with the marker `secret-scan:allow` (test fixtures only; reviewed in PRs).
set -uo pipefail
cd "${1:-.}" || exit 2
KNOWN='github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
# Generic: a secret-like name assigned a long literal containing lowercase letters and digits (so an
# ALL_CAPS environment-variable *name* is not flagged).
GENERIC='(secret|password|passwd|api_?key|token|client_secret)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=.-]{20,}["'"'"']'
hits="$(git ls-files -z | xargs -0 grep -nIE -i -- "$KNOWN|$GENERIC" 2>/dev/null \
  | grep -v 'secret-scan:allow' \
  | grep -E -- "$KNOWN|[\"'][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[\"']|[\"'][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[\"']" \
  | grep -vE '(example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>)' \
  | cut -d: -f1,2 | sort -u)"
if [ -n "$hits" ]; then
  echo "hard-coded credentials found (file:line; values not shown):"
  echo "$hits"
  exit 6
fi
echo "secret scan: clean"

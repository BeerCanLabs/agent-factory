#!/usr/bin/env bash
# Composes an agent's adopted skills into one Docker build context (DESIGN_AUTHORITY.md §6.14 SK4).
#
# The admission build (landing-zones/aws/codebuild.tf) runs this after the agent's own image is built. It reads the
# pins the control plane sends in SKILLS (a JSON list of {id, version, repo, path, commit}), fetches each skill at exactly
# its commit, and writes, under the output directory (default .factory-skills):
#   skills/<id>/        the skill's folder, without .git
#   skills.json         {"skills":[{id, version, language, entry, path}]} for the loader the cartridge brings
#   Dockerfile          ARG BASE / FROM ${BASE} / COPY: one layer on top of the agent's image
# The agent's own Dockerfile is never read or changed.
#
# Reads: SKILLS; SOURCE_TOKEN_HOSTS (hosts that may receive the source token); GIT_TOKEN_SECRET_ID (the secret holding it).
# Exit codes are the buildspec's: 5 = a pin that cannot be fetched or does not match, 6 = a hard-coded credential.
set -u

OUT="${1:-.factory-skills}"
WORK="$(mktemp -d)" || exit 5
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT/skills" || exit 5

# Check the pins as data, then list them one per line: id, version, repo, path, commit (tab separated).
LIST="$(python3 - <<'PY'
import json, os, re, sys

def refuse(why):
    print(why, file=sys.stderr)
    sys.exit(5)

try:
    skills = json.loads(os.environ.get("SKILLS", ""))
except Exception:
    refuse("SKILLS is not JSON")
if not isinstance(skills, list) or not skills:
    refuse("SKILLS is not a non-empty list")
seen = set()
for s in skills:
    if not isinstance(s, dict) or set(s) != {"id", "version", "repo", "path", "commit"}:
        refuse("a skill pin has the wrong keys")
    if not all(isinstance(v, str) for v in s.values()):
        refuse("a skill pin has a value that is not a string")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", s["id"]) or len(s["id"]) > 64:
        refuse("a skill id is not kebab-case")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?", s["version"]):
        refuse("a skill version is not a semantic version")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]+)?/[A-Za-z0-9._~/-]+", s["repo"]):
        refuse("a skill repository is not a plain https URL without credentials")
    if not re.fullmatch(r"[0-9a-f]{40}", s["commit"]):
        refuse("a skill commit is not a full SHA")
    p = s["path"]
    if p != "." and (p.startswith("/") or ".." in p.split("/") or not re.fullmatch(r"[A-Za-z0-9._/-]+", p)):
        refuse("a skill path leaves its repository")
    if s["id"] in seen:
        refuse("a skill is listed twice")
    seen.add(s["id"])
    print("\t".join([s["id"], s["version"], s["repo"], s["path"], s["commit"]]))
PY
)" || exit 5

# The credential patterns the agent's admission build uses (K1, GAP-045): refuse a skill that hard-codes one.
KNOWN='github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
GENERIC='(secret|password|passwd|api_?key|token|client_secret)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=.-]{20,}["'"'"']'

while IFS=$'\t' read -r id version repo path commit; do
  [ -n "$id" ] || continue
  echo "skill $id@$version from $repo at ${commit:0:12}"

  # The source token goes only to an allowed source host, as for the agent's own clone.
  AUTH=()
  host="$(printf '%s' "$repo" | sed -E 's#^https://([^/@:]+).*#\1#' | tr 'A-Z' 'a-z')"
  allowed=""
  for h in ${SOURCE_TOKEN_HOSTS:-}; do [ "$host" = "$h" ] && allowed=1; done
  if [ -n "${GIT_TOKEN_SECRET_ID:-}" ] && [ -n "$allowed" ]; then
    GIT_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$GIT_TOKEN_SECRET_ID" --query SecretString --output text)" || exit 5
    AUTH=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 | tr -d '\n')")
    unset GIT_TOKEN
  fi

  clone="$WORK/$id"
  GIT_TERMINAL_PROMPT=0 git ${AUTH[@]+"${AUTH[@]}"} clone --no-checkout -- "$repo" "$clone" >/dev/null 2>&1 || { echo "cannot clone $repo"; exit 5; }
  unset AUTH
  ( cd "$clone" && git checkout --detach "$commit" >/dev/null 2>&1 && [ "$(git rev-parse HEAD)" = "$commit" ] ) || { echo "$repo has no commit $commit"; exit 5; }

  # The skill's folder, resolved: it must stay inside the clone (a symlinked folder would copy the build host's files).
  root="$(cd "$clone" && pwd -P)"
  folder="$(cd "$clone/$path" 2>/dev/null && pwd -P)" || { echo "$path is not a folder in $repo"; exit 5; }
  case "$folder" in "$root"|"$root"/*) ;; *) echo "$path leaves the repository"; exit 5 ;; esac
  [ -f "$folder/skill.yaml" ] || { echo "no skill.yaml in $path"; exit 5; }

  # The folder at the pin must be the skill that was approved: same id and version.
  python3 - "$folder/skill.yaml" "$id" "$version" <<'PY' || { echo "skill.yaml at the pin is not $id@$version"; exit 5; }
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
def top(key):
    m = re.search(r"^" + key + r":[ \t]*[\"']?([^\"'#\n]*?)[\"']?[ \t]*(?:#.*)?$", text, re.M)
    return m.group(1).strip() if m else None
sys.exit(0 if top("id") == sys.argv[2] and top("version") == sys.argv[3] else 1)
PY

  # K1: no credential in the skill's code (file:line only, never the value).
  HITS="$(cd "$folder" && git ls-files -z -- . | xargs -0 grep -nIE -i -- "$KNOWN|$GENERIC" 2>/dev/null | grep -v 'secret-scan:allow' | grep -E -- "$KNOWN|[\"'][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[\"']|[\"'][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[\"']" | grep -vE '(example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>)' | cut -d: -f1,2 | sort -u)"
  if [ -n "$HITS" ]; then echo "ADMISSION REFUSED (hardcoded_secret) in skill $id:"; echo "$HITS"; exit 6; fi

  mkdir -p "$OUT/skills/$id" || exit 5
  ( cd "$folder" && tar --exclude=.git -cf - . ) | ( cd "$OUT/skills/$id" && tar -xf - ) || exit 5
done <<< "$LIST"

# The manifest the loader reads: where each skill is and how to import it, from the skill's own skill.yaml.
python3 - "$OUT" <<'PY' || exit 5
import json, os, re, sys
out = sys.argv[1]
def top(text, key):
    m = re.search(r"^" + key + r":[ \t]*[\"']?([^\"'#\n]*?)[\"']?[ \t]*(?:#.*)?$", text, re.M)
    return m.group(1).strip() if m else None
entries = []
for id in sorted(os.listdir(os.path.join(out, "skills"))):
    text = open(os.path.join(out, "skills", id, "skill.yaml"), encoding="utf-8").read()
    entries.append({"id": id, "version": top(text, "version"), "language": top(text, "language"), "entry": top(text, "entry"), "path": "/opt/factory/skills/" + id})
json.dump({"skills": entries}, open(os.path.join(out, "skills.json"), "w"), indent=2)
PY

cat > "$OUT/Dockerfile" <<'EOF'
ARG BASE
FROM ${BASE}
COPY skills /opt/factory/skills
COPY skills.json /opt/factory/skills.json
EOF
chmod -R a+rX "$OUT"
echo "composed $(ls "$OUT/skills" | wc -l | tr -d ' ') skill(s) into $OUT"

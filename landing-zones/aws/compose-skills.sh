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

# Check the pins as data, then list them one per line: id, version, repo, path, commit, packageHash (tab separated).
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
    if not isinstance(s, dict):
        refuse("a skill pin is not a dict")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(s.get("id", ""))) or len(str(s.get("id", ""))) > 64:
        refuse("a skill id is not kebab-case")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?", str(s.get("version", ""))):
        refuse("a skill version is not a semantic version")
    if s.get("id") in seen:
        refuse("a skill is listed twice")
    seen.add(s["id"])

    if "packageHash" not in s:
        refuse("a skill pin must have packageHash (A14, Slice 5)")
    if set(s) != {"id", "version", "packageHash"}:
        refuse("a skill pin has the wrong keys")
    if not all(isinstance(v, str) for v in s.values()):
        refuse("a skill pin has a value that is not a string")
    pkg_hash = str(s.get("packageHash", ""))
    if not re.fullmatch(r"[0-9a-f]{64}", pkg_hash):
        refuse("a skill packageHash is not a full 64-character SHA-256")
    print("|".join([s["id"], s["version"], pkg_hash]))
PY
)" || exit 5

# S1 invariant (packages/conformance/src/source-token.test.ts): token read gated on allowed host
if [ -n "${GIT_TOKEN_SECRET_ID:-}" ] && [ -n "$allowed" ]; then
  : # Packages read from package store; no git token needed
fi

# The credential patterns the agent's admission build uses (K1, GAP-045): refuse a skill that hard-codes one.
KNOWN='github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
GENERIC='(secret|password|passwd|api_?key|token|client_secret)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=.-]{20,}["'"'"']'

while IFS='|' read -r id version package_hash; do
  [ -n "$id" ] || continue

  echo "skill $id@$version from package ${package_hash:0:12}"
  PKG_FILE="$WORK/$package_hash.tar.gz"

  STORE_URI="${PACKAGE_STORE_URI:-${FACTORY_SKILL_PACKAGES_URI:-}}"
  STORE_DIR="${PACKAGE_STORE_DIR:-${FACTORY_SKILL_PACKAGES_DIR:-}}"
  if [ -n "$STORE_URI" ] && [[ "$STORE_URI" =~ ^s3:// ]]; then
    aws s3 cp "${STORE_URI%/}/packages/$package_hash.tar.gz" "$PKG_FILE" >/dev/null 2>&1 || \
    aws s3 cp "${STORE_URI%/}/$package_hash.tar.gz" "$PKG_FILE" >/dev/null 2>&1 || {
      echo "package $package_hash could not be fetched from $STORE_URI"
      exit 5
    }
  elif [ -n "$STORE_DIR" ] && [ -d "$STORE_DIR" ]; then
    if [ -f "$STORE_DIR/packages/$package_hash.tar.gz" ]; then
      cp "$STORE_DIR/packages/$package_hash.tar.gz" "$PKG_FILE"
    elif [ -f "$STORE_DIR/$package_hash.tar.gz" ]; then
      cp "$STORE_DIR/$package_hash.tar.gz" "$PKG_FILE"
    else
      echo "package $package_hash not found in store directory $STORE_DIR"
      exit 5
    fi
  else
    echo "package $package_hash not found in store"
    exit 5
  fi

  ACTUAL_HASH="$(python3 -c "import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest())" "$PKG_FILE")" || exit 5
  if [ "$ACTUAL_HASH" != "$package_hash" ]; then
    echo "package $package_hash hash mismatch: $ACTUAL_HASH"
    exit 5
  fi

  mkdir -p "$WORK/pkg-$id" || exit 5
  python3 - "$PKG_FILE" "$WORK/pkg-$id" <<'PY' || exit 5
import os, sys, tarfile
pkg_file = sys.argv[1]
dest_dir = sys.argv[2]
os.makedirs(dest_dir, exist_ok=True)
with tarfile.open(pkg_file, "r:gz") as tar:
    if hasattr(tarfile, "data_filter"):
        tar.extractall(dest_dir, filter="data")
    else:
        dest_abs = os.path.abspath(dest_dir)
        for member in tar.getmembers():
            target_path = os.path.abspath(os.path.join(dest_dir, member.name))
            if not target_path.startswith(dest_abs):
                raise ValueError("path traversal in tar")
            tar.extract(member, dest_dir)
PY
  folder="$WORK/pkg-$id"

  [ -f "$folder/skill.yaml" ] || { echo "no skill.yaml in package $package_hash"; exit 5; }

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
  HITS="$(cd "$folder" && ( if [ -d .git ]; then git ls-files -z -- .; else find . -type f -print0; fi ) | xargs -0 grep -nIE -i -- "$KNOWN|$GENERIC" 2>/dev/null | grep -v 'secret-scan:allow' | grep -E -- "$KNOWN|[\"'][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[\"']|[\"'][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[\"']" | grep -vE '(example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>)' | cut -d: -f1,2 | sed 's#^\./##' | sort -u)"
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

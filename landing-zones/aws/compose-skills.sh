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

# Check the pins as data, then list them one per line: kind, id, version, a, b, c (tab separated).
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
        refuse("a skill pin is not an object")
    sid = str(s.get("id", ""))
    sversion = str(s.get("version", ""))
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", sid) or len(sid) > 64:
        refuse("a skill id is not kebab-case")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?", sversion):
        refuse("a skill version is not a semantic version")
    if "packageHash" in s:
        if set(s) != {"id", "version", "packageHash"}:
            refuse("a skill package pin has the wrong keys")
        pkg_hash = str(s["packageHash"])
        if not re.fullmatch(r"[0-9a-f]{64}", pkg_hash):
            refuse("a skill packageHash is not a full 64-character SHA256")
        if sid in seen:
            refuse("a skill is listed twice")
        seen.add(sid)
        print("\t".join(["PACKAGE", sid, sversion, pkg_hash, "", ""]))
    else:
        if set(s) != {"id", "version", "repo", "path", "commit"}:
            refuse("a skill pin has the wrong keys")
        if not all(isinstance(v, str) for v in s.values()):
            refuse("a skill pin has a value that is not a string")
        if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]+)?/[A-Za-z0-9._~/-]+", s["repo"]):
            refuse("a skill repository is not a plain https URL without credentials")
        if not re.fullmatch(r"[0-9a-f]{40}", s["commit"]):
            refuse("a skill commit is not a full SHA")
        p = s["path"]
        if p != "." and (p.startswith("/") or ".." in p.split("/") or not re.fullmatch(r"[A-Za-z0-9._/-]+", p)):
            refuse("a skill path leaves its repository")
        if sid in seen:
            refuse("a skill is listed twice")
        seen.add(sid)
        print("\t".join(["REPO", sid, sversion, s["repo"], s["path"], s["commit"]]))
PY
)" || exit 5

# The credential patterns the agent's admission build uses (K1, GAP-045): refuse a skill that hard-codes one.
KNOWN='github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
GENERIC='(secret|password|passwd|api_?key|token|client_secret)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=.-]{20,}["'"'"']'

while IFS=$'\t' read -r kind id version a b c; do
  [ -n "$kind" ] || continue
  if [ "$kind" = "PACKAGE" ]; then
    pkg_hash="$a"
    echo "skill $id@$version from package ${pkg_hash:0:12}"
    tarball=""
    if [ -n "${SKILL_PACKAGES_DIR:-}" ] && [ -f "${SKILL_PACKAGES_DIR}/${pkg_hash}.tar.gz" ]; then
      tarball="${SKILL_PACKAGES_DIR}/${pkg_hash}.tar.gz"
    elif [ -n "${SKILL_PACKAGES_S3_URI:-}" ]; then
      tarball="$WORK/${pkg_hash}.tar.gz"
      aws s3 cp "${SKILL_PACKAGES_S3_URI%/}/${pkg_hash}.tar.gz" "$tarball" >/dev/null 2>&1 || { echo "cannot download package ${pkg_hash} from S3"; exit 5; }
    fi
    if [ -z "$tarball" ] || [ ! -f "$tarball" ]; then
      echo "cannot find package tarball for ${pkg_hash}"; exit 5
    fi
    computed_hash="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$tarball")"
    if [ "$computed_hash" != "$pkg_hash" ]; then
      echo "package checksum mismatch for ${pkg_hash} (got ${computed_hash})"; exit 5
    fi
    folder="$WORK/pkg_$id"
    mkdir -p "$folder" || exit 5
    python3 - "$tarball" "$folder" <<'PY' || { echo "cannot extract package ${pkg_hash}"; exit 5; }
import sys, os, tarfile

tar_path, dest = sys.argv[1], sys.argv[2]
dest = os.path.realpath(dest)
MAX_EXPANDED = 20 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
MAX_ENTRIES = 500

total_bytes = 0
entries = 0

with tarfile.open(tar_path, "r:gz") as tar:
    for member in tar:
        entries += 1
        if entries > MAX_ENTRIES:
            sys.exit(f"package exceeds max entries ({MAX_ENTRIES})")
        name = member.name.replace("\\", "/")
        if name.startswith("/") or ".." in name.split("/"):
            sys.exit(f"illegal path in package: {name}")
        target = os.path.realpath(os.path.join(dest, name))
        if not (target == dest or target.startswith(dest + os.sep)):
            sys.exit(f"path escapes target: {name}")
        if member.issym() or member.islnk() or member.isfifo() or member.isdev():
            sys.exit(f"illegal entry type in package: {name}")
        if member.isfile():
            if member.size > MAX_FILE:
                sys.exit(f"file too large in package: {name}")
            total_bytes += member.size
            if total_bytes > MAX_EXPANDED:
                sys.exit(f"package exceeds max expanded size ({MAX_EXPANDED})")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            f_in = tar.extractfile(member)
            if f_in is None:
                sys.exit(f"cannot read member: {name}")
            with open(target, "wb") as f_out:
                bytes_written = 0
                while True:
                    chunk = f_in.read(65536)
                    if not chunk:
                        break
                    bytes_written += len(chunk)
                    if bytes_written > MAX_FILE:
                        sys.exit(f"file decompression bomb: {name}")
                    f_out.write(chunk)
            os.chmod(target, member.mode & 0o777)
        elif member.isdir():
            os.makedirs(target, exist_ok=True)
            os.chmod(target, member.mode & 0o777)
        else:
            sys.exit(f"unsupported entry type: {name}")
PY
    [ -f "$folder/skill.yaml" ] || { echo "no skill.yaml in package $id@$version"; exit 5; }
  else
    repo="$a"
    path="$b"
    commit="$c"
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
  fi

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
  if ( cd "$folder" && git rev-parse --is-inside-work-tree >/dev/null 2>&1 ); then
    HITS="$(cd "$folder" && git ls-files -z -- . | xargs -0 grep -nIE -i -- "$KNOWN|$GENERIC" 2>/dev/null | grep -v 'secret-scan:allow' | grep -E -- "$KNOWN|[\"'][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[\"']|[\"'][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[\"']" | grep -vE '(example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>)' | cut -d: -f1,2 | sort -u)"
  else
    HITS="$(cd "$folder" && find . -type f -print0 | xargs -0 grep -nIE -i -- "$KNOWN|$GENERIC" 2>/dev/null | grep -v 'secret-scan:allow' | grep -E -- "$KNOWN|[\"'][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[\"']|[\"'][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[\"']" | grep -vE '(example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>)' | cut -d: -f1,2 | sort -u)"
  fi
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

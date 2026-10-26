/**
 * GCP Cloud Build orchestration for dynamic agent admission builds (DESIGN_AUTHORITY.md §6.8 L3/L4, §6.14 SK4, K1, S1).
 * Equivalent to packages/property-manager/src/aws/codebuild.ts and landing-zones/aws/codebuild.tf.
 */

import { CloudBuildClient, protos } from '@google-cloud/cloudbuild';
import {
  AdmissionRefusedError,
  imageTagFor,
  type AdmissionRefusal,
  type BuildSkill,
  type SourceRef,
} from '../runtime.js';

export type GcpBuild = protos.google.devtools.cloudbuild.v1.IBuild;

const POLL_INTERVAL_MS = 5_000;
const TERMINAL_FAILURES = new Set(['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);

const EXIT_REASONS: Record<number, AdmissionRefusal> = {
  3: 'no_tests',
  4: 'tests_failed',
  5: 'source_unavailable',
  6: 'hardcoded_secret',
  7: 'archetype_required',
};

const STEP_PHASES: Record<string, { phase: string; reason: AdmissionRefusal }> = {
  clone: { phase: 'INSTALL', reason: 'source_unavailable' },
  test: { phase: 'PRE_BUILD', reason: 'tests_failed' },
  build: { phase: 'BUILD', reason: 'build_failed' },
  push: { phase: 'POST_BUILD', reason: 'push_failed' },
};

/** Cloud Build env limit guard matching AWS CodeBuild (SK4). */
export const MAX_SKILLS_ENV_CHARS = 3500;

export function skillsEnv(skills: readonly BuildSkill[]): string {
  return JSON.stringify(
    [...skills]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({
        id: s.id,
        version: s.version,
        ...(s.packageHash
          ? { packageHash: s.packageHash }
          : { repo: s.repo, path: s.path, commit: s.commit }),
      })),
  );
}

/** Maps a failed Cloud Build to the admission refusal reason and phase (INSTALL, PRE_BUILD, BUILD, POST_BUILD). */
export function admissionFailure(build: GcpBuild): AdmissionRefusedError {
  const failedStep = build.steps?.find((s) => s.status && s.status !== 'SUCCESS' && s.status !== 'QUEUED');
  const stepId = failedStep?.id ?? '';
  const stepMeta = STEP_PHASES[stepId];
  const phase = stepMeta?.phase;
  const detail = build.failureInfo?.detail || build.statusDetail || '';
  const stepExit = (failedStep as { exitCode?: number } | undefined)?.exitCode;
  const parsedExit = Number(detail.match(/(?:exit status|non-zero status:) (\d+)/)?.[1]);
  const exit = Number.isFinite(stepExit) && stepExit ? stepExit! : parsedExit;
  const reason: AdmissionRefusal = EXIT_REASONS[exit] ?? stepMeta?.reason ?? 'build_failed';
  const msgDetail = detail ? `: ${detail}` : '';
  return new AdmissionRefusedError(
    reason,
    `Cloud Build ${build.status} in ${phase ?? (stepId || 'unknown phase')}${msgDetail}`,
    phase,
  );
}

export const CLONE_STEP_SCRIPT = `set -euo pipefail
# python:3.12 has Python and bash, not git or Node. Admission clone, secret scan, and npm test need both.
apt-get update -qq && apt-get install -y -qq git nodejs npm ca-certificates >/dev/null
echo "Admission build for $AGENT_ID at $REPO_URL@$GIT_COMMIT -> $IMAGE_TAG"
[[ "$GIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 5
PREFIX="$AGENT_ID-$(echo "$GIT_COMMIT" | cut -c1-12)"
if [ -n "\${SKILLS:-}" ]; then
  [ "\${IMAGE_TAG:0:\${#PREFIX}+1}" = "$PREFIX-" ] && [[ "\${IMAGE_TAG:\${#PREFIX}+1}" =~ ^[0-9a-f]{12}$ ]] || exit 5
else
  [ "$IMAGE_TAG" = "$PREFIX" ] || exit 5
fi
AUTH=()
host="$(printf '%s' "$REPO_URL" | sed -E 's#^https://([^/@]+)/.*#\\1#' | tr 'A-Z' 'a-z')"; allowed=""
for h in $SOURCE_TOKEN_HOSTS; do [ "$host" = "$h" ] && allowed=1; done
if [ -n "\${GIT_TOKEN_SECRET_ID:-}" ] && [ -n "$allowed" ]; then
  GIT_TOKEN="$(python3 - <<'PY'
import base64, json, os, urllib.request
req = urllib.request.Request(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    headers={"Metadata-Flavor": "Google"},
)
tok = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())["access_token"]
sec = os.environ["GIT_TOKEN_SECRET_ID"]
if not sec.startswith("projects/"):
    sec = f"projects/{os.environ['FACTORY_GCP_PROJECT']}/secrets/{sec}"
sreq = urllib.request.Request(
    f"https://secretmanager.googleapis.com/v1/{sec}/versions/latest:access",
    headers={"Authorization": f"Bearer {tok}"},
)
payload = json.loads(urllib.request.urlopen(sreq, timeout=10).read().decode())["payload"]["data"]
print(base64.b64decode(payload).decode("utf-8").strip())
PY
)" || exit 5
  AUTH=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 | tr -d '\\n')")
  unset GIT_TOKEN
fi
rm -rf /workspace/agent-repo
GIT_TERMINAL_PROMPT=0 git "\${AUTH[@]}" clone --no-checkout -- "$REPO_URL" /workspace/agent-repo || exit 5
unset AUTH
cd /workspace/agent-repo && git checkout --detach "$GIT_COMMIT" && [ "$(git rev-parse HEAD)" = "$GIT_COMMIT" ] || exit 5
`;

export const TEST_AND_SKILLS_STEP_SCRIPT = `set -u
apt-get update -qq && apt-get install -y -qq git nodejs npm ca-certificates >/dev/null
cd /workspace/agent-repo || exit 5
# K1 / GAP-045: refuse a repository that hard-codes credentials (file:line only, never the value).
KNOWN='github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
GENERIC='(secret|password|passwd|api_?key|token|client_secret)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=.-]{20,}["'"'"']'
HITS="$(git ls-files -z | xargs -0 grep -nIE -i -- "$KNOWN|$GENERIC" 2>/dev/null | grep -v 'secret-scan:allow' | grep -E -- "$KNOWN|[\\"'][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[\\"']|[\\"'][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[\\"']" | grep -vE '(example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>)' | cut -d: -f1,2 | sort -u)"
if [ -n "$HITS" ]; then echo "ADMISSION REFUSED (hardcoded_secret):"; echo "$HITS"; exit 6; fi
# AM1 / GAP-179: the commit must declare its memory archetype (cartridge.yaml memory.archetype, or memory.yaml archetype).
ARCH='[\\"'"'"']?(purpose-built|personal-assistant|team-member|ephemeral|episodic|workspace)[\\"'"'"']?[[:space:]]*(#.*)?$'
if ! { [ -f cartridge.yaml ] && grep -qE "^[[:space:]]+archetype:[[:space:]]*$ARCH" cartridge.yaml; } && ! { [ -f memory.yaml ] && grep -qE "^archetype:[[:space:]]*$ARCH" memory.yaml; }; then echo "ADMISSION REFUSED (archetype_required): declare memory.archetype: purpose-built, personal-assistant or team-member"; exit 7; fi

if [ -f requirements.txt ] || [ -f pyproject.toml ] || [ -f setup.py ]; then KIND=python
elif [ -f package.json ]; then KIND=node
else KIND=unknown; fi
echo "Agent language: $KIND"
case "$KIND" in
  python) find . \\( -path ./.git -o -path ./node_modules -o -path ./.venv \\) -prune -o -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) -print | grep -q . ;;
  node) node -e "const t=(require('./package.json').scripts||{}).test||'';process.exit(t&&!/no test specified/.test(t)?0:1)" ;;
  *) false ;;
esac || { echo "ADMISSION REFUSED (no_tests): no tests found for a $KIND agent"; exit 3; }

case "$KIND" in
  python)
    python3 -m venv /tmp/admission-venv && . /tmp/admission-venv/bin/activate || exit 4
    if [ -f requirements.txt ]; then pip install -q -r requirements.txt || exit 4; fi
    if [ -f requirements-dev.txt ]; then pip install -q -r requirements-dev.txt || exit 4; fi
    if [ ! -f requirements.txt ] && [ -f pyproject.toml ]; then pip install -q . || exit 4; fi
    python -m pytest --version >/dev/null 2>&1 || pip install -q pytest || exit 4
    python -m pytest -q; RC=$?
    deactivate
    [ "$RC" -eq 5 ] && { echo "ADMISSION REFUSED (no_tests): pytest collected no tests"; exit 3; }
    [ "$RC" -eq 0 ] || { echo "ADMISSION REFUSED (tests_failed)"; exit 4; } ;;
  node)
    npm ci && npm test || { echo "ADMISSION REFUSED (tests_failed)"; exit 4; } ;;
esac

if [ -n "\${SKILLS:-}" ]; then
  OUT="/workspace/.factory-skills"
  WORK="$(mktemp -d)" || exit 5
  rm -rf "$OUT" && mkdir -p "$OUT/skills" || exit 5
  LIST="$(python3 - <<'PY'
import json, os, re, sys
def refuse(why):
    print(why, file=sys.stderr)
    sys.exit(5)
skills = json.loads(os.environ.get("SKILLS", ""))
if not isinstance(skills, list) or not skills:
    refuse("SKILLS is not a non-empty list")
seen = set()
for s in skills:
    if not isinstance(s, dict):
        refuse("a skill pin is not a dict")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(s.get("id", ""))) or len(str(s.get("id", ""))) > 64:
        refuse("a skill id is not kebab-case")
    if not re.fullmatch(r"[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?", str(s.get("version", ""))):
        refuse("a skill version is not a semantic version")
    if s.get("id") in seen:
        refuse("a skill is listed twice")
    seen.add(s["id"])

    if "packageHash" in s:
        pkg_hash = str(s.get("packageHash", ""))
        if not re.fullmatch(r"[0-9a-f]{64}", pkg_hash):
            refuse("a skill packageHash is not a full 64-character SHA-256")
        print("|".join([s["id"], s["version"], "", "", "", pkg_hash]))
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
        print("|".join([s["id"], s["version"], s["repo"], s["path"], s["commit"], ""]))
PY
)" || exit 5
  while IFS='|' read -r id version repo path commit package_hash; do
    [ -n "$id" ] || continue
    if [ -n "$package_hash" ]; then
      echo "skill $id@$version from package \${package_hash:0:12}"
      PKG_FILE="$WORK/$package_hash.tar.gz"
      if [ -n "\${PACKAGE_STORE_URI:-}" ] && [[ "$PACKAGE_STORE_URI" =~ ^gcs://|^gs:// ]]; then
        python3 - "$PACKAGE_STORE_URI" "$package_hash" "$PKG_FILE" <<'PY' || exit 5
import json, os, sys, urllib.parse, urllib.request
uri, pkg_hash, dest = sys.argv[1:4]
raw = uri.split("://", 1)[1]
bucket = raw.split("/", 1)[0]
prefix = raw.split("/", 1)[1] if "/" in raw else ""
if prefix and not prefix.endswith("/"): prefix += "/"
req = urllib.request.Request("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", headers={"Metadata-Flavor": "Google"})
tok = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())["access_token"]
for k in [f"{prefix}packages/{pkg_hash}.tar.gz", f"{prefix}{pkg_hash}.tar.gz"]:
    try:
        url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{urllib.parse.quote(k, safe='')}?alt=media"
        dl = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
        with urllib.request.urlopen(dl, timeout=30) as r, open(dest, "wb") as f:
            f.write(r.read())
        sys.exit(0)
    except Exception:
        continue
sys.exit(5)
PY
      elif [ -n "\${PACKAGE_STORE_DIR:-}" ] && [ -f "$PACKAGE_STORE_DIR/packages/$package_hash.tar.gz" ]; then
        cp "$PACKAGE_STORE_DIR/packages/$package_hash.tar.gz" "$PKG_FILE"
      elif [ -n "\${PACKAGE_STORE_DIR:-}" ] && [ -f "$PACKAGE_STORE_DIR/$package_hash.tar.gz" ]; then
        cp "$PACKAGE_STORE_DIR/$package_hash.tar.gz" "$PKG_FILE"
      elif [ -n "\${FACTORY_SKILL_PACKAGES_DIR:-}" ] && [ -f "$FACTORY_SKILL_PACKAGES_DIR/packages/$package_hash.tar.gz" ]; then
        cp "$FACTORY_SKILL_PACKAGES_DIR/packages/$package_hash.tar.gz" "$PKG_FILE"
      elif [ -n "\${FACTORY_SKILL_PACKAGES_DIR:-}" ] && [ -f "$FACTORY_SKILL_PACKAGES_DIR/$package_hash.tar.gz" ]; then
        cp "$FACTORY_SKILL_PACKAGES_DIR/$package_hash.tar.gz" "$PKG_FILE"
      elif [ -f "./packages/$package_hash.tar.gz" ]; then
        cp "./packages/$package_hash.tar.gz" "$PKG_FILE"
      elif [ -f "./$package_hash.tar.gz" ]; then
        cp "./$package_hash.tar.gz" "$PKG_FILE"
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
pkg_file, dest_dir = sys.argv[1:3]
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
    else
      echo "skill $id@$version from $repo at \${commit:0:12}"
      AUTH=()
      host="$(printf '%s' "$repo" | sed -E 's#^https://([^/@:]+).*#\\1#' | tr 'A-Z' 'a-z')"; allowed=""
      for h in \${SOURCE_TOKEN_HOSTS:-}; do [ "$host" = "$h" ] && allowed=1; done
      if [ -n "\${GIT_TOKEN_SECRET_ID:-}" ] && [ -n "$allowed" ]; then
        GIT_TOKEN="$(python3 - <<'PY'
import base64, json, os, urllib.request
req = urllib.request.Request(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    headers={"Metadata-Flavor": "Google"},
)
tok = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())["access_token"]
sec = os.environ["GIT_TOKEN_SECRET_ID"]
if not sec.startswith("projects/"):
    sec = f"projects/{os.environ['FACTORY_GCP_PROJECT']}/secrets/{sec}"
sreq = urllib.request.Request(
    f"https://secretmanager.googleapis.com/v1/{sec}/versions/latest:access",
    headers={"Authorization": f"Bearer {tok}"},
)
payload = json.loads(urllib.request.urlopen(sreq, timeout=10).read().decode())["payload"]["data"]
print(base64.b64decode(payload).decode("utf-8").strip())
PY
)" || exit 5
        AUTH=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 | tr -d '\\n')")
        unset GIT_TOKEN
      fi
      clone="$WORK/$id"
      GIT_TERMINAL_PROMPT=0 git \${AUTH[@]+"\${AUTH[@]}"} clone --no-checkout -- "$repo" "$clone" >/dev/null 2>&1 || exit 5
      unset AUTH
      ( cd "$clone" && git checkout --detach "$commit" >/dev/null 2>&1 && [ "$(git rev-parse HEAD)" = "$commit" ] ) || exit 5
      root="$(cd "$clone" && pwd -P)"
      folder="$(cd "$clone/$path" 2>/dev/null && pwd -P)" || exit 5
      case "$folder" in "$root"|"$root"/*) ;; *) exit 5 ;; esac
    fi

    [ -f "$folder/skill.yaml" ] || exit 5
    python3 - "$folder/skill.yaml" "$id" "$version" <<'PY' || exit 5
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
def top(key):
    m = re.search(r"^" + key + r":[ \\t]*[\\"']?([^\\"'#\\n]*?)[\\"']?[ \\t]*(?:#.*)?$", text, re.M)
    return m.group(1).strip() if m else None
sys.exit(0 if top("id") == sys.argv[2] and top("version") == sys.argv[3] else 1)
PY
    SHITS="$(cd "$folder" && ( if [ -d .git ]; then git ls-files -z -- .; else find . -type f -print0; fi ) | xargs -0 grep -nIE -i -- "$KNOWN|$GENERIC" 2>/dev/null | grep -v 'secret-scan:allow' | grep -E -- "$KNOWN|[\\"'][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[\\"']|[\\"'][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[\\"']" | grep -vE '(example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>)' | cut -d: -f1,2 | sed 's#^\./##' | sort -u)"
    if [ -n "$SHITS" ]; then echo "ADMISSION REFUSED (hardcoded_secret) in skill $id:"; echo "$SHITS"; exit 6; fi
    mkdir -p "$OUT/skills/$id" || exit 5
    ( cd "$folder" && tar --exclude=.git -cf - . ) | ( cd "$OUT/skills/$id" && tar -xf - ) || exit 5
  done <<< "$LIST"
  python3 - "$OUT" <<'PY' || exit 5
import json, os, re, sys
out = sys.argv[1]
def top(text, key):
    m = re.search(r"^" + key + r":[ \\t]*[\\"']?([^\\"'#\\n]*?)[\\"']?[ \\t]*(?:#.*)?$", text, re.M)
    return m.group(1).strip() if m else None
entries = []
for id in sorted(os.listdir(os.path.join(out, "skills"))):
    text = open(os.path.join(out, "skills", id, "skill.yaml"), encoding="utf-8").read()
    entries.append({"id": id, "version": top(text, "version"), "language": top(text, "language"), "entry": top(text, "entry"), "path": "/opt/factory/skills/" + id})
json.dump({"skills": entries}, open(os.path.join(out, "skills.json"), "w"), indent=2)
PY
  cat > "$OUT/Dockerfile" <<'EOF'
ARG BASE
FROM \${BASE}
COPY skills /opt/factory/skills
COPY skills.json /opt/factory/skills.json
EOF
  chmod -R a+rX "$OUT"
fi
`;

export const BUILD_STEP_SCRIPT = `set -euo pipefail
cd /workspace/agent-repo
LABELS=(--label "org.opencontainers.image.revision=$GIT_COMMIT" --label "org.opencontainers.image.source=$REPO_URL")
if [ -z "\${SKILLS:-}" ]; then
  docker build "\${LABELS[@]}" -t "$IMAGE_URI" .
else
  docker build "\${LABELS[@]}" -t "agent-base:$IMAGE_TAG" .
  docker build "\${LABELS[@]}" --build-arg "BASE=agent-base:$IMAGE_TAG" -t "$IMAGE_URI" /workspace/.factory-skills
fi
`;

/**
 * Triggers a Cloud Build admission build for a pinned commit: clones the repo, checks out `source.commit`,
 * scans for hardcoded credentials (K1), runs the agent's own test suite (L3), composes adopted skills if any (SK4),
 * builds the image, and pushes the immutable SHA-tagged image to Artifact Registry (L4).
 */
export async function buildAgentImage(
  agentId: string,
  source: SourceRef,
  opts: {
    client?: Pick<CloudBuildClient, 'createBuild' | 'getBuild'>;
    pollMs?: number;
    skills?: readonly BuildSkill[];
  } = {},
): Promise<string> {
  const projectId = process.env.FACTORY_GCP_PROJECT;
  if (!projectId) throw new Error('FACTORY_GCP_PROJECT environment variable is not set');

  const arRepo = process.env.FACTORY_ARTIFACT_REGISTRY;
  if (!arRepo) throw new Error('FACTORY_ARTIFACT_REGISTRY environment variable is not set');

  const skills = opts.skills ?? [];
  const skillsValue = skills.length ? skillsEnv(skills) : '';
  if (skillsValue.length > MAX_SKILLS_ENV_CHARS) {
    throw new AdmissionRefusedError(
      'build_failed',
      `${skills.length} skills do not fit the build's environment (${skillsValue.length} > ${MAX_SKILLS_ENV_CHARS} characters)`,
    );
  }

  const tag = imageTagFor(agentId, source.commit, skills);
  const imageUri = `${arRepo}:${tag}`;
  const client = opts.client ?? new CloudBuildClient();

  const sourceTokenHosts = (process.env.FACTORY_AGENT_SOURCE_TOKEN_HOSTS || 'github.com')
    .split(/[,\s]+/)
    .filter(Boolean)
    .join(' ');
  const gitTokenSecretId = process.env.FACTORY_AGENT_SOURCE_TOKEN_SECRET || '';
  const builderSa = process.env.FACTORY_BUILDER_SA;

  const stepEnv = [
    `FACTORY_GCP_PROJECT=${projectId}`,
    `AGENT_ID=${agentId}`,
    `REPO_URL=${source.repo}`,
    `GIT_COMMIT=${source.commit}`,
    `IMAGE_TAG=${tag}`,
    `IMAGE_URI=${imageUri}`,
    `SOURCE_TOKEN_HOSTS=${sourceTokenHosts}`,
    `GIT_TOKEN_SECRET_ID=${gitTokenSecretId}`,
    ...(skillsValue ? [`SKILLS=${skillsValue}`] : []),
  ];

  const build: GcpBuild = {
    ...(builderSa
      ? {
          serviceAccount: builderSa.startsWith('projects/')
            ? builderSa
            : `projects/${projectId}/serviceAccounts/${builderSa}`,
        }
      : {}),
    steps: [
      {
        id: 'clone',
        name: 'python:3.12',
        entrypoint: 'bash',
        args: ['-c', CLONE_STEP_SCRIPT],
        env: stepEnv,
      },
      {
        id: 'test',
        name: 'python:3.12',
        entrypoint: 'bash',
        args: ['-c', TEST_AND_SKILLS_STEP_SCRIPT],
        env: stepEnv,
        waitFor: ['clone'],
      },
      {
        id: 'build',
        name: 'gcr.io/cloud-builders/docker',
        entrypoint: 'bash',
        args: ['-c', BUILD_STEP_SCRIPT],
        env: stepEnv,
        waitFor: ['test'],
      },
      {
        id: 'push',
        name: 'gcr.io/cloud-builders/docker',
        args: ['push', imageUri],
        waitFor: ['build'],
      },
    ],
    images: [imageUri],
    options: {
      logging: 'CLOUD_LOGGING_ONLY' as const,
    },
  };

  const [operation] = await client.createBuild({ projectId, build });
  const metadata = operation.metadata as protos.google.devtools.cloudbuild.v1.IBuildOperationMetadata | undefined;
  const buildId = metadata?.build?.id ?? (operation as { id?: string }).id;
  if (!buildId) {
    throw new Error('Cloud Build did not return a build ID');
  }

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? POLL_INTERVAL_MS));
    const [currentBuild] = await client.getBuild({ projectId, id: buildId });
    const status = currentBuild.status as string | undefined;
    if (status === 'SUCCESS') {
      return imageUri;
    }
    if (status && TERMINAL_FAILURES.has(status)) {
      throw admissionFailure(currentBuild);
    }
  }
}

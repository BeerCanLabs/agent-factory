/**
 * GCP Cloud Build skill checker (DESIGN_AUTHORITY.md §6.14 SK1, S1).
 * Equivalent to packages/control-plane/src/aws/skill-checker.ts.
 *
 * Uses native fetch against the Cloud Build v1 REST API (`cloudbuild.googleapis.com`) so the control-plane
 * package remains free of `@google-cloud/*` SDK dependencies (conformance: property-manager.test.ts).
 */

import {
  SKILL_CHECK_SCRIPT,
  cleanFailure,
  parseSkillCheckResult,
  skillCheckEnv,
  type SkillChecker,
  type SkillCheckOutcome,
} from '@beercanlabs/factory-registrar';

export type GcpSkillBuild = {
  id?: string;
  status?: string;
  statusDetail?: string;
  failureInfo?: { detail?: string };
  results?: {
    buildStepOutputs?: string[];
  };
  steps?: Array<{
    id?: string;
    status?: string;
  }>;
};

export type GcpCloudBuildApi = {
  createBuild(projectId: string, build: Record<string, unknown>): Promise<{ id: string }>;
  getBuild(projectId: string, buildId: string): Promise<GcpSkillBuild | null>;
};

const TERMINAL_FAILURES = new Set(['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);

async function getGcpToken(): Promise<string> {
  if (process.env.FACTORY_GCP_ACCESS_TOKEN) {
    return process.env.FACTORY_GCP_ACCESS_TOKEN;
  }
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!res.ok) {
    throw new Error(`GCP metadata token request failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('GCP metadata response missing access_token');
  return data.access_token;
}

export function defaultGcpCloudBuildApi(): GcpCloudBuildApi {
  return {
    async createBuild(projectId, build) {
      const token = await getGcpToken();
      const res = await fetch(
        `https://cloudbuild.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/builds`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(build),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Cloud Build createBuild failed (${res.status}): ${text.slice(0, 300)}`);
      }
      const op = (await res.json()) as {
        metadata?: { build?: { id?: string } };
        name?: string;
      };
      const id = op.metadata?.build?.id;
      if (!id) throw new Error('Cloud Build did not return a build id');
      return { id };
    },

    async getBuild(projectId, buildId) {
      const token = await getGcpToken();
      const res = await fetch(
        `https://cloudbuild.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(buildId)}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Cloud Build getBuild(${buildId}) failed (${res.status}): ${text.slice(0, 300)}`);
      }
      return (await res.json()) as GcpSkillBuild;
    },
  };
}

export const GCP_SKILL_CHECK_STEP_SCRIPT = `apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null
cat > /tmp/skill_check.py <<'PY'
${SKILL_CHECK_SCRIPT.replace(/\n$/, '')}
PY
echo "Skill check for $SKILL_ID@$SKILL_VERSION at $REPO_URL@$GIT_COMMIT ($SKILL_PATH)"
SKILL_CHECK_RESULT='{"passed":false,"failures":["checks: the check did not run"]}'
if ! [[ "$GIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || [[ "$SKILL_PATH" == /* || "$SKILL_PATH" == *..* ]]; then
  SKILL_CHECK_RESULT='{"passed":false,"failures":["source: the pin must be a full commit and a folder inside the repository"]}'
else
  AUTH=()
  # The source token goes only to an allowed source host; any other repo is cloned without it (S1).
  host="$(printf '%s' "$REPO_URL" | sed -E 's#^https://([^/@]+)/.*#\\1#' | tr 'A-Z' 'a-z')"; allowed=""
  for h in $SOURCE_TOKEN_HOSTS; do [ "$host" = "$h" ] && allowed=1; done
  if [ -n "$GIT_TOKEN_SECRET_ID" ] && [ -n "$allowed" ]; then
    GIT_TOKEN="$(python3 - <<'TOKPY'
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
TOKPY
)" || GIT_TOKEN=""
    [ -n "$GIT_TOKEN" ] && AUTH=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 | tr -d '\\n')")
    unset GIT_TOKEN
  fi
  if GIT_TERMINAL_PROMPT=0 git "\${AUTH[@]}" clone --no-checkout -- "$REPO_URL" skill-repo \\
    && (cd skill-repo && git -c advice.detachedHead=false checkout --detach "$GIT_COMMIT" && [ "$(git rev-parse HEAD)" = "$GIT_COMMIT" ]); then
    unset AUTH
    python3 /tmp/skill_check.py --dir "skill-repo/$SKILL_PATH" --venv /tmp/skill-check-venv --out /tmp/skill-check.json || true
    if [ -s /tmp/skill-check.json ]; then SKILL_CHECK_RESULT="$(cat /tmp/skill-check.json)"; fi
  else
    SKILL_CHECK_RESULT='{"passed":false,"failures":["source: could not fetch the repository at the pinned commit"]}'
  fi
  unset AUTH
fi
mkdir -p /builder/outputs
printf '%s' "$SKILL_CHECK_RESULT" > /builder/outputs/output
export SKILL_CHECK_RESULT
`;

function decodeStepOutput(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('SKILL_CHECK_RESULT=')) {
    return trimmed;
  }
  try {
    return Buffer.from(trimmed, 'base64').toString('utf8').trim();
  } catch {
    return trimmed;
  }
}

export function gcpSkillCheckOutcome(build: GcpSkillBuild): SkillCheckOutcome {
  const rawOutput = decodeStepOutput(build.results?.buildStepOutputs?.[0]);
  if (build.status === 'SUCCESS' && rawOutput) {
    return parseSkillCheckResult(rawOutput);
  }
  const failedStep = build.steps?.find((s) => s.status && s.status !== 'SUCCESS' && s.status !== 'QUEUED');
  const message = build.failureInfo?.detail || build.statusDetail || '';
  const detail = message ? `: ${message}` : '';
  return {
    passed: false,
    failures: [
      cleanFailure(
        `checks: the check run ended ${build.status ?? 'UNKNOWN'} in ${failedStep?.id ?? 'an unknown phase'} without a result${detail}`,
      ),
    ],
  };
}

export function cloudBuildSkillChecker(
  opts: {
    api?: GcpCloudBuildApi;
    pollMs?: number;
    projectId?: string;
    serviceAccount?: string;
  } = {},
): SkillChecker {
  const api = opts.api ?? defaultGcpCloudBuildApi();
  return {
    name: 'cloudbuild',
    async start(req) {
      const projectId = opts.projectId ?? process.env.FACTORY_GCP_PROJECT;
      if (!projectId) throw new Error('FACTORY_GCP_PROJECT environment variable is not set');
      const sa = opts.serviceAccount ?? process.env.FACTORY_SKILL_CHECKER_SA;
      const sourceTokenHosts = (process.env.FACTORY_AGENT_SOURCE_TOKEN_HOSTS || 'github.com')
        .split(/[,\s]+/)
        .filter(Boolean)
        .join(' ');
      const gitTokenSecretId = process.env.FACTORY_AGENT_SOURCE_TOKEN_SECRET || '';

      const envMap = {
        ...skillCheckEnv(req),
        FACTORY_GCP_PROJECT: projectId,
        SOURCE_TOKEN_HOSTS: sourceTokenHosts,
        GIT_TOKEN_SECRET_ID: gitTokenSecretId,
      };
      const stepEnv = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);

      const build: Record<string, unknown> = {
        ...(sa
          ? {
              serviceAccount: sa.startsWith('projects/')
                ? sa
                : `projects/${projectId}/serviceAccounts/${sa}`,
            }
          : {}),
        timeout: '1200s',
        steps: [
          {
            id: 'skill-check',
            name: 'python:3.12',
            entrypoint: 'bash',
            args: ['-c', GCP_SKILL_CHECK_STEP_SCRIPT],
            env: stepEnv,
          },
        ],
        options: {
          logging: 'CLOUD_LOGGING_ONLY',
        },
      };
      const { id } = await api.createBuild(projectId, build);
      return id;
    },
    async result(runId) {
      const projectId = opts.projectId ?? process.env.FACTORY_GCP_PROJECT;
      if (!projectId) throw new Error('FACTORY_GCP_PROJECT environment variable is not set');
      let errors = 0;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 10_000));
        let build: GcpSkillBuild | null;
        try {
          build = await api.getBuild(projectId, runId);
          errors = 0;
        } catch (err) {
          if (++errors >= 30) throw err;
          continue;
        }
        if (!build) {
          return {
            passed: false,
            failures: [`checks: build ${runId} not found in Cloud Build; re-run the checks`],
          };
        }
        if (build.status === 'SUCCESS') return gcpSkillCheckOutcome(build);
        if (build.status && TERMINAL_FAILURES.has(build.status)) return gcpSkillCheckOutcome(build);
      }
    },
  };
}

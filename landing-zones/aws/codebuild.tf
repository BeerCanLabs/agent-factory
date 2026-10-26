resource "aws_iam_role" "codebuild" {
  name = "codebuild"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "codebuild.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "codebuild_policy" {
  name = "codebuild_policy"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:GetRepositoryPolicy",
          "ecr:DescribeRepositories",
          "ecr:ListImages",
          "ecr:DescribeImages",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "*"
      },
      {
        Sid      = "SkillPackagesRead"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.skill_packages.arn}/*"
      }
      ], var.agent_source_token_secret_arn == "" ? [] : [
      {
        # Read-only token for cloning private agent repositories (see var.agent_source_token_secret_arn).
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.agent_source_token_secret_arn
      }
    ])
  })
}

# Admission build (DESIGN_AUTHORITY.md §6.8 L3/L4). The control plane starts it with AGENT_ID, REPO_URL,
# GIT_COMMIT (full 40-char SHA) and IMAGE_TAG (<agentId>-<commit[:12]>). It builds exactly that commit, refuses a
# repository without tests, runs the agent's own tests, and pushes an image tagged by the commit, never a
# mutable tag. Refusal reasons are exit codes that packages/property-manager/src/aws/codebuild.ts maps back:
# 3 = no_tests, 4 = tests_failed, 5 = source_unavailable, 6 = hardcoded_secret, 7 = archetype_required (AM1); any other failure maps from its phase.
#
# Skills (§6.14 SK4): when the control plane also sends SKILLS (the agent's adopted skills, each at an approved
# version's pinned commit), IMAGE_TAG is <agentId>-<commit[:12]>-<12 hex of a hash of the skill pins>. The agent's image is
# built as before (kept local), then landing-zones/aws/compose-skills.sh fetches each skill at its commit, checks it, and
# the final image adds one layer holding the skills and /opt/factory/skills.json on top. The agent's Dockerfile is not
# read for them, and only the final image is pushed.
resource "aws_codebuild_project" "factory_agent_builder" {
  name         = "factory-agent-builder"
  service_role = aws_iam_role.codebuild.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/amazonlinux2-x86_64-standard:5.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "ECR_REPO_URI"
      value = aws_ecr_repository.dynamic_agents.repository_url
    }

    environment_variable {
      name  = "GIT_TOKEN_SECRET_ID"
      value = var.agent_source_token_secret_arn
    }
    environment_variable {
      name  = "SOURCE_TOKEN_HOSTS"
      value = join(" ", var.agent_source_token_hosts)
    }
    environment_variable {
      name  = "PACKAGE_STORE_URI"
      value = "s3://${aws_s3_bucket.skill_packages.bucket}/packages"
    }
  }

  source {
    type      = "NO_SOURCE"
    buildspec = <<EOF
version: 0.2

env:
  shell: bash

phases:
  install:
    on-failure: ABORT
    commands:
      - echo "Admission build for $AGENT_ID at $REPO_URL@$GIT_COMMIT -> $IMAGE_TAG"
      - '[[ "$GIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 5'
      - |
        PREFIX="$AGENT_ID-$(echo $GIT_COMMIT | cut -c1-12)"
        if [ -n "$SKILLS" ]; then
          [ "$${IMAGE_TAG:0:$${#PREFIX}+1}" = "$PREFIX-" ] && [[ "$${IMAGE_TAG:$${#PREFIX}+1}" =~ ^[0-9a-f]{12}$ ]] || exit 5
        else
          [ "$IMAGE_TAG" = "$PREFIX" ] || exit 5
        fi
      - |
        if [ -n "$SKILLS" ]; then
        cat > /tmp/compose-skills.sh <<'FACTORY_COMPOSE_SKILLS'
        ${indent(8, file("${path.module}/compose-skills.sh"))}
        FACTORY_COMPOSE_SKILLS
        fi
      - |
        AUTH=()
        # The source token goes only to an allowed source host (var.agent_source_token_hosts); any other repo is cloned
        # without it, so a registration can never send the token somewhere else.
        host="$(printf '%s' "$REPO_URL" | sed -E 's#^https://([^/@]+)/.*#\1#' | tr 'A-Z' 'a-z')"; allowed=""
        for h in $SOURCE_TOKEN_HOSTS; do [ "$host" = "$h" ] && allowed=1; done
        if [ -n "$GIT_TOKEN_SECRET_ID" ] && [ -n "$allowed" ]; then
          GIT_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$GIT_TOKEN_SECRET_ID" --query SecretString --output text)" || exit 5
          AUTH=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)")
          unset GIT_TOKEN
        fi
        GIT_TERMINAL_PROMPT=0 git "$${AUTH[@]}" clone --no-checkout -- "$REPO_URL" agent-repo || exit 5
        unset AUTH
      - cd agent-repo && git checkout --detach "$GIT_COMMIT" && [ "$(git rev-parse HEAD)" = "$GIT_COMMIT" ] || exit 5
  pre_build:
    on-failure: ABORT
    commands:
      # K1 / GAP-045: refuse a repository that hard-codes credentials (file:line only, never the value).
      - |
        KNOWN='github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
        GENERIC='(secret|password|passwd|api_?key|token|client_secret)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=.-]{20,}["'"'"']'
        HITS="$(git ls-files -z | xargs -0 grep -nIE -i -- "$KNOWN|$GENERIC" 2>/dev/null | grep -v 'secret-scan:allow' | grep -E -- "$KNOWN|[\"'][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[\"']|[\"'][A-Za-z0-9_/+=.-]*[0-9][A-Za-z0-9_/+=.-]*[a-z][A-Za-z0-9_/+=.-]*[\"']" | grep -vE '(example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>)' | cut -d: -f1,2 | sort -u)"
        if [ -n "$HITS" ]; then echo "ADMISSION REFUSED (hardcoded_secret):"; echo "$HITS"; exit 6; fi
      - |
        # AM1 / GAP-179: the commit must declare its memory archetype (cartridge.yaml memory.archetype, or memory.yaml archetype).
        ARCH='[\"'"'"']?(purpose-built|personal-assistant|team-member|ephemeral|episodic|workspace)[\"'"'"']?[[:space:]]*(#.*)?$'
        if ! { [ -f cartridge.yaml ] && grep -qE "^[[:space:]]+archetype:[[:space:]]*$ARCH" cartridge.yaml; } && ! { [ -f memory.yaml ] && grep -qE "^archetype:[[:space:]]*$ARCH" memory.yaml; }; then echo "ADMISSION REFUSED (archetype_required): declare memory.archetype: purpose-built, personal-assistant or team-member"; exit 7; fi
      - |
        if [ -f requirements.txt ] || [ -f pyproject.toml ] || [ -f setup.py ]; then KIND=python
        elif [ -f package.json ]; then KIND=node
        else KIND=unknown; fi
        echo "Agent language: $KIND"
        case "$KIND" in
          python) find . \( -path ./.git -o -path ./node_modules -o -path ./.venv \) -prune -o -type f \( -name 'test_*.py' -o -name '*_test.py' \) -print | grep -q . ;;
          node) node -e "const t=(require('./package.json').scripts||{}).test||'';process.exit(t&&!/no test specified/.test(t)?0:1)" ;;
          *) false ;;
        esac || { echo "ADMISSION REFUSED (no_tests): no tests found for a $KIND agent"; exit 3; }
      - |
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
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPO_URI
  build:
    on-failure: ABORT
    commands:
      - |
        LABELS=(--label "org.opencontainers.image.revision=$GIT_COMMIT" --label "org.opencontainers.image.source=$REPO_URL")
        if [ -z "$SKILLS" ]; then
          docker build "$${LABELS[@]}" -t "$ECR_REPO_URI:$IMAGE_TAG" . || exit 1
        else
          docker build "$${LABELS[@]}" -t "agent-base:$IMAGE_TAG" . || exit 1
          bash /tmp/compose-skills.sh /tmp/factory-skills; RC=$?
          [ "$RC" -eq 0 ] || exit "$RC"
          docker build "$${LABELS[@]}" --build-arg "BASE=agent-base:$IMAGE_TAG" -t "$ECR_REPO_URI:$IMAGE_TAG" /tmp/factory-skills || exit 1
        fi
  post_build:
    on-failure: ABORT
    commands:
      - docker push "$ECR_REPO_URI:$IMAGE_TAG"
EOF
  }
}

# Skills on the shared runtime (§6.18 CF6, §6.14 SK4, TSK-272). An agent created from a configuration has no repository to
# build; when it has adopted skills, the control plane starts this project with AGENT_ID, BASE_IMAGE (the pinned shared
# runtime image), RUNTIME_COMMIT (the commit that image was built from), SKILLS (the pins) and IMAGE_TAG
# (<agentId>-<runtime commit[:12]>-<12 hex of a hash of the skill pins>). It fetches each skill at its commit, checks it
# (compose-skills.sh, the same checks as an agent's image), adds one layer holding the skills and /opt/factory/skills.json
# on the runtime image, and pushes the result. It reads no agent source and runs no agent tests. BASE_IMAGE must be in the
# runtime's own registry. Exit codes are the agent builder's: 5 = a pin or base that is not acceptable, 6 = a hard-coded credential.
resource "aws_codebuild_project" "factory_skills_builder" {
  name         = "factory-skills-builder"
  service_role = aws_iam_role.codebuild.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/amazonlinux2-x86_64-standard:5.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "ECR_REPO_URI"
      value = aws_ecr_repository.dynamic_agents.repository_url
    }
    environment_variable {
      name  = "RUNTIME_REPO_URI"
      value = aws_ecr_repository.repo["agent-runtime"].repository_url
    }
    environment_variable {
      name  = "GIT_TOKEN_SECRET_ID"
      value = var.agent_source_token_secret_arn
    }
    environment_variable {
      name  = "SOURCE_TOKEN_HOSTS"
      value = join(" ", var.agent_source_token_hosts)
    }
    environment_variable {
      name  = "PACKAGE_STORE_URI"
      value = "s3://${aws_s3_bucket.skill_packages.bucket}/packages"
    }
  }

  source {
    type      = "NO_SOURCE"
    buildspec = <<EOF
version: 0.2

env:
  shell: bash

phases:
  install:
    on-failure: ABORT
    commands:
      - echo "Skills build for $AGENT_ID on $BASE_IMAGE -> $IMAGE_TAG"
      - '[[ "$RUNTIME_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 5'
      - '[ -n "$SKILLS" ] || exit 5'
      - |
        PREFIX="$AGENT_ID-$(echo $RUNTIME_COMMIT | cut -c1-12)"
        [ "$${IMAGE_TAG:0:$${#PREFIX}+1}" = "$PREFIX-" ] && [[ "$${IMAGE_TAG:$${#PREFIX}+1}" =~ ^[0-9a-f]{12}$ ]] || exit 5
      # The base is the factory's own runtime image, by registry path: no other image is layered on.
      - '[[ "$BASE_IMAGE" =~ ^[A-Za-z0-9./:_-]+$ ]] && [ "$${BASE_IMAGE%%:*}" = "$RUNTIME_REPO_URI" ] || exit 5'
      - |
        cat > /tmp/compose-skills.sh <<'FACTORY_COMPOSE_SKILLS'
        ${indent(8, file("${path.module}/compose-skills.sh"))}
        FACTORY_COMPOSE_SKILLS
  pre_build:
    on-failure: ABORT
    commands:
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPO_URI
      - docker pull "$BASE_IMAGE" || exit 5
      - |
        bash /tmp/compose-skills.sh /tmp/factory-skills; RC=$?
        [ "$RC" -eq 0 ] || exit "$RC"
  build:
    on-failure: ABORT
    commands:
      - docker build --label "org.opencontainers.image.revision=$RUNTIME_COMMIT" --build-arg "BASE=$BASE_IMAGE" -t "$ECR_REPO_URI:$IMAGE_TAG" /tmp/factory-skills || exit 1
  post_build:
    on-failure: ABORT
    commands:
      - docker push "$ECR_REPO_URI:$IMAGE_TAG"
EOF
  }
}

# SK1 skill checks (DESIGN_AUTHORITY.md §6.14, TSK-054): its own role, with no image registry access. The build runs a
# registered skill's code and tests, so it holds only what fetching the source and writing its log need.
resource "aws_iam_role" "codebuild_skill_checker" {
  name = "codebuild-skill-checker"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "codebuild.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "codebuild_skill_checker" {
  name = "codebuild_skill_checker_policy"
  role = aws_iam_role.codebuild_skill_checker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "*"
      },
      {
        Sid      = "SkillPackagesRead"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.skill_packages.arn}/*"
      }
      ], var.agent_source_token_secret_arn == "" ? [] : [
      {
        # The same read-only token agent admission uses to clone private repositories.
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.agent_source_token_secret_arn
      }
    ])
  })
}

# Skill checks (SK1). The control plane (packages/control-plane/src/aws/skill-checker.ts, codeBuildSkillChecker) starts a
# build per registered skill version with SKILL_ID, SKILL_VERSION, REPO_URL, GIT_COMMIT (full SHA), SKILL_PATH and
# SKILL_MANIFEST_B64 (the registered manifest). The build clones exactly that commit with the agent builder's source
# token handling, runs the check script in the skill's folder, and exports SKILL_CHECK_RESULT
# ({"passed": bool, "failures": [...]}), which the control plane reads from BatchGetBuilds when the build ends.
# The script is packages/registrar/src/skill-checks.ts SKILL_CHECK_SCRIPT, embedded verbatim; skill-checks.test.ts
# fails if the two differ. The skill's tests run without the build's cloud credentials or the source token. Like
# factory-agent-builder, it runs in CodeBuild's own network (it needs the git host and the Python package index), never
# inside the factory VPC, and it is not privileged: it builds no image.
resource "aws_codebuild_project" "factory_skill_checker" {
  name          = "factory-skill-checker"
  service_role  = aws_iam_role.codebuild_skill_checker.arn
  build_timeout = 20

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/amazonlinux2-x86_64-standard:5.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = false

    environment_variable {
      name  = "GIT_TOKEN_SECRET_ID"
      value = var.agent_source_token_secret_arn
    }
    environment_variable {
      name  = "SOURCE_TOKEN_HOSTS"
      value = join(" ", var.agent_source_token_hosts)
    }
    environment_variable {
      name  = "PACKAGE_STORE_URI"
      value = "s3://${aws_s3_bucket.skill_packages.bucket}/packages"
    }
  }

  source {
    type      = "NO_SOURCE"
    buildspec = <<EOF
version: 0.2

env:
  shell: bash
  exported-variables:
    - SKILL_CHECK_RESULT

phases:
  install:
    on-failure: ABORT
    runtime-versions:
      python: 3.12
    commands:
      - |
        cat > /tmp/skill_check.py <<'PY'
        """Factory checks on one skill version's code (DESIGN_AUTHORITY.md 6.14 SK1)."""
        import argparse, ast, base64, json, os, re, subprocess, sys

        SKIP_DIRS = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.github'}
        DOC_EXT = {'.md', '.rst', '.txt', '.adoc'}
        CONFIG_EXT = {'.js', '.mjs', '.cjs', '.ts', '.sh', '.json', '.yaml', '.yml', '.cfg', '.ini', '.toml', '.env'}
        METADATA_FILES = {'skill.yaml', 'pyproject.toml', 'setup.cfg', 'package.json', 'package-lock.json'}

        KNOWN = re.compile(r'github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----')
        GENERIC = re.compile(r'(secret|password|passwd|api_?key|token|client_secret)[A-Za-z0-9_]*["\']?\s*[:=]\s*["\']([A-Za-z0-9_/+=.-]{20,})["\']', re.IGNORECASE)
        PLACEHOLDER = re.compile(r'example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>')

        SDK_MODULES = ('boto3', 'botocore', 'aiobotocore', 'aioboto3', 'anthropic', 'openai', 'xai', 'xai_sdk', 'vertexai', 'google.cloud', 'google.genai', 'google.generativeai', 'google.ai.generativelanguage')
        SDK_PACKAGES = re.compile(r'^(boto3|botocore|aiobotocore|aioboto3|anthropic|openai|xai|xai-sdk|vertexai|google-genai|google-generativeai|google-ai-generativelanguage|google-cloud(-[a-z0-9-]+)?)$')

        URL = re.compile(r'\b(?:https?|wss?|ftp)://([^/\s"\'<>:]+)', re.IGNORECASE)
        HOST = re.compile(r'^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|dev|app|gg|co|cloud|xyz|uk|eu)(?::\d+)?(?:/.*)?$', re.IGNORECASE)
        IPV4 = re.compile(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?(?:/.*)?$')

        MAX_FAILURES, MAX_RESULT_CHARS = 20, 1000

        def rel_files(root):
            out = []
            for base, dirs, files in os.walk(root):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
                for name in sorted(files): out.append(os.path.relpath(os.path.join(base, name), root).replace(os.sep, '/'))
            return out

        def read_text(root, rel):
            try:
                with open(os.path.join(root, rel), 'rb') as f: data = f.read()
            except OSError: return None
            return None if b'\0' in data[:8192] else data.decode('utf-8', errors='replace')

        def is_vendor(rel): parts = rel.split('/'); return len(parts) > 1 and parts[0] == 'vendor'
        def is_doc(rel): parts = rel.split('/'); return os.path.splitext(rel)[1].lower() in DOC_EXT or any(p in ('docs', 'doc', 'examples') for p in parts[:-1])
        def is_test(rel):
            if is_vendor(rel): return False
            parts = rel.split('/'); name = parts[-1]
            return any(p in ('test', 'tests', 'testing') for p in parts[:-1]) or name.startswith('test_') or name.endswith('_test.py') or name == 'conftest.py'

        def external_host(host):
            h = host.lower().rstrip('.')
            if h in ('localhost', '0.0.0.0') or h.endswith(('.internal', '.local', '.localhost', '.example', '.invalid', '.test')): return False
            if h in ('example.com', 'example.org', 'example.net') or any(h.endswith('.' + z) for z in ('example.com', 'example.org', 'example.net')): return False
            m = IPV4.match(h)
            if m:
                a, b = int(m.group(1)), int(m.group(2))
                return not (a in (0, 10, 127) or (a == 169 and b == 254) or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168))
            return True

        def hosts_in(text):
            found = [m.group(1) for m in URL.finditer(text) if external_host(m.group(1))]
            s = text.strip()
            if not found and (HOST.match(s) or IPV4.match(s)) and external_host(s.split('/')[0].split(':')[0]): found.append(s.split('/')[0])
            return found

        def check_secrets(root, files, failures):
            for rel in files:
                text = read_text(root, rel)
                if text is None: continue
                for n, line in enumerate(text.splitlines(), 1):
                    g = GENERIC.search(line)
                    generic = g and re.search(r'[a-z]', g.group(2)) and re.search(r'[0-9]', g.group(2)) and not PLACEHOLDER.search(line)
                    if KNOWN.search(line) or generic: failures.append('secrets: %s:%d looks like a hard-coded credential' % (rel, n))

        def module_of(node):
            names = []
            if isinstance(node, ast.Import): names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and not node.level: names = [node.module] + [node.module + '.' + a.name for a in node.names]
            elif isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                f = node.func; fname = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ''
                if fname in ('__import__', 'import_module'): names = [node.args[0].value]
            return names

        def sdk_of(name):
            for m in SDK_MODULES:
                if name == m or name.startswith(m + '.'): return m

        def docstring_nodes(tree):
            ids = set()
            for node in ast.walk(tree):
                if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
                    first = node.body[0]
                    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str): ids.add(id(first.value))
            return ids

        def check_python(root, files, failures):
            for rel in files:
                if not rel.endswith('.py'): continue
                text = read_text(root, rel)
                if text is None: continue
                try: tree = ast.parse(text, filename=rel)
                except SyntaxError as e: failures.append('build: %s:%s does not parse as Python (%s)' % (rel, e.lineno, e.msg)); continue
                docs, exempt = docstring_nodes(tree), is_test(rel) or is_doc(rel) or is_vendor(rel)
                for node in ast.walk(tree):
                    for name in module_of(node):
                        sdk = sdk_of(name)
                        if sdk: failures.append('provider SDK: %s:%d imports %s' % (rel, node.lineno, sdk)); break
                    if exempt or not isinstance(node, ast.Constant) or not isinstance(node.value, str) or id(node) in docs: continue
                    for host in hosts_in(node.value)[:1]: failures.append('hosts: %s:%d hard-codes %s' % (rel, node.lineno, host))

        def check_other_hosts(root, files, failures):
            for rel in files:
                name = rel.split('/')[-1]
                if rel.endswith('.py') or name in METADATA_FILES or is_test(rel) or is_doc(rel) or is_vendor(rel): continue
                if os.path.splitext(name)[1].lower() not in CONFIG_EXT: continue
                text = read_text(root, rel)
                if text is None: continue
                for n, line in enumerate(text.splitlines(), 1):
                    hosts = [m.group(1) for m in URL.finditer(line) if external_host(m.group(1))]
                    if hosts: failures.append('hosts: %s:%d hard-codes %s' % (rel, n, hosts[0]))

        def requirement_name(spec):
            m = re.match(r'\s*([A-Za-z0-9][A-Za-z0-9._-]*)', spec)
            return re.sub(r'[._]+', '-', m.group(1).lower()) if m else None

        def check_dependencies(root, files, failures):
            for rel in files:
                name, deps = rel.split('/')[-1], []
                if re.match(r'^requirements.*\.(txt|in)$', name):
                    for n, line in enumerate((read_text(root, rel) or '').splitlines(), 1):
                        line = line.split('#', 1)[0].strip()
                        if line and not line.startswith('-'): deps.append((requirement_name(line), n))
                elif name == 'pyproject.toml':
                    try:
                        import tomllib
                        with open(os.path.join(root, rel), 'rb') as f: data = tomllib.load(f)
                    except Exception as e: failures.append('build: %s is not valid TOML (%s)' % (rel, e)); continue
                    project = data.get('project', {})
                    specs = list(project.get('dependencies', []))
                    for group in project.get('optional-dependencies', {}).values(): specs += list(group)
                    for group in data.get('dependency-groups', {}).values(): specs += [g for g in group if isinstance(g, str)]
                    poetry = data.get('tool', {}).get('poetry', {})
                    specs += list(poetry.get('dependencies', {}).keys())
                    for group in poetry.get('group', {}).values(): specs += list(group.get('dependencies', {}).keys())
                    deps += [(requirement_name(s), 0) for s in specs if isinstance(s, str)]
                for dep, n in deps:
                    if dep and SDK_PACKAGES.match(dep):
                        failures.append('provider SDK: %s depends on %s' % ('%s:%d' % (rel, n) if n else rel, dep))

        def parse_scalar(s):
            s = s.strip()
            if not s: return None
            if s[0] in '"\'' and s[-1] == s[0] and len(s) > 1: return s[1:-1]
            if s.startswith('[') and s.endswith(']'): return [parse_scalar(x) for x in s[1:-1].strip().split(',')] if s[1:-1].strip() else []
            if s.startswith('{') and s.endswith('}'): return dict((k.strip(), parse_scalar(v)) for k, v in (p.split(':', 1) for p in s[1:-1].strip().split(','))) if s[1:-1].strip() else {}
            if s in ('true', 'True'): return True
            if s in ('false', 'False'): return False
            if s in ('null', '~'): return None
            return s

        def strip_comment(line):
            out, quote = [], None
            for i, ch in enumerate(line):
                if quote:
                    if ch == quote: quote = None
                elif ch in '"\'' and (i == 0 or line[i - 1] in ' \t:[,{'): quote = ch
                elif ch == '#' and (i == 0 or line[i - 1] in ' \t'): break
                out.append(ch)
            return ''.join(out).rstrip()

        def mini_yaml(text):
            lines = []
            for raw in text.splitlines():
                line = strip_comment(raw)
                if line.strip() and line.strip() != '---': lines.append((len(line) - len(line.lstrip(' ')), line.strip()))
            pos = [0]
            def block(indent):
                if pos[0] >= len(lines): return None
                if lines[pos[0]][1].startswith('- '):
                    out = []
                    while pos[0] < len(lines) and lines[pos[0]][0] == indent and lines[pos[0]][1].startswith('-'):
                        item = lines[pos[0]][1][1:].strip()
                        if re.match(r'^[A-Za-z0-9_-]+:(\s|$)', item): lines[pos[0]] = (indent + 2, item); out.append(block(indent + 2))
                        else: pos[0] += 1; out.append(parse_scalar(item))
                    return out
                out = {}
                while pos[0] < len(lines) and lines[pos[0]][0] == indent and not lines[pos[0]][1].startswith('- '):
                    key, _, rest = lines[pos[0]][1].partition(':'); pos[0] += 1
                    if rest.strip(): out[key.strip()] = parse_scalar(rest)
                    elif pos[0] < len(lines) and lines[pos[0]][0] > indent: out[key.strip()] = block(lines[pos[0]][0])
                    elif pos[0] < len(lines) and lines[pos[0]][0] == indent and lines[pos[0]][1].startswith('- '): out[key.strip()] = block(indent)
                    else: out[key.strip()] = None
                return out
            return block(lines[0][0]) if lines else {}

        def load_yaml(text):
            if os.environ.get('SKILL_CHECK_NO_PYYAML') != '1':
                try: import yaml; return yaml.safe_load(text)
                except ImportError: pass
            return mini_yaml(text)

        def normalize(value):
            if isinstance(value, dict):
                out = dict((k, normalize(v)) for k, v in value.items() if k != 'spec')
                return dict((k, v) for k, v in out.items() if v not in (None, [], {}, ''))
            if isinstance(value, list): return [normalize(v) for v in value]
            return value

        def diff_keys(a, b, prefix=''):
            keys = []
            for k in sorted(set(a) | set(b)):
                x, y = a.get(k), b.get(k)
                if isinstance(x, dict) and isinstance(y, dict): keys += diff_keys(x, y, prefix + k + '.')
                elif x != y: keys.append(prefix + k)
            return keys

        def check_manifest(root, registered, failures):
            path = os.path.join(root, 'skill.yaml')
            if not os.path.isfile(path): failures.append('manifest: no skill.yaml in the skill folder at this commit'); return
            try: found = load_yaml(read_text(root, 'skill.yaml') or '')
            except Exception as e: failures.append('manifest: skill.yaml does not parse (%s)' % str(e).splitlines()[0][:120]); return
            if not isinstance(found, dict): failures.append('manifest: skill.yaml is not a mapping'); return
            keys = diff_keys(normalize(found), normalize(registered))
            if keys: failures.append('manifest: skill.yaml at this commit does not match the registered manifest (%s)' % ', '.join(keys[:8]))

        def check_entry(root, entry, failures):
            if entry and not any(os.path.isfile(os.path.join(root, c)) for c in [entry, entry.replace('.', '/') + '.py', os.path.join(entry.replace('.', '/'), '__init__.py')]):
                failures.append('build: entry %s is not a file or module in the skill folder' % entry)

        def has_pytest_config(root, files):
            if 'pytest.ini' in files or any(f.split('/')[-1] == 'conftest.py' for f in files): return True
            return any(name in files and marker in (read_text(root, name) or '') for name, marker in (('pyproject.toml', '[tool.pytest.ini_options]'), ('setup.cfg', '[tool:pytest]'), ('tox.ini', '[pytest]')))

        def run(cmd, cwd, env=None):
            p = subprocess.run(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            sys.stdout.write(p.stdout); return p.returncode, p.stdout

        def test_env():
            env = dict((k, v) for k, v in os.environ.items() if not k.startswith(('AWS_', 'CODEBUILD_', 'ECS_', 'GIT_TOKEN')) and k != 'SKILL_MANIFEST_B64')
            env.update(PYTHONDONTWRITEBYTECODE='1', NO_COLOR='1', PYTHON_COLORS='0', PIP_DISABLE_PIP_VERSION_CHECK='1')
            return env

        def run_python_tests(root, files, venv, failures):
            if sys.version_info < (3, 11): failures.append('tests: Python 3.11 or later is required (the check ran %d.%d)' % sys.version_info[:2]); return
            reqs, pytest, python, env = [f for f in ('requirements.txt', 'requirements-dev.txt', 'requirements-test.txt') if f in files], has_pytest_config(root, files), sys.executable, test_env()
            vendor_dir = os.path.join(root, 'vendor')
            if os.path.isdir(vendor_dir): env['PYTHONPATH'] = vendor_dir + (os.pathsep + env['PYTHONPATH'] if 'PYTHONPATH' in env else '')
            if reqs or pytest:
                import venv as venvlib; venvlib.create(venv, with_pip=True, clear=True); python = os.path.join(venv, 'bin', 'python')
                for req in reqs:
                    if run([python, '-m', 'pip', 'install', '-q', '-r', req], root, env)[0] != 0: failures.append('build: pip could not install %s' % req); return
                if pytest and run([python, '-m', 'pip', 'install', '-q', 'pytest'], root, env)[0] != 0: failures.append('build: pip could not install pytest'); return
            code, out = run([python, '-m', 'unittest', 'discover', '-v'], root, env)
            ran = re.search(r'^Ran (\d+) tests?', out, re.MULTILINE)
            if ran is None or int(ran.group(1)) == 0:
                if not pytest: failures.append('tests: no tests found (unittest discovers test*.py files in importable folders)')
            elif code != 0: failures.append('tests: python -m unittest discover failed (%s)' % summary(out))
            if pytest:
                code, out = run([python, '-m', 'pytest', '-q', '--ignore=vendor'], root, env)
                if code == 5: failures.append('tests: pytest is configured but collected no tests')
                elif code != 0: failures.append('tests: pytest failed (%s)' % summary(out))

        def summary(out):
            for line in reversed(out.strip().splitlines()):
                s = line.strip()
                if s.startswith('FAILED') or ' failed' in s or s.startswith('ERROR'): return s[:120]
            return 'see the check log'

        def result(failures):
            shown = failures[:MAX_FAILURES]
            while True:
                more = len(failures) - len(shown)
                items = shown + (['... and %d more (see the check log)' % more] if more else [])
                out = json.dumps({'passed': not failures, 'failures': items}, separators=(',', ':'))
                if len(out) <= MAX_RESULT_CHARS or not shown: return out
                shown = shown[:-1]

        def main():
            ap = argparse.ArgumentParser()
            ap.add_argument('--dir', default='.')
            ap.add_argument('--manifest-b64', default=os.environ.get('SKILL_MANIFEST_B64', ''))
            ap.add_argument('--venv', default='/tmp/skill-check-venv')
            ap.add_argument('--out', default='')
            args = ap.parse_args()
            root, failures = os.path.abspath(args.dir), []
            try: registered = json.loads(base64.b64decode(args.manifest_b64).decode('utf-8')) if args.manifest_b64 else None
            except Exception: registered = None
            if not isinstance(registered, dict): failures.append('manifest: the registered manifest was not passed to the check'); registered = {}
            if not os.path.isdir(root): failures.append('source: the skill folder does not exist at this commit')
            else:
                files, language = rel_files(root), str(registered.get('language', ''))
                check_manifest(root, registered, failures); check_secrets(root, files, failures); check_dependencies(root, files, failures); check_other_hosts(root, files, failures)
                if language == 'python':
                    check_entry(root, str(registered.get('entry', '')), failures)
                    check_python(root, files, failures)
                    if not failures: run_python_tests(root, files, args.venv, failures)
                else: failures.append('language: %s is not supported by the factory checks yet (supported: python)' % (language or '(none)'))
            out = result(failures)
            for f in failures: print('SKILL CHECK FAILED: ' + f)
            print('SKILL_CHECK_RESULT=' + out)
            if args.out:
                with open(args.out, 'w') as f: f.write(out)

        if __name__ == '__main__':
            main()
        PY
  build:
    on-failure: ABORT
    commands:
      - echo "Skill check for $SKILL_ID@$SKILL_VERSION at $REPO_URL@$GIT_COMMIT ($SKILL_PATH)"
      - |
        SKILL_CHECK_RESULT='{"passed":false,"failures":["checks: the check did not run"]}'
        if [ -n "$PACKAGE_HASH" ]; then
          if ! [[ "$PACKAGE_HASH" =~ ^[0-9a-f]{64}$ ]]; then
            SKILL_CHECK_RESULT='{"passed":false,"failures":["source: package hash must be 64 hex characters"]}'
          else
            mkdir -p "skill-repo/$SKILL_PATH"
            PKG_FILE="/tmp/$PACKAGE_HASH.tar.gz"
            if [ -n "$PACKAGE_STORE_URI" ] && [[ "$PACKAGE_STORE_URI" =~ ^s3:// ]]; then
              aws s3 cp "$${PACKAGE_STORE_URI%/}/packages/$PACKAGE_HASH.tar.gz" "$PKG_FILE" 2>/dev/null || \
              aws s3 cp "$${PACKAGE_STORE_URI%/}/$PACKAGE_HASH.tar.gz" "$PKG_FILE" 2>/dev/null || true
            fi
            if [ -f "$PKG_FILE" ] && [ "$(python3 -c "import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest())" "$PKG_FILE")" = "$PACKAGE_HASH" ]; then
              if ! tar -xzf "$PKG_FILE" -C "skill-repo/$SKILL_PATH"; then
                SKILL_CHECK_RESULT='{"passed":false,"failures":["package: extraction failed (corrupt or invalid tar.gz)"]}'
              elif ! python3 /tmp/skill_check.py --dir "skill-repo/$SKILL_PATH" --venv /tmp/skill-check-venv --out /tmp/skill-check.json; then
                SKILL_CHECK_RESULT='{"passed":false,"failures":["check: skill check execution failed"]}'
              elif [ -s /tmp/skill-check.json ]; then
                SKILL_CHECK_RESULT="$(cat /tmp/skill-check.json)"
              fi
            else
              SKILL_CHECK_RESULT="{\"passed\":false,\"failures\":[\"source: could not fetch package $PACKAGE_HASH from package store\"]}"
            fi
          fi
        elif ! [[ "$GIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || [[ "$SKILL_PATH" == /* || "$SKILL_PATH" == *..* ]]; then
          SKILL_CHECK_RESULT='{"passed":false,"failures":["source: the pin must be a full commit and a folder inside the repository"]}'
        else
          AUTH=()
          # The source token goes only to an allowed source host; any other repo is cloned without it.
          host="$(printf '%s' "$REPO_URL" | sed -E 's#^https://([^/@]+)/.*#\1#' | tr 'A-Z' 'a-z')"; allowed=""
          for h in $SOURCE_TOKEN_HOSTS; do [ "$host" = "$h" ] && allowed=1; done
          if [ -n "$GIT_TOKEN_SECRET_ID" ] && [ -n "$allowed" ]; then
            GIT_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$GIT_TOKEN_SECRET_ID" --query SecretString --output text)" || GIT_TOKEN=""
            [ -n "$GIT_TOKEN" ] && AUTH=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)")
            unset GIT_TOKEN
          fi
          if GIT_TERMINAL_PROMPT=0 git "$${AUTH[@]}" clone --no-checkout -- "$REPO_URL" skill-repo \
            && (cd skill-repo && git -c advice.detachedHead=false checkout --detach "$GIT_COMMIT" && [ "$(git rev-parse HEAD)" = "$GIT_COMMIT" ]); then
            unset AUTH
            python3 /tmp/skill_check.py --dir "skill-repo/$SKILL_PATH" --venv /tmp/skill-check-venv --out /tmp/skill-check.json || true
            if [ -s /tmp/skill-check.json ]; then SKILL_CHECK_RESULT="$(cat /tmp/skill-check.json)"; fi
          else
            SKILL_CHECK_RESULT='{"passed":false,"failures":["source: could not fetch the repository at the pinned commit"]}'
          fi
          unset AUTH
        fi
        export SKILL_CHECK_RESULT
        echo "SKILL_CHECK_RESULT=$SKILL_CHECK_RESULT"
EOF
  }
}

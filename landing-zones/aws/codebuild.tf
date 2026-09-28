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
# mutable tag. Refusal reasons are exit codes that packages/control-plane/src/aws/codebuild.ts maps back:
# 3 = no_tests, 4 = tests_failed, 5 = source_unavailable; any other failure maps from its phase.
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
      - '[[ "$GIT_COMMIT" =~ ^[0-9a-f]{40}$ && "$IMAGE_TAG" == "$AGENT_ID-$(echo $GIT_COMMIT | cut -c1-12)" ]] || exit 5'
      - |
        AUTH=()
        if [ -n "$GIT_TOKEN_SECRET_ID" ]; then
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
      - docker build --label "org.opencontainers.image.revision=$GIT_COMMIT" --label "org.opencontainers.image.source=$REPO_URL" -t "$ECR_REPO_URI:$IMAGE_TAG" .
  post_build:
    on-failure: ABORT
    commands:
      - docker push "$ECR_REPO_URI:$IMAGE_TAG"
EOF
  }
}

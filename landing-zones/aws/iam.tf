data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

# Execution role: used by ECS itself to pull images and inject each task definition's `secrets`.
# Task code never receives these credentials.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "inject-factory-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = "${local.secret_arn}/*" }],
      # The agent source token may live outside the factory prefix; ECS injects it into the control plane only.
      var.agent_source_token_secret_arn == "" ? [] : [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.agent_source_token_secret_arn }],
    )
  })
}

locals {
  # By name, not by resource: the Keymaster creates these secrets (K5). `-??????` is the suffix AWS appends to
  # a secret's ARN, so NOTION_API_KEY never also matches NOTION_API_KEY_OTHER.
  # Gatekeeper-held secrets: the public defaults plus deployment-specific ones (TSK-045), until TSK-071.
  held_secret_names = distinct(concat(var.provider_secret_names, var.extra_provider_secret_names))
  # GAP-068 migration: the routes the control plane imports once as systems (never given to the gatekeeper-egress).
  systems_import       = jsonencode(concat(jsondecode(var.systems_import), jsondecode(var.extra_gatekeeper_egress_routes)))
  provider_secret_arns = [for n in local.held_secret_names : "${local.secret_arn}/${n}-??????"]
  # Gatekeeper-egress routes from variables (model routes only per E10; non-model routes are resolved dynamically via Control Plane)
  gatekeeper_egress_routes = var.gatekeeper_egress_routes
  # §6.11 K1: OAuth grants (one secret per agent x provider) and the app credentials they depend on. Only the
  # control plane's Keymaster reads or writes them; the gatekeeper-egress asks the control plane for access tokens.
  keymaster_grant_arns = ["${local.secret_arn}/connections/*"]
  # Legacy app-credential names (migrated providers), then the Keymaster-named entries for every provider (K5.1, TSK-067).
  keymaster_app_arns = ["${local.secret_arn}/GOOGLE_OAUTH_CLIENT*", "${local.secret_arn}/GOOGLE_SERVICE_ACCOUNT*", "${local.secret_arn}/LINKEDIN_OAUTH_CLIENT*", "${local.secret_arn}/shared/*/oauth-client-??????", "${local.secret_arn}/shared/*/service-account-key-??????"]
  telemetry_statement = {
    Sid      = "OtelToCloudWatch"
    Effect   = "Allow"
    Action   = ["cloudwatch:PutMetricData", "logs:PutLogEvents", "logs:CreateLogStream", "logs:CreateLogGroup", "logs:DescribeLogStreams"]
    Resource = "*"
  }
}

# ---- control plane ---------------------------------------------------------------------------

resource "aws_iam_role" "control_plane" {
  name               = "${local.name}-control-plane"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "control_plane" {
  name = "control-plane"
  role = aws_iam_role.control_plane.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "StartOnlyAgentTasks"
        Effect = "Allow"
        Action = ["ecs:RunTask"]
        Resource = [
          "arn:aws:ecs:${var.aws_region}:${var.account_id}:task-definition/${local.name}-agent-*",
          "arn:aws:ecs:${var.aws_region}:${var.account_id}:task-definition/agent-*"
        ]
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.factory.arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:StopTask", "ecs:DescribeTasks"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.factory.arn } }
      },
      {
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = concat([aws_iam_role.execution.arn], [for r in aws_iam_role.agent : r.arn], [
          "arn:aws:iam::${var.account_id}:role/factory-agent-exec-*",
          "arn:aws:iam::${var.account_id}:role/factory-agent-task-*"
        ])
      },
      {
        Sid      = "PreFlightReadsCartridgeSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "${local.secret_arn}/*"
      },
      {
        Sid      = "KeymasterGrantStore"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:CreateSecret", "secretsmanager:DescribeSecret"]
        Resource = concat(local.keymaster_grant_arns, local.keymaster_app_arns)
      },
      {
        # K5: owners supply an agent's static secrets through the Keymaster (write-only). Gatekeeper-held provider
        # keys stay unreadable: NeverReadProviderKeys below denies reading them.
        Sid      = "KeymasterAgentSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:PutSecretValue", "secretsmanager:CreateSecret", "secretsmanager:DescribeSecret"]
        Resource = "${local.secret_arn}/*"
      },
      {
        # K5.2: which credentials exist, in one metadata call per scan (names and version stages, never values), so
        # checking outstanding credentials does not cost one call per secret (GAP-056). ListSecrets has no resource scope.
        Sid      = "KeymasterListSecretNames"
        Effect   = "Allow"
        Action   = ["secretsmanager:ListSecrets"]
        Resource = "*"
      },
      {
        # The Keymaster (in the control plane) creates and writes gatekeeper-held keys (K5) but never reads them (S1).
        Sid      = "NeverReadProviderKeys"
        Effect   = "Deny"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"]
        Resource = local.provider_secret_arns
      },
      {
        Sid      = "LedgerWormAppendOnly"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.ledger_worm.arn, "${aws_s3_bucket.ledger_worm.arn}/*"]
      },
      {
        # §6.14 SK3: the configuration store reads every version on start (sync) and writes new versions. Versions are
        # immutable, and restore is an operator action on the versioned bucket.
        Sid      = "ConfigStoreList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.config.arn
      },
      {
        Sid      = "ConfigStoreReadWrite"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.config.arn}/*"
      },
      {
        # GAP-060: removing an agent's configuration records (orphans, purged agents) is `s3 rm --recursive` of its
        # prefix. The bucket is versioned, so a plain DeleteObject only adds a delete marker: every version stays
        # recoverable for the non-current retention period (R1). Objects only, never s3:DeleteObjectVersion.
        Sid      = "ConfigStoreRemove"
        Effect   = "Allow"
        Action   = ["s3:DeleteObject"]
        Resource = "${aws_s3_bucket.config.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
        Resource = [aws_efs_file_system.ledger.arn, aws_efs_access_point.ledger.arn]
      },
      {
        Sid      = "PublishFactoryEvents"
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = aws_cloudwatch_event_bus.factory.arn
      },
      {
        Sid      = "QueueTriggers"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = "arn:aws:sqs:${var.aws_region}:${var.account_id}:${local.name}-*"
      },
      {
        Sid      = "AssumeTreasurerRole"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = aws_iam_role.treasurer.arn
      },
      local.telemetry_statement,
    ]
  })
}

# §6.15 Treasurer: read-only access to Cost Explorer and ECS inventory.
# The control plane assumes this role; agents never hold credentials or reach Cost Explorer directly.
resource "aws_iam_role" "treasurer" {
  name = "${local.name}-treasurer"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.control_plane.arn
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "treasurer" {
  name = "treasurer"
  role = aws_iam_role.treasurer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CostExplorerReadOnly"
        Effect   = "Allow"
        Action   = [
          "ce:GetCostAndUsage",
          "ce:GetCostForecast",
          "ce:GetDimensionValues",
        ]
        Resource = "*"
      },
      {
        Sid      = "EcsInventoryReadOnly"
        Effect   = "Allow"
        Action   = [
          "ecs:ListServices",
          "ecs:DescribeServices",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
        ]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.factory.arn
          }
        }
      }
    ]
  })
}

# ---- gatekeeper-egress ---------------------------------------------------------------------------------

resource "aws_iam_role" "gatekeeper_egress" {
  name               = "${local.name}-gatekeeper-egress"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "gatekeeper_egress" {
  name = "gatekeeper-egress"
  role = aws_iam_role.gatekeeper_egress.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InjectProviderKeysOnly"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = concat(local.provider_secret_arns, ["${local.secret_arn}/*"])
      },
      {
        # K1/K3: the gatekeeper-egress never reads OAuth grants or app credentials; it gets short-lived tokens from the control plane.
        Sid      = "NeverKeymasterGrants"
        Effect   = "Deny"
        Action   = ["secretsmanager:*"]
        Resource = concat(local.keymaster_grant_arns, local.keymaster_app_arns)
      },
      {
        # Factory model API (§6.9): the gatekeeper-egress, never an agent, calls Bedrock. Converse is authorized by
        # bedrock:InvokeModel; cross-region inference profiles need both the profile and the foundation models.
        Sid    = "FactoryModelApiBedrock"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:*:${var.account_id}:inference-profile/*",
        ]
      },
      local.telemetry_statement,
    ]
  })
}

# ---- agents: one role each, scoped to its own mind prefix ------------------------------------

resource "aws_iam_role" "agent" {
  for_each           = var.agents
  name               = "${local.name}-agent-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "agent" {
  for_each = var.agents
  name     = "own-mind-only"
  role     = aws_iam_role.agent[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.mind.arn}/${each.key}/*"
      },
      {
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = aws_s3_bucket.mind.arn
        Condition = { StringLike = { "s3:prefix" = ["${each.key}/*", each.key] } }
      },
    ]
  })
}

# Extruded policy for Factory PaaS native deployments
resource "aws_iam_role_policy" "control_plane_paas" {
  name = "control-plane-paas-orchestration"
  role = aws_iam_role.control_plane.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:GetRole",
          "iam:PutRolePolicy",
          "iam:PassRole",
          "ecs:RegisterTaskDefinition",
          "codebuild:StartBuild",
          "codebuild:BatchGetBuilds",
          "secretsmanager:DescribeSecret"
        ]
        Resource = "*"
      },
      {
        # aws/iam.ts revokes an agent execution role's SecretsAccess when a redeploy no longer injects any secret
        # (its last one became gatekeeper-held, S1). aws/iam.ts names these roles AgentExecutionRole-<agent id>
        # (TSK-045: the old factory-agent-exec-* pattern matched no role it creates, so the revoke was AccessDenied).
        Effect   = "Allow"
        Action   = ["iam:DeleteRolePolicy"]
        Resource = "arn:aws:iam::${var.account_id}:role/AgentExecutionRole-*"
      }
    ]
  })
}

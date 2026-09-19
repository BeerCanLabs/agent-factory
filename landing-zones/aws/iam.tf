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
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = "${local.secret_arn}/*" }]
  })
}

locals {
  provider_secret_arns = [for s in aws_secretsmanager_secret.provider : s.arn]
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
        Sid       = "StartOnlyAgentTasks"
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = "arn:aws:ecs:${var.aws_region}:${var.account_id}:task-definition/${local.name}-agent-*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.factory.arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:StopTask", "ecs:DescribeTasks"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.factory.arn } }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = concat([aws_iam_role.execution.arn], [for r in aws_iam_role.agent : r.arn])
      },
      {
        Sid      = "PreFlightReadsCartridgeSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "${local.secret_arn}/*"
      },
      {
        Sid      = "NeverProviderKeys"
        Effect   = "Deny"
        Action   = ["secretsmanager:*"]
        Resource = [for arn in local.provider_secret_arns : "${arn}*"]
      },
      {
        Sid      = "LedgerWormAppendOnly"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.ledger_worm.arn, "${aws_s3_bucket.ledger_worm.arn}/*"]
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
      local.telemetry_statement,
    ]
  })
}

# ---- gateway ---------------------------------------------------------------------------------

resource "aws_iam_role" "gateway" {
  name               = "${local.name}-gateway"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "gateway" {
  name = "gateway"
  role = aws_iam_role.gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InjectProviderKeysOnly"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [for arn in local.provider_secret_arns : "${arn}*"]
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
        Effect   = "Allow"
        Action   = [
          "iam:CreateRole",
          "iam:PutRolePolicy",
          "iam:PassRole",
          "ecs:RegisterTaskDefinition",
          "codebuild:StartBuild",
          "codebuild:BatchGetBuilds"
        ]
        Resource = "*"
      }
    ]
  })
}

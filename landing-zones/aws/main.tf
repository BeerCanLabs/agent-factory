terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { owner = "beercanlabs", system = "agent-factory", environment = var.environment }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs          = slice(data.aws_availability_zones.available.names, 0, 2)
  images_ready = var.control_plane_image != "" && var.doorman_image != "" && var.sidecar_image != "" && var.echo_worker_image != ""
}

resource "aws_vpc" "factory" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "agent-factory-${var.environment}" }
}

resource "aws_internet_gateway" "factory" {
  vpc_id = aws_vpc.factory.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.factory.id
  cidr_block              = cidrsubnet(aws_vpc.factory.cidr_block, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "factory-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.factory.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.factory.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name   = "factory-alb-${var.environment}"
  vpc_id = aws_vpc.factory.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 8090
    to_port     = 8090
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "tasks" {
  name   = "factory-tasks-${var.environment}"
  vpc_id = aws_vpc.factory.id
  ingress {
    from_port       = 8088
    to_port         = 8090
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecr_repository" "control_plane" {
  name                 = "factory-control-plane"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_ecr_repository" "doorman" {
  name                 = "factory-doorman"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_ecr_repository" "sidecar" {
  name                 = "factory-sidecar"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_ecr_repository" "echo_worker" {
  name                 = "factory-echo-worker"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_s3_bucket" "mind" {
  bucket        = "agent-factory-mind-${var.environment}-${random_id.suffix.hex}"
  force_destroy = true
}

# Write-once ledger copy. COMPLIANCE-mode Object Lock: no principal, including root, can delete or
# overwrite a checkpoint before its retention date. This bucket cannot be destroyed while locked.
resource "aws_s3_bucket" "ledger_worm" {
  bucket              = "agent-factory-ledger-${var.environment}-${random_id.suffix.hex}"
  object_lock_enabled = true
  force_destroy       = false
}

resource "aws_s3_bucket_versioning" "ledger_worm" {
  bucket = aws_s3_bucket.ledger_worm.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "ledger_worm" {
  bucket = aws_s3_bucket.ledger_worm.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.ledger_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.ledger_worm]
}

resource "aws_s3_bucket_public_access_block" "ledger_worm" {
  bucket                  = aws_s3_bucket.ledger_worm.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ledger_worm" {
  bucket = aws_s3_bucket.ledger_worm.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "random_password" "factory_token" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "factory_token" {
  name = "factory/${var.environment}/FACTORY_TOKEN"
}

resource "aws_secretsmanager_secret_version" "factory_token" {
  secret_id     = aws_secretsmanager_secret.factory_token.id
  secret_string = random_password.factory_token.result
}

locals {
  readable_secret_arns = concat(
    [aws_secretsmanager_secret.factory_token.arn, aws_secretsmanager_secret.echo_webhook.arn, aws_secretsmanager_secret.factory_tokens.arn],
    [for s in aws_secretsmanager_secret.service : s.arn],
  )
  # One credential per caller->callee edge, each with its least role.
  service_tokens = toset(["DOORMAN_OPERATOR_TOKEN", "SIDECAR_INGEST_TOKEN", "DOORMAN_TOKEN", "SIDECAR_TOKEN", "FACTORY_RUN_TOKEN_KEY", "FACTORY_CALLBACK_SIGNING_KEY"])
}

resource "random_password" "service" {
  for_each = local.service_tokens
  length   = 40
  special  = false
}

resource "aws_secretsmanager_secret" "service" {
  for_each = local.service_tokens
  name     = "factory/${var.environment}/${each.key}"
}

resource "aws_secretsmanager_secret_version" "service" {
  for_each      = local.service_tokens
  secret_id     = aws_secretsmanager_secret.service[each.key].id
  secret_string = random_password.service[each.key].result
}

resource "aws_secretsmanager_secret" "factory_tokens" {
  name = "factory/${var.environment}/FACTORY_TOKENS"
}

resource "aws_secretsmanager_secret_version" "factory_tokens" {
  secret_id = aws_secretsmanager_secret.factory_tokens.id
  secret_string = jsonencode([
    { name = "doorman", token = random_password.service["DOORMAN_OPERATOR_TOKEN"].result, roles = ["operator"] },
    { name = "sidecar", token = random_password.service["SIDECAR_INGEST_TOKEN"].result, roles = ["ingest"] },
  ])
}

resource "aws_secretsmanager_secret" "echo_webhook" {
  name = "factory/${var.environment}/ECHO_WEBHOOK_SECRET"
}

resource "aws_secretsmanager_secret_version" "echo_webhook" {
  secret_id     = aws_secretsmanager_secret.echo_webhook.id
  secret_string = random_password.echo_webhook.result
}

resource "random_password" "echo_webhook" {
  length  = 24
  special = false
}

resource "aws_efs_file_system" "ledger" {
  encrypted = true
  tags      = { Name = "factory-ledger-${var.environment}" }
}

resource "aws_efs_mount_target" "ledger" {
  count           = 2
  file_system_id  = aws_efs_file_system.ledger.id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.efs.id]
}

resource "aws_security_group" "efs" {
  name   = "factory-efs-${var.environment}"
  vpc_id = aws_vpc.factory.id
  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_cluster" "factory" {
  name = "agent-factory-${var.environment}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "factory" {
  name              = "/ecs/agent-factory-${var.environment}"
  retention_in_days = 30
}

resource "aws_iam_role" "execution" {
  name = "factory-exec-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-factory-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = local.readable_secret_arns
    }]
  })
}

resource "aws_iam_role" "task" {
  name = "factory-task-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Agent tasks: mind bucket only. No ECS control, no factory secrets (those arrive via the
# execution role's `secrets` injection, scoped per task definition).
resource "aws_iam_role_policy" "task" {
  name = "factory-agent-task"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"]
      Resource = [aws_s3_bucket.mind.arn, "${aws_s3_bucket.mind.arn}/*"]
    }]
  })
}

resource "aws_iam_role" "control_plane" {
  name = "factory-control-plane-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role_policy" "control_plane" {
  name = "factory-control-plane"
  role = aws_iam_role.control_plane.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/factory-agent-*"
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
        Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
      },
      {
        Sid      = "PreFlightReadsCartridgeSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:factory/${var.environment}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.mind.arn, "${aws_s3_bucket.mind.arn}/*"]
      },
      {
        Sid      = "LedgerWormAppendOnly"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.ledger_worm.arn, "${aws_s3_bucket.ledger_worm.arn}/*"]
      }
    ]
  })
}

resource "aws_lb" "factory" {
  name               = "factory-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "control" {
  name        = "factory-cp-${var.environment}"
  port        = 8088
  protocol    = "HTTP"
  vpc_id      = aws_vpc.factory.id
  target_type = "ip"
  health_check {
    path = "/healthz"
  }
}

resource "aws_lb_target_group" "doorman" {
  name        = "factory-door-${var.environment}"
  port        = 8090
  protocol    = "HTTP"
  vpc_id      = aws_vpc.factory.id
  target_type = "ip"
  health_check {
    path = "/healthz"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.factory.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control.arn
  }
}

resource "aws_lb_listener" "doorman" {
  load_balancer_arn = aws_lb.factory.arn
  port              = 8090
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.doorman.arn
  }
}

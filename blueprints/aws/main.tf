terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_ecs_cluster" "agent_factory" {
  name = "agent-factory-${var.environment}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = {
    "factory-kernel" = "true"
    Environment      = var.environment
  }
}

resource "aws_s3_bucket" "mind" {
  bucket = "agent-factory-mind-${var.environment}-${var.agent_id}"
}

resource "aws_cloudwatch_log_group" "factory" {
  name              = "/ecs/agent-factory-${var.environment}"
  retention_in_days = 30
}

resource "aws_iam_role" "execution" {
  name = "agent-factory-exec-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name = "agent-factory-task-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "task_bind" {
  name = "secret-bind-and-mind"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "MindBucket"
          Effect   = "Allow"
          Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
          Resource = [aws_s3_bucket.mind.arn, "${aws_s3_bucket.mind.arn}/*"]
        }
      ],
      length(var.secret_arns) == 0 ? [] : [
        {
          Sid      = "BindNamedSecrets"
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue"]
          Resource = var.secret_arns
        }
      ]
    )
  })
}

resource "aws_ecs_task_definition" "agent" {
  family                   = "factory-${var.agent_id}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.worker_image
      essential = true
      environment = [
        { name = "OPENAI_BASE_URL", value = "http://127.0.0.1:8080" },
        { name = "MEMORY_STORE_URI", value = "s3://${aws_s3_bucket.mind.bucket}/${var.agent_id}" },
        { name = "AGENT_ID", value = var.agent_id }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.factory.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }
    },
    {
      name      = "sidecar"
      image     = var.sidecar_image
      essential = true
      portMappings = [{ containerPort = 9090, hostPort = 9090 }]
      environment = [
        { name = "PORT", value = "9090" },
        { name = "PROXY_PORT", value = "8080" },
        { name = "AGENT_ID", value = var.agent_id },
        { name = "FACTORY_LEDGER_URL", value = var.factory_ledger_url }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.factory.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "sidecar"
        }
      }
    }
  ])

  tags = {
    "factory-agent" = "true"
    "agent-id"      = var.agent_id
  }
}

resource "aws_iam_role" "scheduler" {
  name = "agent-factory-scheduler-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_run" {
  name = "run-task-from-zero"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecs:RunTask", "iam:PassRole"]
      Resource = "*"
    }]
  })
}

# No 24/7 service (desiredCount=1). EventBridge Scheduler runs a task from zero.
resource "aws_scheduler_schedule" "wake" {
  name                         = "factory-wake-${var.agent_id}"
  schedule_expression          = "rate(1 hour)"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_ecs_cluster.agent_factory.arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.agent.arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = var.subnet_ids
        security_groups  = var.security_group_ids
        assign_public_ip = false
      }
    }
  }
}

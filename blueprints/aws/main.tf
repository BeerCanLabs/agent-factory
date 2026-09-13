terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "environment" {
  type        = string
  default     = "production"
  description = "Deployment environment (e.g. production, staging)"
}

variable "garrison_c2_url" {
  type        = string
  default     = "https://garrison.enterprise.internal"
  description = "Agent Garrison C2 endpoint URL for heartbeats and telemetry"
}

# 1. AWS ECS Cluster for Agent Factory
resource "aws_ecs_cluster" "agent_factory" {
  name = "agent-factory-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    "garrison-managed" = "true"
    "Environment"      = var.environment
  }
}

# 2. IAM Role for Bedrock & Garrison C2 Access
resource "aws_iam_role" "agent_task_execution_role" {
  name = "agent-factory-task-exec-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "bedrock_access" {
  role       = aws_iam_role.agent_task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonBedrockFullAccess"
}

# 3. Hermes Autonomous Agent Task Definition on ECS Fargate
resource "aws_ecs_task_definition" "hermes_agent" {
  family                   = "hermes-researcher"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.agent_task_execution_role.arn
  task_role_arn            = aws_iam_role.agent_task_execution_role.arn

  container_definitions = jsonencode([
    {
      name      = "hermes-worker"
      image     = "ghcr.io/beercanlabs/agent-hermes:latest"
      essential = true
      portMappings = [{
        containerPort = 9090
        hostPort      = 9090
      }]
      environment = [
        { name = "GARRISON_URL", value = var.garrison_c2_url },
        { name = "AGENT_ID", value = "hermes-aws-01" },
        { name = "AGENT_NAME", value = "Hermes-AWS-Prime" },
        { name = "AGENT_SECTOR", value = "sector-eng" },
        { name = "AGENT_PROVIDER", value = "aws-ecs" },
        { name = "AGENT_MODEL", value = "anthropic.claude-3-7-sonnet-20250219-v1:0" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/agent-factory"
          "awslogs-region"        = "us-east-1"
          "awslogs-stream-prefix" = "hermes"
        }
      }
    }
  ])

  tags = {
    "garrison-agent"  = "true"
    "garrison-sector" = "sector-eng"
    "garrison-model"  = "bedrock-claude-3.7"
  }
}

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
  region = var.aws_region
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs    = slice(data.aws_availability_zones.available.names, 0, 2)
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
      Resource = [aws_secretsmanager_secret.factory_token.arn, aws_secretsmanager_secret.echo_webhook.arn]
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

resource "aws_iam_role_policy" "task" {
  name = "factory-task"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"]
        Resource = [aws_s3_bucket.mind.arn, "${aws_s3_bucket.mind.arn}/*"]
      },
      {
        Effect = "Allow"
        Action = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.factory_token.arn, aws_secretsmanager_secret.echo_webhook.arn]
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

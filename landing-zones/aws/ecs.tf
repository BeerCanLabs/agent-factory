locals {
  subnet_ids = aws_subnet.public[*].id
  cp_env = [
    { name = "PORT", value = "8088" },
    { name = "AGENTS_ROOT", value = "/app/agents" },
    { name = "FACTORY_OIDC_ISSUER", value = var.oidc_issuer },
    { name = "FACTORY_OIDC_AUDIENCE", value = var.oidc_audience },
    { name = "FACTORY_RUNTIME", value = "ecs" },
    { name = "FACTORY_ECS_CLUSTER", value = aws_ecs_cluster.factory.name },
    { name = "FACTORY_ECS_SUBNETS", value = join(",", local.subnet_ids) },
    { name = "FACTORY_ECS_SECURITY_GROUPS", value = aws_security_group.tasks.id },
    { name = "FACTORY_ECS_TASKS", value = "echo-agent:factory-agent-echo-${var.environment}" },
    { name = "FACTORY_LEDGER_PATH", value = "/data/ledger.jsonl" },
    { name = "FACTORY_RUNS_DIR", value = "/data/runs" },
    { name = "FACTORY_LEDGER_WORM_URI", value = "s3://${aws_s3_bucket.ledger_worm.bucket}/ledger" },
    { name = "FACTORY_LEDGER_RETENTION_DAYS", value = tostring(var.ledger_retention_days) },
    { name = "FACTORY_SECRETS_AWS_PREFIX", value = "factory/${var.environment}/" },
    { name = "FACTORY_PUBLIC_URL", value = "http://${aws_lb.factory.dns_name}" },
    { name = "MEMORY_STORE_URI", value = "s3://${aws_s3_bucket.mind.bucket}" },
    { name = "DOORMAN_URL", value = "http://${aws_lb.factory.dns_name}:8090" },
  ]
}

resource "aws_ecs_task_definition" "control_plane" {
  count                    = local.images_ready ? 1 : 0
  family                   = "factory-control-plane"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn

  volume {
    name = "ledger"
    efs_volume_configuration {
      file_system_id = aws_efs_file_system.ledger.id
    }
  }

  container_definitions = jsonencode([{
    name         = "control-plane"
    image        = var.control_plane_image
    essential    = true
    portMappings = [{ containerPort = 8088, hostPort = 8088 }]
    environment  = local.cp_env
    secrets = [
      { name = "FACTORY_TOKEN", valueFrom = aws_secretsmanager_secret.factory_token.arn },
      { name = "FACTORY_TOKENS", valueFrom = aws_secretsmanager_secret.factory_tokens.arn },
      { name = "DOORMAN_TOKEN", valueFrom = aws_secretsmanager_secret.service["DOORMAN_TOKEN"].arn },
      { name = "FACTORY_RUN_TOKEN_KEY", valueFrom = aws_secretsmanager_secret.service["FACTORY_RUN_TOKEN_KEY"].arn },
      { name = "FACTORY_CALLBACK_SIGNING_KEY", valueFrom = aws_secretsmanager_secret.service["FACTORY_CALLBACK_SIGNING_KEY"].arn },
    ]
    mountPoints = [{ sourceVolume = "ledger", containerPath = "/data" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.factory.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "control-plane"
      }
    }
  }])
}

resource "aws_ecs_service" "control_plane" {
  count           = local.images_ready ? 1 : 0
  name            = "factory-control-plane"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.control_plane[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.control.arn
    container_name   = "control-plane"
    container_port   = 8088
  }
  depends_on = [aws_lb_listener.http, aws_efs_mount_target.ledger]
}

resource "aws_ecs_task_definition" "doorman" {
  count                    = local.images_ready ? 1 : 0
  family                   = "factory-doorman"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name         = "doorman"
    image        = var.doorman_image
    essential    = true
    portMappings = [{ containerPort = 8090, hostPort = 8090 }]
    environment = [
      { name = "PORT", value = "8090" },
      { name = "FACTORY_URL", value = "http://${aws_lb.factory.dns_name}" },
    ]
    secrets = [
      { name = "FACTORY_TOKEN", valueFrom = aws_secretsmanager_secret.service["DOORMAN_OPERATOR_TOKEN"].arn },
      { name = "DOORMAN_TOKEN", valueFrom = aws_secretsmanager_secret.service["DOORMAN_TOKEN"].arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.factory.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "doorman"
      }
    }
  }])
}

resource "aws_ecs_service" "doorman" {
  count           = local.images_ready ? 1 : 0
  name            = "factory-doorman"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.doorman[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.doorman.arn
    container_name   = "doorman"
    container_port   = 8090
  }
  depends_on = [aws_lb_listener.doorman]
}

# One agent task = the worker image under the factory shim. No ECS service: the control plane
# RunTasks it from zero. Its only route out is the egress gateway.
resource "aws_ecs_task_definition" "echo" {
  family                   = "factory-agent-echo-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  count                    = local.images_ready ? 1 : 0

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.echo_worker_image
      essential = true
      environment = [
        { name = "AGENT_ID", value = "echo-agent" },
        { name = "MEMORY_DIR", value = "/tmp/mind" },
        { name = "MEMORY_PREFIX", value = "echo-agent" },
        { name = "MEMORY_STORE_URI", value = "s3://${aws_s3_bucket.mind.bucket}" },
        { name = "FACTORY_GATEWAY_URL", value = local.gateway_url },
      ]
      secrets = [
        { name = "ECHO_WEBHOOK_SECRET", valueFrom = aws_secretsmanager_secret.echo_webhook.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.factory.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "echo-worker"
        }
      }
    }
  ])
}

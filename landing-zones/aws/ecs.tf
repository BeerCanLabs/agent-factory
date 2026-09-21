resource "aws_ecs_cluster" "factory" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  log = { for svc in ["control-plane", "gateway", "doorman", "otel", "agent"] : svc => {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.factory.name
      "awslogs-region"        = var.aws_region
      "awslogs-stream-prefix" = svc
    }
  } }

  # ADOT collector: receives OTLP from the service on localhost, emits CloudWatch EMF metrics.
  otel = {
    name             = "otel"
    image            = var.otel_collector_image
    essential        = false
    command          = ["--config=/etc/ecs/ecs-default-config.yaml"]
    logConfiguration = local.log["otel"]
  }
  otel_env = [{ name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" }]

  secret = { for k in local.generated : k => aws_secretsmanager_secret.generated[k].arn }

  agent_task_map = join(",", [for id, _ in local.agent_images : "${id}:${local.name}-agent-${id}"])
}

# ---- control plane: the only ledger writer ---------------------------------------------------

resource "aws_ecs_task_definition" "control_plane" {
  count                    = local.images_ready ? 1 : 0
  family                   = "${local.name}-control-plane"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn

  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.ledger.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.ledger.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name         = "control-plane"
      image        = var.control_plane_image
      essential    = true
      portMappings = [{ containerPort = 8088 }]
      environment = concat(local.otel_env, [
        { name = "PORT", value = "8088" },
        { name = "AGENTS_ROOT", value = "/app/agents" },
        { name = "FACTORY_OIDC_ISSUER", value = var.oidc_issuer },
        { name = "FACTORY_OIDC_AUDIENCE", value = var.oidc_audience },
        { name = "FACTORY_OIDC_ROLES_CLAIM", value = var.oidc_roles_claim },
        { name = "FACTORY_RUNTIME", value = "ecs" },
        { name = "FACTORY_ECS_CLUSTER", value = aws_ecs_cluster.factory.name },
        { name = "FACTORY_ECS_SUBNETS", value = join(",", aws_subnet.agents[*].id) },
        { name = "FACTORY_ECS_SECURITY_GROUPS", value = aws_security_group.agents.id },
        { name = "FACTORY_ECS_ASSIGN_PUBLIC_IP", value = "false" },
        { name = "FACTORY_ECS_TASKS", value = local.agent_task_map },
        { name = "FACTORY_LEDGER_PATH", value = "/data/ledger.jsonl" },
        { name = "FACTORY_LEDGER_WORM_URI", value = "s3://${aws_s3_bucket.ledger_worm.bucket}/ledger" },
        { name = "FACTORY_LEDGER_RETENTION_DAYS", value = tostring(var.ledger_retention_days) },
        { name = "FACTORY_SECRETS_AWS_PREFIX", value = "factory/${var.environment}/" },
        { name = "FACTORY_PUBLIC_URL", value = local.cp_url },
        { name = "FACTORY_GATEWAY_URL", value = local.gateway_url },
        { name = "DOORMAN_URL", value = local.doorman_url },
        { name = "FACTORY_EVENT_BUS", value = "eventbridge:${aws_cloudwatch_event_bus.factory.name}" },
        { name = "MEMORY_STORE_DIR", value = "/tmp/mind" },
        { name = "MEMORY_EPHEMERAL_DIR", value = "/tmp/ephemeral" },
      ])
      secrets = [
        { name = "FACTORY_TOKEN", valueFrom = local.secret["FACTORY_TOKEN"] },
        { name = "FACTORY_TOKENS", valueFrom = aws_secretsmanager_secret.factory_tokens.arn },
        { name = "DOORMAN_TOKEN", valueFrom = local.secret["DOORMAN_TOKEN"] },
        { name = "FACTORY_RUN_TOKEN_KEY", valueFrom = local.secret["FACTORY_RUN_TOKEN_KEY"] },
        { name = "FACTORY_CALLBACK_SIGNING_KEY", valueFrom = local.secret["FACTORY_CALLBACK_SIGNING_KEY"] },
      ]
      mountPoints      = [{ sourceVolume = "data", containerPath = "/data" }]
      stopTimeout      = 30
      logConfiguration = local.log["control-plane"]
    },
    local.otel,
  ])
}

resource "aws_ecs_service" "control_plane" {
  count           = local.images_ready ? 1 : 0
  name            = "control-plane"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.control_plane[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  # Stop the old task before starting the new one: two writers would fork the ledger chain.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  network_configuration {
    subnets          = aws_subnet.service[*].id
    security_groups  = [aws_security_group.control_plane.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.control.arn
    container_name   = "control-plane"
    container_port   = 8088
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc["control-plane"].arn
  }
  depends_on = [aws_lb_listener.https, aws_efs_mount_target.ledger]
}

# ---- gateway: the only route out for agents --------------------------------------------------

resource "aws_ecs_task_definition" "gateway" {
  count                    = local.images_ready ? 1 : 0
  family                   = "${local.name}-gateway"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.gateway.arn
  container_definitions = jsonencode([
    {
      name         = "gateway"
      image        = var.gateway_image
      essential    = true
      portMappings = [{ containerPort = 8081 }]
      environment = concat(local.otel_env, [
        { name = "PORT", value = "8081" },
        { name = "FACTORY_URL", value = local.cp_url },
        { name = "FACTORY_SECRETS_AWS_PREFIX", value = "factory/${var.environment}/" },
        { name = "FACTORY_GATEWAY_ROUTES", value = var.gateway_routes },
        { name = "FACTORY_PRICES", value = var.gateway_prices },
        { name = "FACTORY_TRACE_PROMPTS", value = var.trace_prompts ? "on" : "off" },
        { name = "FACTORY_TRACE_DIR", value = "/tmp/traces" },
      ])
      secrets = [
        { name = "FACTORY_GATEWAY_TOKEN", valueFrom = local.secret["GATEWAY_TOKEN"] },
        { name = "FACTORY_RUN_TOKEN_KEY", valueFrom = local.secret["FACTORY_RUN_TOKEN_KEY"] },
      ]
      logConfiguration = local.log["gateway"]
    },
    local.otel,
  ])
}

resource "aws_ecs_service" "gateway" {
  count           = local.images_ready ? 1 : 0
  name            = "gateway"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.gateway[0].arn
  desired_count   = var.gateway_count
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
  network_configuration {
    subnets          = aws_subnet.service[*].id
    security_groups  = [aws_security_group.gateway.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc["gateway"].arn
  }
}

# ---- doorman ---------------------------------------------------------------------------------

resource "aws_iam_role" "doorman" {
  name               = "${local.name}-doorman"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "doorman" {
  name = "discord-token-only"
  role = aws_iam_role.doorman.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = "${local.secret_arn}/*DISCORD_BOT_TOKEN*" }]
  })
}

resource "aws_ecs_task_definition" "doorman" {
  count                    = local.images_ready ? 1 : 0
  family                   = "${local.name}-doorman"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.doorman.arn
  container_definitions = jsonencode([{
    name         = "doorman"
    image        = var.doorman_image
    essential    = true
    portMappings = [{ containerPort = 8090 }]
    environment = [
      { name = "PORT", value = "8090" },
      { name = "FACTORY_URL", value = local.cp_url },
      { name = "FACTORY_SECRETS_AWS_PREFIX", value = "factory/${var.environment}/" },
    ]
    secrets = [
      { name = "FACTORY_TOKEN", valueFrom = local.secret["DOORMAN_OPERATOR_TOKEN"] },
      { name = "DOORMAN_TOKEN", valueFrom = local.secret["DOORMAN_TOKEN"] },
    ]
    logConfiguration = local.log["doorman"]
  }])
}

resource "aws_ecs_service" "doorman" {
  count           = local.images_ready ? 1 : 0
  name            = "doorman"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.doorman[0].arn
  desired_count   = 1
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
  network_configuration {
    subnets          = aws_subnet.service[*].id
    security_groups  = [aws_security_group.doorman.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc["doorman"].arn
  }
}

# ---- agents: task definitions only; the control plane RunTasks them from zero -----------------

resource "aws_ecs_task_definition" "agent" {
  for_each                 = local.agent_images
  family                   = "${local.name}-agent-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.agents[each.key].cpu)
  memory                   = tostring(var.agents[each.key].memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.agent[each.key].arn
  container_definitions = jsonencode([{
    name      = "worker"
    image     = each.value
    essential = true
    environment = [
      { name = "AGENT_ID", value = each.key },
      { name = "MEMORY_DIR", value = "/tmp/mind" },
      { name = "MEMORY_PREFIX", value = each.key },
      { name = "MEMORY_STORE_URI", value = "s3://${aws_s3_bucket.mind.bucket}" },
      { name = "FACTORY_GATEWAY_URL", value = local.gateway_url },
      { name = "FACTORY_URL", value = local.cp_url },
    ]
    secrets          = [for name in var.agents[each.key].secrets : { name = name, valueFrom = "${local.secret_arn}/${name}" }]
    logConfiguration = local.log["agent"]
  }])
}

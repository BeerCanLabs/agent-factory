resource "aws_ecs_cluster" "factory" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  log = { for svc in ["control-plane", "gatekeeper-egress", "gatekeeper-ingress", "otel", "agent"] : svc => {
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
        { name = "AWS_ACCOUNT_ID", value = var.account_id },
        { name = "FACTORY_OIDC_ISSUER", value = var.oidc_issuer },
        { name = "FACTORY_OIDC_AUDIENCE", value = var.oidc_audience },
        { name = "FACTORY_OIDC_ROLES_CLAIM", value = var.oidc_roles_claim },
        # §6.12 A2: identity only from the proxy's verified assertion; empty disables it.
        { name = "FACTORY_ACCESS_TEAM_DOMAIN", value = var.access_team_domain },
        { name = "FACTORY_ACCESS_AUD", value = var.access_aud },
        { name = "FACTORY_ADMIN_EMAILS", value = var.admin_emails },
        { name = "FACTORY_RUNTIME", value = "ecs" },
        { name = "FACTORY_ECS_CLUSTER", value = aws_ecs_cluster.factory.name },
        { name = "FACTORY_ECS_SUBNETS", value = join(",", aws_subnet.agents[*].id) },
        { name = "FACTORY_ECS_SECURITY_GROUPS", value = aws_security_group.agents.id },
        { name = "FACTORY_ECS_ASSIGN_PUBLIC_IP", value = "false" },
        { name = "FACTORY_DEFAULT_POLICY", value = jsonencode({ routes = ["anthropic", "openai", "discord", "google-calendar", "google-oauth", "google-gmail", "google-drive"] }) },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_DEFAULT_REGION", value = var.aws_region },
        { name = "FACTORY_ECS_TASKS", value = local.agent_task_map },
        # Agent admission builds (§6.8 L3/L4) push <agentId>-<commit[:12]> images here.
        { name = "FACTORY_ECR_REPO_URI", value = aws_ecr_repository.dynamic_agents.repository_url },
        { name = "FACTORY_AGENT_BUILDER_PROJECT", value = aws_codebuild_project.factory_agent_builder.name },
        { name = "FACTORY_LEDGER_PATH", value = "/data/ledger.jsonl" },
        { name = "FACTORY_LEDGER_WORM_URI", value = "s3://${aws_s3_bucket.ledger_worm.bucket}/ledger" },
        { name = "FACTORY_LEDGER_RETENTION_DAYS", value = tostring(var.ledger_retention_days) },
        # LG2 recovery: empty except for the one deploy that archives a failed ledger (exact failing seq + reason).
        { name = "FACTORY_LEDGER_RECOVER_SEQ", value = var.ledger_recover_seq },
        { name = "FACTORY_LEDGER_RECOVER_REASON", value = var.ledger_recover_reason },
        { name = "FACTORY_SECRETS_AWS_PREFIX", value = "factory/${var.environment}/" },
        { name = "FACTORY_PUBLIC_URL", value = local.cp_url },
        # §6.11: where people's browsers reach the factory (OAuth consent callbacks and reconnect links).
        { name = "FACTORY_PUBLIC_BASE_URL", value = var.factory_public_base_url },
        { name = "FACTORY_GATEKEEPER_EGRESS_URL", value = local.gatekeeper_egress_url },
        # Where factory-registered agents keep their minds and send logs (aws/ecs.ts registers their task definitions).
        { name = "FACTORY_MIND_BUCKET", value = aws_s3_bucket.mind.bucket },
        { name = "FACTORY_LOG_GROUP", value = aws_cloudwatch_log_group.factory.name },
        # Gatekeeper-held secrets (S1): the control plane is denied them, pre-flight never reads them, and they are
        # never put in an agent task definition (aws/ecs.ts).
        { name = "FACTORY_GATEKEEPER_EGRESS_HELD_SECRETS", value = join(",", local.held_secret_names) },
        { name = "GATEKEEPER_INGRESS_URL", value = local.gatekeeper_ingress_url },
        { name = "FACTORY_EVENT_BUS", value = "eventbridge:${aws_cloudwatch_event_bus.factory.name}" },
        { name = "MEMORY_STORE_DIR", value = "/tmp/mind" },
        { name = "MEMORY_EPHEMERAL_DIR", value = "/tmp/ephemeral" },
        { name = "FACTORY_IDLE_MS", value = "3600000" },
      ])
      secrets = [
        { name = "FACTORY_TOKEN", valueFrom = local.secret["FACTORY_TOKEN"] },
        { name = "FACTORY_TOKENS", valueFrom = aws_secretsmanager_secret.factory_tokens.arn },
        { name = "GATEKEEPER_INGRESS_TOKEN", valueFrom = local.secret["GATEKEEPER_INGRESS_TOKEN"] },
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
  # LG1: stop the old task before starting the new one: two writers would tear and fork the ledger chain.
  # (6bf03d0 flipped this to 100/200 under the same comment; conformance now fails if it changes.)
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
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

# ---- gatekeeper-egress: the only route out for agents --------------------------------------------------

resource "aws_ecs_task_definition" "gatekeeper_egress" {
  count                    = local.images_ready ? 1 : 0
  family                   = "${local.name}-gatekeeper-egress"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.gatekeeper_egress.arn
  container_definitions = jsonencode([
    {
      name         = "gatekeeper-egress"
      image        = var.gatekeeper_egress_image
      essential    = true
      portMappings = [{ containerPort = 8081 }]
      environment = concat(local.otel_env, [
        { name = "PORT", value = "8081" },
        { name = "FACTORY_URL", value = local.cp_url },
      { name = "FACTORY_CONTROL_PLANE_URL", value = local.cp_url },
        { name = "FACTORY_SECRETS_AWS_PREFIX", value = "factory/${var.environment}/" },
        { name = "FACTORY_GATEKEEPER_EGRESS_ROUTES", value = local.gatekeeper_egress_routes },
        { name = "FACTORY_PRICES", value = var.gatekeeper_egress_prices },
        { name = "FACTORY_MODEL_CATALOG", value = jsonencode({ for name, m in var.model_catalog : name => { for k, v in m : k => v if v != null } }) },
        { name = "FACTORY_TRACE_PROMPTS", value = var.trace_prompts ? "on" : "off" },
        { name = "FACTORY_TRACE_DIR", value = "/tmp/traces" },
      ])
      secrets = [
        { name = "FACTORY_GATEKEEPER_EGRESS_TOKEN", valueFrom = local.secret["GATEKEEPER_EGRESS_TOKEN"] },
        { name = "FACTORY_RUN_TOKEN_KEY", valueFrom = local.secret["FACTORY_RUN_TOKEN_KEY"] },
      ]
      logConfiguration = local.log["gatekeeper-egress"]
    },
    local.otel,
  ])
}

resource "aws_ecs_service" "gatekeeper_egress" {
  count           = local.images_ready ? 1 : 0
  name            = "gatekeeper-egress"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.gatekeeper_egress[0].arn
  desired_count   = var.gatekeeper_egress_count
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
  network_configuration {
    subnets          = aws_subnet.service[*].id
    security_groups  = [aws_security_group.gatekeeper_egress.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc["gatekeeper-egress"].arn
  }
}

# ---- gatekeeper-ingress ---------------------------------------------------------------------------------

resource "aws_iam_role" "gatekeeper_ingress" {
  name               = "${local.name}-gatekeeper-ingress"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "gatekeeper_ingress" {
  name = "discord-token-only"
  role = aws_iam_role.gatekeeper_ingress.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = "${local.secret_arn}/*DISCORD_BOT_TOKEN*" }]
  })
}

resource "aws_ecs_task_definition" "gatekeeper_ingress" {
  count                    = local.images_ready ? 1 : 0
  family                   = "${local.name}-gatekeeper-ingress"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.gatekeeper_ingress.arn
  container_definitions = jsonencode([{
    name         = "gatekeeper-ingress"
    image        = var.gatekeeper_ingress_image
    essential    = true
    portMappings = [{ containerPort = 8090 }]
    environment = [
      { name = "PORT", value = "8090" },
      { name = "FACTORY_URL", value = local.cp_url },
      { name = "FACTORY_CONTROL_PLANE_URL", value = local.cp_url },
      { name = "FACTORY_SECRETS_AWS_PREFIX", value = "factory/${var.environment}/" },
    ]
    secrets = [
      { name = "FACTORY_TOKEN", valueFrom = local.secret["GATEKEEPER_INGRESS_OPERATOR_TOKEN"] },
      { name = "GATEKEEPER_INGRESS_TOKEN", valueFrom = local.secret["GATEKEEPER_INGRESS_TOKEN"] },
    ]
    logConfiguration = local.log["gatekeeper-ingress"]
  }])
}

resource "aws_ecs_service" "gatekeeper_ingress" {
  count           = local.images_ready ? 1 : 0
  name            = "gatekeeper-ingress"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.gatekeeper_ingress[0].arn
  desired_count   = 1
  # On-demand, not Spot: this one task holds every agent's Discord presence, so a Spot reclaim would drop all of them
  # at once (a reclaim killed it during a deploy on 2026-09-30).
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.service[*].id
    security_groups  = [aws_security_group.gatekeeper_ingress.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc["gatekeeper-ingress"].arn
  }
}

# ---- garrison: 3D command & control gaming interface ------------------------

resource "aws_ecs_task_definition" "garrison" {
  count                    = local.images_ready && var.garrison_image != "" ? 1 : 0
  family                   = "${local.name}-garrison"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn
  container_definitions = jsonencode([{
    name         = "garrison"
    image        = var.garrison_image
    essential    = true
    portMappings = [{ containerPort = 3000 }]
    environment = [
      { name = "PORT", value = "3000" },
      { name = "HOST", value = "0.0.0.0" },
      { name = "NODE_ENV", value = "production" },
      { name = "FACTORY_URL", value = local.cp_url },
      { name = "FACTORY_CONTROL_PLANE_URL", value = local.cp_url },
      { name = "FACTORY_SECRETS_AWS_PREFIX", value = "factory/${var.environment}/" },
      { name = "AWS_REGION", value = var.aws_region },
    ]
    secrets = [
      { name = "FACTORY_TOKEN", valueFrom = local.secret["FACTORY_TOKEN"] },
    ]
    logConfiguration = local.log["control-plane"]
  }])
}

resource "aws_ecs_service" "garrison" {
  count           = local.images_ready && var.garrison_image != "" ? 1 : 0
  name            = "garrison"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.garrison[0].arn
  desired_count   = 1
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
  network_configuration {
    subnets          = aws_subnet.service[*].id
    security_groups  = [aws_security_group.control_plane.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.garrison[0].arn
    container_name   = "garrison"
    container_port   = 3000
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc["garrison"].arn
  }
  depends_on = [aws_lb_listener.https]
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
      { name = "FACTORY_GATEKEEPER_EGRESS_URL", value = local.gatekeeper_egress_url },
      { name = "FACTORY_URL", value = local.cp_url },
      { name = "FACTORY_CONTROL_PLANE_URL", value = local.cp_url },
    ]
    # S1: a secret the gatekeeper-egress holds (provider_secret_names) is injected at egress and never reaches an agent container.
    secrets          = [for name in var.agents[each.key].secrets : { name = name, valueFrom = "${local.secret_arn}/${name}" } if !contains(local.held_secret_names, name)]
    logConfiguration = local.log["agent"]
  }])
}

# ---- console: 2D dashboard -----------------------------------------------
resource "aws_ecs_task_definition" "console" {
  count                    = local.images_ready && var.console_image != "" ? 1 : 0
  family                   = "${local.name}-console"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn
  container_definitions = jsonencode([
    {
      name         = "console"
      image        = var.console_image
      essential    = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "FACTORY_CONTROL_PLANE_URL", value = "http://control-plane.factory.internal:8088" },
        { name = "PORT", value = "3000" }
      ]
      # §6.12 A2: no secrets. The console forwards each caller's own Access assertion; it holds no factory token.
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.factory.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "console"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "console" {
  count           = local.images_ready && var.console_image != "" ? 1 : 0
  name            = "console"
  cluster         = aws_ecs_cluster.factory.id
  task_definition = aws_ecs_task_definition.console[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.service[*].id
    security_groups  = [aws_security_group.control_plane.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.console[0].arn
    container_name   = "console"
    container_port   = 3000
  }
}

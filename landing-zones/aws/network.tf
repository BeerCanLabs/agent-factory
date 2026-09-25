# Two tiers.
#   service subnets (public): ALB, control plane, gateway, Doorman. Internet via the IGW.
#   agent subnets (private):  agent tasks only. NO NAT, NO IGW route. Their reachable set is the
#                             control plane, the gateway, and account-locked AWS endpoints needed to
#                             start a task (ECR, S3 layers + mind, Secrets Manager, Logs).
resource "aws_vpc" "factory" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "factory" {
  vpc_id = aws_vpc.factory.id
}

resource "aws_subnet" "service" {
  count                   = 2
  vpc_id                  = aws_vpc.factory.id
  cidr_block              = cidrsubnet(aws_vpc.factory.cidr_block, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-service-${count.index}" }
}

resource "aws_subnet" "agents" {
  count             = 2
  vpc_id            = aws_vpc.factory.id
  cidr_block        = cidrsubnet(aws_vpc.factory.cidr_block, 8, 10 + count.index)
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-agents-${count.index}" }
}

resource "aws_route_table" "service" {
  vpc_id = aws_vpc.factory.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.factory.id
  }
}

resource "aws_route_table_association" "service" {
  count          = 2
  subnet_id      = aws_subnet.service[count.index].id
  route_table_id = aws_route_table.service.id
}

resource "aws_route_table" "agents" {
  vpc_id = aws_vpc.factory.id
  tags   = { Name = "${local.name}-agents-no-egress" }
}

resource "aws_route_table_association" "agents" {
  count          = 2
  subnet_id      = aws_subnet.agents[count.index].id
  route_table_id = aws_route_table.agents.id
}

# ---- security groups -----------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.factory.id
}

resource "aws_security_group" "control_plane" {
  name   = "${local.name}-control-plane"
  vpc_id = aws_vpc.factory.id
}

resource "aws_security_group" "gateway" {
  name   = "${local.name}-gateway"
  vpc_id = aws_vpc.factory.id
}

resource "aws_security_group" "doorman" {
  name   = "${local.name}-doorman"
  vpc_id = aws_vpc.factory.id
}

resource "aws_security_group" "agents" {
  name   = "${local.name}-agents"
  vpc_id = aws_vpc.factory.id
}

resource "aws_security_group" "endpoints" {
  name   = "${local.name}-endpoints"
  vpc_id = aws_vpc.factory.id
}

resource "aws_security_group" "efs" {
  name   = "${local.name}-efs"
  vpc_id = aws_vpc.factory.id
}

locals {
  # [sg, port, source sg, description]
  ingress = {
    alb_https         = [aws_security_group.alb.id, 443, null, "HTTPS from anywhere"]
    cp_from_alb       = [aws_security_group.control_plane.id, 8088, aws_security_group.alb.id, "API via ALB"]
    garrison_from_alb = [aws_security_group.control_plane.id, 3000, aws_security_group.alb.id, "Garrison via ALB"]
    cp_from_cp        = [aws_security_group.control_plane.id, 8088, aws_security_group.control_plane.id, "control plane from garrison/internal"]
    cp_from_ag        = [aws_security_group.control_plane.id, 8088, aws_security_group.agents.id, "run input/result/heartbeat"]
    cp_from_gw  = [aws_security_group.control_plane.id, 8088, aws_security_group.gateway.id, "gateway run context + ledger"]
    cp_from_dm  = [aws_security_group.control_plane.id, 8088, aws_security_group.doorman.id, "Doorman wake/handoff"]
    gw_from_ag  = [aws_security_group.gateway.id, 8081, aws_security_group.agents.id, "agent egress"]
    dm_from_cp  = [aws_security_group.doorman.id, 8090, aws_security_group.control_plane.id, "presence"]
    efs_from_cp = [aws_security_group.efs.id, 2049, aws_security_group.control_plane.id, "ledger volume"]
    ep_from_vpc = [aws_security_group.endpoints.id, 443, "vpc", "AWS APIs via endpoints"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "rules" {
  for_each                     = local.ingress
  security_group_id            = each.value[0]
  ip_protocol                  = "tcp"
  from_port                    = each.value[1]
  to_port                      = each.value[1]
  referenced_security_group_id = each.value[2] == null || each.value[2] == "vpc" ? null : each.value[2]
  cidr_ipv4                    = each.value[2] == null ? "0.0.0.0/0" : each.value[2] == "vpc" ? aws_vpc.factory.cidr_block : null
  description                  = each.value[3]
}

# Services talk to the internet (providers, AWS APIs, callbacks, Discord).
resource "aws_vpc_security_group_egress_rule" "service_out" {
  for_each          = { cp = aws_security_group.control_plane.id, gw = aws_security_group.gateway.id, dm = aws_security_group.doorman.id, alb = aws_security_group.alb.id }
  security_group_id = each.value
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Agents: only the control plane, the gateway, the endpoints, and S3 (mind + ECR layers).
resource "aws_vpc_security_group_egress_rule" "agents_to_cp" {
  security_group_id            = aws_security_group.agents.id
  ip_protocol                  = "tcp"
  from_port                    = 8088
  to_port                      = 8088
  referenced_security_group_id = aws_security_group.control_plane.id
}

resource "aws_vpc_security_group_egress_rule" "agents_to_gateway" {
  security_group_id            = aws_security_group.agents.id
  ip_protocol                  = "tcp"
  from_port                    = 8081
  to_port                      = 8081
  referenced_security_group_id = aws_security_group.gateway.id
}

resource "aws_vpc_security_group_egress_rule" "agents_to_endpoints" {
  security_group_id            = aws_security_group.agents.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.endpoints.id
}

resource "aws_vpc_security_group_egress_rule" "agents_to_s3" {
  security_group_id = aws_security_group.agents.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
}

resource "aws_vpc_security_group_egress_rule" "agents_dns" {
  security_group_id = aws_security_group.agents.id
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = "${cidrhost(aws_vpc.factory.cidr_block, 2)}/32"
}

# ECS Task Metadata & IAM Task Role Credentials (link-local, non-routable outside host)
resource "aws_vpc_security_group_egress_rule" "agents_to_ecs_metadata" {
  security_group_id = aws_security_group.agents.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "169.254.170.2/32"
  description       = "ECS task metadata and IAM credentials endpoint"
}

# ---- endpoints: locked to this account so they cannot become an exfiltration path -----------

data "aws_iam_policy_document" "endpoint_same_account" {
  statement {
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ecr.api", "ecr.dkr", "secretsmanager", "logs", "bedrock-runtime"])
  vpc_id              = aws_vpc.factory.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.agents[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  policy              = data.aws_iam_policy_document.endpoint_same_account.json
}

data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    sid       = "AgentMindOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.mind.arn, "${aws_s3_bucket.mind.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalAccount"
      values   = [var.account_id]
    }
  }
  statement {
    sid       = "EcrImageLayers"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::prod-${var.aws_region}-starport-layer-bucket/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.factory.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.agents.id]
  policy            = data.aws_iam_policy_document.s3_endpoint.json
}

# ---- service discovery ----------------------------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "factory" {
  name = local.ns
  vpc  = aws_vpc.factory.id
}

resource "aws_service_discovery_service" "svc" {
  for_each = toset(["control-plane", "gateway", "doorman", "garrison"])
  name     = each.key
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.factory.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}


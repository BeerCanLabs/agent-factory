# Two tiers.
#   service subnets (public): ALB, control plane, gatekeeper-egress, gatekeeper-ingress. Internet via the IGW.
#   agent subnets (private):  agent tasks only. NO NAT, NO IGW route. Their reachable set is the
#                             control plane, the gatekeeper-egress, and the AWS endpoints needed to start a task
#                             (ECR, S3 layers + mind, Secrets Manager, Logs). Only the S3 endpoint's policy is
#                             locked to this account today; the interface endpoints allow any principal (GAP-264).
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

# E6: `route = []` makes Terraform authoritative for this table's routes. Without it, a `route` block deleted from
# the config is left behind in AWS: the IGW default route that 6f61937 added (applied 2026-09-20) and 85e4ac3 deleted
# from the code stayed live until this change. With `route = []`, every apply removes any default, NAT or other route
# added here by hand. The provider ignores the `local` route and S3 endpoint routes (the S3 endpoint below adds
# its own route through `route_table_ids`), so those stay.
resource "aws_route_table" "agents" {
  vpc_id = aws_vpc.factory.id
  route  = []
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

resource "aws_security_group" "gatekeeper_egress" {
  name   = "${local.name}-gatekeeper-egress"
  vpc_id = aws_vpc.factory.id
}

resource "aws_security_group" "gatekeeper_ingress" {
  name   = "${local.name}-gatekeeper-ingress"
  vpc_id = aws_vpc.factory.id
}

# E1/E6: the agents' egress is declared inline, so Terraform owns the group's whole egress list. Any rule added by
# hand (as the all-protocol 0.0.0.0/0 rule added with the AWS CLI on 2026-09-25 was) is revoked by the next apply.
# Agents reach only the control plane, the gatekeeper-egress, the VPC interface endpoints (their policies are not yet
# account-locked, GAP-264), S3 through its VPC endpoint (account-locked), the VPC resolver, and the ECS task
# metadata/credentials address. Nothing else, and never the internet.
resource "aws_security_group" "agents" {
  name   = "${local.name}-agents"
  vpc_id = aws_vpc.factory.id

  egress {
    protocol        = "tcp"
    from_port       = 8088
    to_port         = 8088
    security_groups = [aws_security_group.control_plane.id]
    description     = ""
  }
  egress {
    protocol        = "tcp"
    from_port       = 8081
    to_port         = 8081
    security_groups = [aws_security_group.gatekeeper_egress.id]
    description     = ""
  }
  # One block for both 443 destinations (the interface endpoints and S3 through the gateway endpoint), because
  # the provider stores rules that share a protocol and port range as one element; two blocks would make the
  # first apply revoke and re-add them.
  egress {
    protocol        = "tcp"
    from_port       = 443
    to_port         = 443
    security_groups = [aws_security_group.endpoints.id]
    prefix_list_ids = [aws_vpc_endpoint.s3.prefix_list_id]
    description     = ""
  }
  egress {
    protocol    = "udp"
    from_port   = 53
    to_port     = 53
    cidr_blocks = ["${cidrhost(aws_vpc.factory.cidr_block, 2)}/32"]
    description = ""
  }
  # DNS falls back to TCP when a UDP answer is truncated. Only the VPC resolver.
  egress {
    protocol    = "tcp"
    from_port   = 53
    to_port     = 53
    cidr_blocks = ["${cidrhost(aws_vpc.factory.cidr_block, 2)}/32"]
    description = "VPC resolver, TCP fallback"
  }
  # ECS task metadata and IAM task role credentials (link-local, never routed off the host).
  egress {
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["169.254.170.2/32"]
    description = "ECS task metadata and IAM credentials endpoint"
  }
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
  # [sg, port, source sg or "vpc", description]. Load balancer ingress is in alb.tf (§6.12 A1).
  ingress = {
    cp_from_alb       = [aws_security_group.control_plane.id, 8088, aws_security_group.alb.id, "API via ALB"]
    cp_probe_alb      = [aws_security_group.control_plane.id, 8089, aws_security_group.alb.id, "S16 private health probe"]
    garrison_from_alb = [aws_security_group.control_plane.id, 3000, aws_security_group.alb.id, "Garrison via ALB"]
    cp_from_cp        = [aws_security_group.control_plane.id, 8088, aws_security_group.control_plane.id, "control plane from garrison/internal"]
    cp_from_ag        = [aws_security_group.control_plane.id, 8088, aws_security_group.agents.id, "run input/result/heartbeat"]
    cp_from_gw        = [aws_security_group.control_plane.id, 8088, aws_security_group.gatekeeper_egress.id, "gatekeeper-egress run context + ledger"]
    cp_from_dm        = [aws_security_group.control_plane.id, 8088, aws_security_group.gatekeeper_ingress.id, "gatekeeper-ingress wake/handoff"]
    gw_from_ag        = [aws_security_group.gatekeeper_egress.id, 8081, aws_security_group.agents.id, "agent egress"]
    gw_from_cp        = [aws_security_group.gatekeeper_egress.id, 8081, aws_security_group.control_plane.id, "control plane model discovery"]
    dm_from_cp        = [aws_security_group.gatekeeper_ingress.id, 8090, aws_security_group.control_plane.id, "presence"]
    efs_from_cp       = [aws_security_group.efs.id, 2049, aws_security_group.control_plane.id, "ledger volume"]
    ep_from_vpc       = [aws_security_group.endpoints.id, 443, "vpc", "AWS APIs via endpoints"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "rules" {
  for_each                     = local.ingress
  security_group_id            = each.value[0]
  ip_protocol                  = "tcp"
  from_port                    = each.value[1]
  to_port                      = each.value[1]
  referenced_security_group_id = each.value[2] == "vpc" ? null : each.value[2]
  cidr_ipv4                    = each.value[2] == "vpc" ? aws_vpc.factory.cidr_block : null
  description                  = each.value[3]
}

# Services talk to the internet (providers, AWS APIs, callbacks, Discord).
# Under §6.9 M5, platform services reach subscription hosts: the control plane Keymaster reaches
# auth.x.ai and auth.openai.com for sign-in/token refresh, and the gatekeeper-egress reaches
# api.x.ai and chatgpt.com for Responses inference and model discovery. Agent subnets and security
# groups have no internet egress (E6).
resource "aws_vpc_security_group_egress_rule" "service_out" {
  for_each          = { cp = aws_security_group.control_plane.id, gw = aws_security_group.gatekeeper_egress.id, dm = aws_security_group.gatekeeper_ingress.id, alb = aws_security_group.alb.id }
  security_group_id = each.value
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# The agents' egress rules used to be separate resources; they are now the inline `egress` blocks on
# aws_security_group.agents (same rules, same AWS objects). `destroy = false` drops them from state without revoking
# them, so the switch never interrupts a running agent; the inline list then owns them.
removed {
  from = aws_vpc_security_group_egress_rule.agents_to_cp
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_vpc_security_group_egress_rule.agents_to_gatekeeper_egress
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_vpc_security_group_egress_rule.agents_to_endpoints
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_vpc_security_group_egress_rule.agents_to_s3
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_vpc_security_group_egress_rule.agents_dns
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_vpc_security_group_egress_rule.agents_to_ecs_metadata
  lifecycle {
    destroy = false
  }
}

# ---- endpoints --------------------------------------------------------------------------------
# GAP-264 (open): despite its name, `endpoint_same_account` has no condition, so the interface endpoints accept any
# principal, including credentials from another account. Only the S3 endpoint below is locked to this account
# (aws:PrincipalAccount). Adding the condition here is the follow-up.

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
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListBucket"]
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
  for_each = toset(["control-plane", "gatekeeper-egress", "gatekeeper-ingress", "garrison"])
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


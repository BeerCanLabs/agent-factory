# Factory-generated credentials. One per caller -> callee edge, each with its least role.
locals {
  generated = toset([
    "FACTORY_TOKEN",
    "GATEKEEPER_INGRESS_OPERATOR_TOKEN",
    "GATEKEEPER_EGRESS_TOKEN",
    "GATEKEEPER_INGRESS_TOKEN",
    "FACTORY_RUN_TOKEN_KEY",
    "FACTORY_CALLBACK_SIGNING_KEY",
    "ECHO_WEBHOOK_SECRET",
  ])
}

resource "random_password" "generated" {
  for_each = local.generated
  length   = 40
  special  = false
}

resource "aws_secretsmanager_secret" "generated" {
  for_each = local.generated
  name     = "factory/${var.environment}/${each.key}"
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each      = local.generated
  secret_id     = aws_secretsmanager_secret.generated[each.key].id
  secret_string = random_password.generated[each.key].result
}

resource "aws_secretsmanager_secret" "factory_tokens" {
  name = "factory/${var.environment}/FACTORY_TOKENS"
}

resource "aws_secretsmanager_secret_version" "factory_tokens" {
  secret_id = aws_secretsmanager_secret.factory_tokens.id
  secret_string = jsonencode([
    { name = "gatekeeper-ingress", token = random_password.generated["GATEKEEPER_INGRESS_OPERATOR_TOKEN"].result, roles = ["operator", "gatekeeper-ingress"] },
    { name = "gatekeeper-egress", token = random_password.generated["GATEKEEPER_EGRESS_TOKEN"].result, roles = ["gatekeeper-egress"] },
  ])
}

# Gatekeeper-held keys (provider_secret_names) are owned by the Keymaster (§6.11 K1/K5), which creates and fills them
# through its write-only channel. The landing zone never creates them; iam.tf controls who may read them by name.
# Earlier versions created empty entries here; release them from state without deleting the secrets or their values.
removed {
  from = aws_secretsmanager_secret.provider
  lifecycle {
    destroy = false
  }
}

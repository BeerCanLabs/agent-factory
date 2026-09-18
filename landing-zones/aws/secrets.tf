# Factory-generated credentials. One per caller -> callee edge, each with its least role.
locals {
  generated = toset([
    "FACTORY_TOKEN",
    "DOORMAN_OPERATOR_TOKEN",
    "GATEWAY_TOKEN",
    "DOORMAN_TOKEN",
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
    { name = "doorman", token = random_password.generated["DOORMAN_OPERATOR_TOKEN"].result, roles = ["operator"] },
    { name = "gateway", token = random_password.generated["GATEWAY_TOKEN"].result, roles = ["gateway"] },
  ])
}

# Provider keys: created empty; an operator sets the value. Only the gateway role may read them.
resource "aws_secretsmanager_secret" "provider" {
  for_each = toset(var.provider_secret_names)
  name     = "factory/${var.environment}/${each.key}"
}

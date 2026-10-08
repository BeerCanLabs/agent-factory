output "alb_dns_name" {
  description = "Point your certificate's DNS name (CNAME/alias) here."
  value       = aws_lb.factory.dns_name
}

output "ecr" {
  value = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}

output "cluster_name" {
  value = aws_ecs_cluster.factory.name
}

output "mind_bucket" {
  value = aws_s3_bucket.mind.bucket
}

output "ledger_worm_bucket" {
  value = aws_s3_bucket.ledger_worm.bucket
}

output "admin_token_secret" {
  description = "Break-glass admin bearer secret name in AWS Secrets Manager."
  value       = aws_secretsmanager_secret.generated["FACTORY_TOKEN"].name
}

output "provider_secrets" {
  description = "Gatekeeper-held keys. Supply them as platform credentials through the Keymaster; only the gatekeeper-egress can read them."
  value       = [for n in local.held_secret_names : "factory/${var.environment}/${n}"]
}

output "agent_task_families" {
  value = { for k, t in aws_ecs_task_definition.agent : k => t.family }
}

output "event_bus" {
  value = aws_cloudwatch_event_bus.factory.name
}

output "treasurer_role_arn" {
  description = "The Treasurer IAM role for Cost Explorer and ECS inventory."
  value       = aws_iam_role.treasurer.arn
}

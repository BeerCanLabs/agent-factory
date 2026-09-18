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
  description = "Break-glass admin bearer. Read with scripts/bcl-aws aws secretsmanager get-secret-value."
  value       = aws_secretsmanager_secret.generated["FACTORY_TOKEN"].name
}

output "provider_secrets" {
  description = "Set these values; only the gateway can read them."
  value       = [for s in aws_secretsmanager_secret.provider : s.name]
}

output "agent_task_families" {
  value = { for k, t in aws_ecs_task_definition.agent : k => t.family }
}

output "control_plane_url" {
  value = "http://${aws_lb.factory.dns_name}"
}

output "doorman_url" {
  value = "http://${aws_lb.factory.dns_name}:8090"
}

output "ecr_control_plane" {
  value = aws_ecr_repository.control_plane.repository_url
}

output "ecr_doorman" {
  value = aws_ecr_repository.doorman.repository_url
}

output "ecr_sidecar" {
  value = aws_ecr_repository.sidecar.repository_url
}

output "ecr_echo_worker" {
  value = aws_ecr_repository.echo_worker.repository_url
}

output "mind_bucket" {
  value = aws_s3_bucket.mind.bucket
}

output "factory_token_secret_arn" {
  value = aws_secretsmanager_secret.factory_token.arn
}

output "cluster_name" {
  value = aws_ecs_cluster.factory.name
}

output "echo_task_family" {
  value = try(aws_ecs_task_definition.echo[0].family, null)
}

output "ledger_worm_bucket" {
  value = aws_s3_bucket.ledger_worm.bucket
}

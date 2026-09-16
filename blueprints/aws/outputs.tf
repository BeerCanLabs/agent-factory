output "cluster_name" {
  value = aws_ecs_cluster.agent_factory.name
}

output "memory_bucket" {
  value = aws_s3_bucket.mind.bucket
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.agent.arn
}

output "schedule_arn" {
  value = aws_scheduler_schedule.wake.arn
}

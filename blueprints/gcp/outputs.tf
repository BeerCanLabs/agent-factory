output "service_name" {
  value = google_cloud_run_v2_service.agent.name
}

output "memory_bucket" {
  value = google_storage_bucket.mind.name
}

output "uri" {
  value = google_cloud_run_v2_service.agent.uri
}

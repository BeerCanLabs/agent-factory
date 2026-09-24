# Shared Artifact Registry for dynamically-built agent images
# Cloud Build pushes here; Cloud Run Jobs pull from here.
resource "google_artifact_registry_repository" "dynamic_agents" {
  location      = var.region
  repository_id = "${local.name}-agents"
  description   = "Agent Factory dynamic agent images (PaaS-built)"
  format        = "DOCKER"

  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-last-10"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
}

output "artifact_registry_repo" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.dynamic_agents.repository_id}"
  description = "Artifact Registry repo URI for dynamic agent images"
}

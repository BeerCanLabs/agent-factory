# ---- Cloud Build Service Account for dynamic agent builds -----------------------------------
# The Factory Control Plane assumes this SA to trigger Cloud Build jobs.
# Equivalent to aws_iam_role.codebuild.

resource "google_service_account" "cloudbuild" {
  account_id   = "${local.name}-cb"
  display_name = "Factory Cloud Build (dynamic agent builder)"
}

# Allow Cloud Build SA to push images to Artifact Registry
resource "google_artifact_registry_repository_iam_member" "cb_writer" {
  location   = google_artifact_registry_repository.dynamic_agents.location
  repository = google_artifact_registry_repository.dynamic_agents.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Allow Cloud Build SA to write logs
resource "google_project_iam_member" "cb_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Allow Cloud Build SA to read source from Cloud Storage (used when control plane uploads a workspace tarball)
resource "google_project_iam_member" "cb_storage_reader" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Grant the Cloud Build service agent the ability to use this SA
# (Required: Cloud Build's own SA must be able to act as our SA)
resource "google_service_account_iam_member" "cb_sa_user" {
  service_account_id = google_service_account.cloudbuild.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
}

data "google_project" "current" {
  project_id = var.project_id
}

# A reusable inline build config used as the template when the control plane triggers builds.
# The control plane passes AGENT_ID and REPO_URL as substitutions at trigger time.
# Equivalent to the aws_codebuild_project 'factory-agent-builder' buildspec.
resource "google_cloudbuild_trigger" "agent_builder" {
  name        = "${local.name}-agent-builder"
  description = "Template trigger: builds a dynamic agent image from a Git repo and pushes to Artifact Registry. Triggered programmatically by the control plane."
  location    = var.region

  # Manual trigger — the control plane calls the Cloud Build API to run it
  # with REPO_URL and AGENT_ID substitution overrides.
  source_to_build {
    uri       = "https://github.com/placeholder/placeholder" # overridden at runtime
    ref       = "refs/heads/main"
    repo_type = "GITHUB"
  }

  substitutions = {
    _AGENT_ID          = "placeholder"
    _ARTIFACT_REGISTRY = "${var.region}-docker.pkg.dev/${var.project_id}/${local.name}-agents"
  }

  build {
    step {
      name = "gcr.io/cloud-builders/docker"
      args = [
        "build",
        "-t",
        "$_ARTIFACT_REGISTRY:$_AGENT_ID",
        "."
      ]
    }
    step {
      name = "gcr.io/cloud-builders/docker"
      args = [
        "push",
        "$_ARTIFACT_REGISTRY:$_AGENT_ID"
      ]
    }
    images = ["$_ARTIFACT_REGISTRY:$_AGENT_ID"]
    options {
      logging = "CLOUD_LOGGING_ONLY"
    }
  }

  service_account = google_service_account.cloudbuild.id

  depends_on = [
    google_artifact_registry_repository.dynamic_agents,
    google_service_account.cloudbuild,
  ]
}

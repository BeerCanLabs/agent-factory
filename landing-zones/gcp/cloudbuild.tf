# ============================================================================================
# Cloud Build Service Accounts — Agent Factory GCP Landing Zone (DESIGN_AUTHORITY §6.8 L3/L4, §6.14 SK1)
# Equivalent to landing-zones/aws/codebuild.tf.
#
# - google_service_account.cloudbuild (`factory-prod-cb`): runs admission builds (`buildAgentImage`
#   in packages/property-manager/src/gcp/cloudbuild.ts) and pushes admitted SHA-tagged images to
#   Artifact Registry.
# - google_service_account.skill_checker (`factory-prod-skill-checker`): runs SK1 skill checks
#   (`cloudBuildSkillChecker` in packages/control-plane/src/gcp/skill-checker.ts) with NO Artifact
#   Registry write access.
# ============================================================================================

data "google_project" "current" {
  project_id = var.project_id
}

# ---- 1. Agent Admission Builder Service Account (L3/L4) -------------------------------------
resource "google_service_account" "cloudbuild" {
  account_id   = "${local.name}-cb"
  display_name = "Factory Cloud Build (dynamic agent admission builder)"
}

resource "google_artifact_registry_repository_iam_member" "cb_writer" {
  location   = google_artifact_registry_repository.dynamic_agents.location
  repository = google_artifact_registry_repository.dynamic_agents.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.cloudbuild.email}"
}

resource "google_project_iam_member" "cb_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

resource "google_project_iam_member" "cb_storage_reader" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

resource "google_secret_manager_secret_iam_member" "cb_source_token" {
  count     = var.agent_source_token_secret_name != "" ? 1 : 0
  secret_id = var.agent_source_token_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloudbuild.email}"
}

resource "google_service_account_iam_member" "cb_sa_user" {
  service_account_id = google_service_account.cloudbuild.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
}

# ---- 2. Isolated Skill Checker Service Account (SK1) ----------------------------------------
# Holds NO Artifact Registry write access: skill checks execute untrusted skill tests and never build or push images.
resource "google_service_account" "skill_checker" {
  account_id   = "${local.name}-skill-checker"
  display_name = "Factory Cloud Build Skill Checker (SK1)"
}

resource "google_project_iam_member" "skill_checker_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.skill_checker.email}"
}

resource "google_secret_manager_secret_iam_member" "skill_checker_source_token" {
  count     = var.agent_source_token_secret_name != "" ? 1 : 0
  secret_id = var.agent_source_token_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.skill_checker.email}"
}

resource "google_service_account_iam_member" "skill_checker_sa_user" {
  service_account_id = google_service_account.skill_checker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
}

# ============================================================================================
# IAM — Agent Factory GCP Landing Zone
# One Service Account per component; minimal IAM per the zero-trust pattern.
# Equivalent to landing-zones/aws/iam.tf.
# ============================================================================================

# ---- control plane ---------------------------------------------------------------------------
resource "google_service_account" "control_plane" {
  account_id   = "${local.name}-cp"
  display_name = "Factory Control Plane"
}

# Invoke Cloud Run Jobs (to wake agents)
resource "google_project_iam_member" "cp_run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Register and manage Cloud Run Jobs (dynamic agent registration)
# Equivalent to ecs:RegisterTaskDefinition in AWS
resource "google_project_iam_member" "cp_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Trigger Cloud Build builds (dynamic agent image builds)
# Equivalent to codebuild:StartBuild + codebuild:BatchGetBuilds in AWS
resource "google_project_iam_member" "cp_cloudbuild_editor" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Create agent Service Accounts dynamically (PaaS provisioning)
# Equivalent to iam:CreateRole + iam:PutRolePolicy in AWS
resource "google_project_iam_member" "cp_sa_admin" {
  project = var.project_id
  role    = "roles/iam.serviceAccountAdmin"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Read factory secrets (pre-flight checks, not provider keys)
# Scoped to factory/* prefix via conditions in Secret Manager
resource "google_project_iam_member" "cp_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Read agent images from Artifact Registry
resource "google_project_iam_member" "cp_ar_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Ledger WORM bucket: append-only writes + reads for checkpointing
resource "google_storage_bucket_iam_member" "cp_ledger_writer" {
  bucket = google_storage_bucket.ledger_worm.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_storage_bucket_iam_member" "cp_ledger_reader" {
  bucket = google_storage_bucket.ledger_worm.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

# Allow control plane SA to act as agent SAs (so it can create Cloud Run Jobs that use agent SAs)
resource "google_project_iam_member" "cp_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# ---- gateway ---------------------------------------------------------------------------------
resource "google_service_account" "gateway" {
  account_id   = "${local.name}-gw"
  display_name = "Factory Gateway"
}

# Gateway reads ONLY provider secrets (API keys injected into agent egress)
# Equivalent to AWS: only InjectProviderKeysOnly statement, no factory/* access
resource "google_secret_manager_secret_iam_member" "gw_provider_secrets" {
  for_each  = toset(var.provider_secret_names)
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gateway.email}"
}

# ---- doorman ---------------------------------------------------------------------------------
resource "google_service_account" "doorman" {
  account_id   = "${local.name}-dm"
  display_name = "Factory Doorman"
}

# Doorman reads only the Discord bot token secret
resource "google_secret_manager_secret_iam_member" "dm_discord_token" {
  count     = var.discord_secret_name != "" ? 1 : 0
  secret_id = var.discord_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.doorman.email}"
}

# ---- agents (one SA each, scoped to own mind prefix) -----------------------------------------
resource "google_service_account" "agent" {
  for_each     = var.agents
  account_id   = "${local.name}-ag-${each.key}"
  display_name = "Factory Agent: ${each.key}"
}

# Each agent SA reads/writes ONLY its own mind prefix in the mind bucket.
# Equivalent to AWS: s3:GetObject/PutObject/DeleteObject on mind bucket/<agent-id>/*
resource "google_storage_bucket_iam_member" "agent_mind_access" {
  for_each = var.agents
  bucket   = google_storage_bucket.mind.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.agent[each.key].email}"
  condition {
    title       = "own-mind-prefix-only"
    description = "Agent can only access its own mind prefix"
    expression  = "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.mind.name}/objects/${each.key}/\")"
  }
}

# Each agent's required secrets (provider keys injected via Secret Manager)
resource "google_secret_manager_secret_iam_member" "agent_secrets" {
  for_each  = { for pair in flatten([for id, a in var.agents : [for s in a.secrets : { agent = id, secret = s }]]) : "${pair.agent}/${pair.secret}" => pair }
  secret_id = each.value.secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent[each.value.agent].email}"
}

# ---- control plane ---------------------------------------------------------------------------
resource "google_service_account" "control_plane" {
  account_id   = "${local.name}-cp"
  display_name = "Factory Control Plane"
}

resource "google_project_iam_member" "cp_run_jobs" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_storage_bucket_iam_member" "cp_ledger_writer" {
  bucket = google_storage_bucket.ledger_worm.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

# ---- gateway ---------------------------------------------------------------------------------
resource "google_service_account" "gateway" {
  account_id   = "${local.name}-gw"
  display_name = "Factory Gateway"
}

resource "google_project_iam_member" "gw_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# ---- doorman ---------------------------------------------------------------------------------
resource "google_service_account" "doorman" {
  account_id   = "${local.name}-dm"
  display_name = "Factory Doorman"
}

# ---- agents (one SA each) --------------------------------------------------------------------
resource "google_service_account" "agent" {
  for_each     = var.agents
  account_id   = "${local.name}-ag-${each.key}"
  display_name = "Factory Agent: ${each.key}"
}

# Agents can only read/write their specific mind prefix in the bucket
resource "google_storage_bucket_iam_member" "agent_mind_access" {
  for_each = var.agents
  bucket   = google_storage_bucket.mind.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.agent[each.key].email}"
  condition {
    title       = "prefix-match"
    description = "Only allow access to their own prefix"
    expression  = "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.mind.name}/objects/${each.key}/\")"
  }
}

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
resource "google_project_iam_member" "cp_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Trigger Cloud Build builds (dynamic agent admission builds & SK1 skill checks)
resource "google_project_iam_member" "cp_cloudbuild_editor" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Create agent Service Accounts dynamically (PaaS provisioning)
resource "google_project_iam_member" "cp_sa_admin" {
  project = var.project_id
  role    = "roles/iam.serviceAccountAdmin"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Keymaster & Property Manager secret management (create/update secrets under factory-prod-* and bind agent SA policies)
resource "google_project_iam_member" "cp_secret_admin" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Read agent images from Artifact Registry
resource "google_project_iam_member" "cp_ar_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Manage mind bucket IAM policy (so Property Manager can add prefix-scoped bindings for dynamic agent SAs)
resource "google_storage_bucket_iam_member" "cp_mind_admin" {
  bucket = google_storage_bucket.mind.name
  role   = "roles/storage.admin"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

# Ledger WORM bucket: append-only writes + reads for checkpointing and cold-boot hydration
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

# Control-plane durable state bucket (R1: mounted at /data)
resource "google_storage_bucket_iam_member" "cp_state_admin" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

# Versioned deployment configuration store bucket (SK3, R1)
resource "google_storage_bucket_iam_member" "cp_config_admin" {
  bucket = google_storage_bucket.config.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

# Publish Inspector events to Pub/Sub event bus
resource "google_pubsub_topic_iam_member" "cp_events_publisher" {
  topic  = google_pubsub_topic.events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

# Allow control plane SA to act as agent SAs and Cloud Build SAs
resource "google_project_iam_member" "cp_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# ---- accountant (§6.15: dedicated read-only identity for billing and compute inventory) -------
resource "google_service_account" "accountant" {
  account_id   = "${local.name}-accountant"
  display_name = "Factory Accountant (read-only billing & compute inventory)"
}

resource "google_project_iam_member" "accountant_run_viewer" {
  project = var.project_id
  role    = "roles/run.viewer"
  member  = "serviceAccount:${google_service_account.accountant.email}"
}

resource "google_project_iam_member" "accountant_bq_job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.accountant.email}"
}

resource "google_bigquery_dataset_iam_member" "accountant_bq_data_viewer" {
  dataset_id = google_bigquery_dataset.billing_export.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.accountant.email}"
}

# Control plane impersonates the Accountant SA for all billing and inventory reads
resource "google_service_account_iam_member" "cp_impersonate_accountant" {
  service_account_id = google_service_account.accountant.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.control_plane.email}"
}

# ---- console (A2: unprivileged UI proxy; holds zero secrets or cloud permissions) ------------
resource "google_service_account" "console" {
  account_id   = "${local.name}-console"
  display_name = "Factory Console (unprivileged operator UI)"
}

# Allow console to invoke control-plane internally
resource "google_project_iam_member" "console_run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.console.email}"
}

# ---- gatekeeper-egress -----------------------------------------------------------------------
resource "google_service_account" "gatekeeper_egress" {
  account_id   = "${local.name}-gw"
  display_name = "Factory gatekeeper-egress"
}

# Vertex AI invocation for the Executive inside gatekeeper-egress (M1-M3, E5)
resource "google_project_iam_member" "gw_vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.gatekeeper_egress.email}"
}

# Provider API keys the egress injects. The name rule is the allowlist: a factory secret ending in
# _API_KEY. Signing keys, callback keys, and agent secrets do not match (S1).
# Connection access tokens come from the control plane (K3), not from Secret Manager.
resource "google_project_iam_member" "gw_provider_api_keys" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gatekeeper_egress.email}"
  condition {
    title       = "platform-api-keys-only"
    description = "Egress may read prefixed secrets named *_API_KEY"
    expression  = "resource.name.extract('/secrets/{name}').startsWith('${local.secrets_prefix}') && resource.name.extract('/secrets/{name}').endsWith('_API_KEY')"
  }
}

# The control plane presents this token to the egress for vendor discovery. It never reads provider keys (S1).
resource "google_secret_manager_secret_iam_member" "cp_egress_token" {
  secret_id = "${local.secrets_prefix}FACTORY_GATEKEEPER_EGRESS_TOKEN"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_secret_manager_secret_iam_member" "gw_runtime_secrets" {
  for_each  = toset(["FACTORY_GATEKEEPER_EGRESS_TOKEN", "FACTORY_RUN_TOKEN_KEY"])
  secret_id = "${local.secrets_prefix}${each.value}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gatekeeper_egress.email}"
}

# Per-agent Discord bot tokens named <prefix><agent>_DISCORD_BOT_TOKEN. The condition cannot see other factory secrets.
resource "google_project_iam_member" "gw_discord_bot_tokens" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gatekeeper_egress.email}"
  condition {
    title       = "discord-bot-tokens-only"
    description = "Egress may read only prefixed Discord bot token secrets"
    expression  = "resource.name.extract('/secrets/{name}').startsWith('${local.secrets_prefix}') && resource.name.extract('/secrets/{name}').endsWith('_DISCORD_BOT_TOKEN')"
  }
}

# ---- gatekeeper-ingress ----------------------------------------------------------------------
resource "google_service_account" "gatekeeper_ingress" {
  account_id   = "${local.name}-dm"
  display_name = "Factory gatekeeper-ingress"
}

resource "google_secret_manager_secret_iam_member" "dm_discord_token" {
  count     = var.discord_secret_name != "" ? 1 : 0
  secret_id = var.discord_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gatekeeper_ingress.email}"
}

# ---- static agents (one SA each, scoped to own mind prefix) ----------------------------------
resource "google_service_account" "agent" {
  for_each     = var.agents
  account_id   = "${local.name}-ag-${each.key}"
  display_name = "Factory Agent: ${each.key}"
}

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

resource "google_secret_manager_secret_iam_member" "agent_secrets" {
  for_each  = { for pair in flatten([for id, a in var.agents : [for s in a.secrets : { agent = id, secret = s }]]) : "${pair.agent}/${pair.secret}" => pair }
  secret_id = "${local.secrets_prefix}${each.value.secret}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent[each.value.agent].email}"
}

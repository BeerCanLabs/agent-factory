# ============================================================================================
# Cloud Storage Buckets — Agent Factory GCP Landing Zone
# Equivalent to landing-zones/aws/storage.tf.
# ============================================================================================

# Mind bucket: agent working memory. Each agent SA is scoped to its own prefix.
resource "google_storage_bucket" "mind" {
  name                        = "${local.name}-mind-${var.project_id}"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  labels = {
    component   = "mind"
    environment = var.environment
  }
}

# Ledger WORM bucket: write-once ledger checkpoints.
# Retention policy enforces immutability after the retention period.
# Equivalent to AWS S3 object lock COMPLIANCE mode.
resource "google_storage_bucket" "ledger_worm" {
  name                        = "${local.name}-ledger-${var.project_id}"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  retention_policy {
    is_locked        = false # Set to true in production for compliance-mode lock. Cannot be undone.
    retention_period = var.ledger_retention_days * 24 * 3600
  }

  labels = {
    component   = "ledger"
    environment = var.environment
  }
}

# Control-plane durable state bucket (R1): mounted at /data on the Cloud Run Gen2 control-plane service.
# Object versioning provides automatic point-in-time recovery for registry, policies, approvals, systems, skills, and schedules.
resource "google_storage_bucket" "state" {
  name                        = "${local.name}-state-${var.project_id}"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  labels = {
    component   = "state"
    environment = var.environment
  }
}

# Versioned deployment configuration store bucket (SK3, R1): backs FACTORY_CONFIG_STORE_URI (GcsConfigBackend).
resource "google_storage_bucket" "config" {
  name                        = "${local.name}-config-${var.project_id}"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  labels = {
    component   = "config"
    environment = var.environment
  }
}

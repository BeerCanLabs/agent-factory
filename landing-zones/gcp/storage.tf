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

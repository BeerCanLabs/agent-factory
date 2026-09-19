# Cloud Storage Buckets
resource "google_storage_bucket" "mind" {
  name                        = "${local.name}-mind-${var.project_id}"
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true
}

resource "google_storage_bucket" "ledger_worm" {
  name                        = "${local.name}-ledger-${var.project_id}"
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true

  retention_policy {
    is_locked        = false # Keep unlocked for terraform destroy flexibility, lock in prod manually
    retention_period = 31536000 # 1 year in seconds
  }
}

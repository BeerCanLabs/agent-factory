terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  # Partial config: pass bucket/prefix via -backend-config at init time.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required GCP APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "compute.googleapis.com",
    "vpcaccess.googleapis.com",
    "bigquery.googleapis.com",
    "pubsub.googleapis.com",
    "aiplatform.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

locals {
  name = "factory-${var.environment}"
}

# Inspector event bus topic (pubsub:<topic> in FACTORY_EVENT_BUS)
resource "google_pubsub_topic" "events" {
  name       = "${local.name}-events"
  depends_on = [google_project_service.apis]

  labels = {
    component   = "inspector"
    environment = var.environment
  }
}

# Accountant BigQuery dataset for Cloud Billing Export (§6.15)
resource "google_bigquery_dataset" "billing_export" {
  dataset_id  = "factory_${var.environment}_billing_export"
  location    = "US"
  description = "Agent Factory GCP Cloud Billing Export dataset read by the Accountant"
  depends_on  = [google_project_service.apis]

  labels = {
    component   = "accountant"
    environment = var.environment
  }
}

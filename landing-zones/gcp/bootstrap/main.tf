# One-time, per GCP project: remote state bucket for the landing zone and keyless GitHub Actions OIDC Workload Identity Federation.
# State stays local (landing-zones/gcp/bootstrap/terraform.tfstate, gitignored).
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  type        = string
  description = "Target GCP project ID."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid 6-30 char GCP project ID."
  }
}

variable "region" {
  type    = string
  default = "us-central1"
}

# The ops repo whose `main` branch may deploy (owner/name), e.g. BeerCanLabs/submind-gcp.
variable "github_repo" {
  type = string
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "bootstrap_apis" {
  for_each = toset([
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "storage.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_storage_bucket" "state" {
  name                        = "agent-factory-tfstate-${var.project_id}"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  labels = {
    owner   = "beercanlabs"
    system  = "agent-factory"
    stack   = "bootstrap"
    purpose = "tfstate"
  }

  depends_on = [google_project_service.bootstrap_apis]
}

# GitHub Actions deploys with short-lived OIDC tokens via Workload Identity Federation.
# Only the main branch of var.github_repo satisfies attribute_condition.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "factory-github-pool"
  display_name              = "Agent Factory GitHub Actions Pool"
  description               = "OIDC federation pool for GitHub Actions CI/CD"
  depends_on                = [google_project_service.bootstrap_apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "factory-github-provider"
  display_name                       = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  attribute_condition = "assertion.sub == 'repo:${var.github_repo}:ref:refs/heads/main'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deploy" {
  account_id   = "factory-deploy"
  display_name = "Agent Factory CI/CD Deployer"
  description  = "Assumed via OIDC by GitHub Actions on main branch of ${var.github_repo}"
  depends_on   = [google_project_service.bootstrap_apis]
}

# Terraform manages IAM, networking, Cloud Run, GCS, Artifact Registry, BigQuery, and Pub/Sub in the dedicated project.
resource "google_project_iam_member" "deploy_owner" {
  project = var.project_id
  role    = "roles/owner"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_service_account_iam_member" "deploy_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

output "state_bucket" {
  value = google_storage_bucket.state.name
}

output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_service_account" {
  value = google_service_account.deploy.email
}

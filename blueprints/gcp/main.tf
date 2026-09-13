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
  description = "GCP Project ID"
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "GCP Region for Cloud Run and Vertex AI"
}

variable "garrison_c2_url" {
  type        = string
  default     = "https://garrison.enterprise.internal"
  description = "Agent Garrison C2 endpoint URL for heartbeats and telemetry"
}

# 1. OpenClaw Autonomous Agent on Google Cloud Run
resource "google_cloud_run_v2_service" "openclaw_agent" {
  name     = "openclaw-agent-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    containers {
      image = "us-docker.pkg.dev/${var.project_id}/agent-factory/openclaw:latest"

      env {
        name  = "GARRISON_URL"
        value = var.garrison_c2_url
      }
      env {
        name  = "AGENT_ID"
        value = "openclaw-gcp-01"
      }
      env {
        name  = "AGENT_NAME"
        value = "OpenClaw-Vertex-Runner"
      }
      env {
        name  = "AGENT_SECTOR"
        value = "sector-ops"
      }
      env {
        name  = "AGENT_PROVIDER"
        value = "gcp-cloud-run"
      }
      env {
        name  = "AGENT_MODEL"
        value = "gemini-1.5-pro"
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "4Gi"
        }
      }
    }

    labels = {
      "garrison-agent"  = "true"
      "garrison-sector" = "sector-ops"
    }
  }
}

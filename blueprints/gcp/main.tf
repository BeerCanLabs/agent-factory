terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_storage_bucket" "mind" {
  name                        = "${var.project_id}-factory-mind-${var.agent_id}"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false
}

resource "google_cloud_run_v2_service" "agent" {
  name     = "factory-${var.agent_id}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      name  = "worker"
      image = var.worker_image
      env {
        name  = "OPENAI_BASE_URL"
        value = "http://127.0.0.1:8080"
      }
      env {
        name  = "MEMORY_STORE_URI"
        value = "gs://${google_storage_bucket.mind.name}/${var.agent_id}"
      }
      env {
        name  = "AGENT_ID"
        value = var.agent_id
      }
    }

    containers {
      name  = "sidecar"
      image = var.sidecar_image
      ports {
        container_port = 9090
      }
      env {
        name  = "PORT"
        value = "9090"
      }
      env {
        name  = "PROXY_PORT"
        value = "8080"
      }
      env {
        name  = "AGENT_ID"
        value = var.agent_id
      }
      env {
        name  = "FACTORY_LEDGER_URL"
        value = var.factory_ledger_url
      }

      dynamic "env" {
        for_each = var.secret_ids
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }

    labels = {
      factory-agent = "true"
      agent-id      = var.agent_id
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  name     = google_cloud_run_v2_service.agent.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:factory-control-plane@${var.project_id}.iam.gserviceaccount.com"
}

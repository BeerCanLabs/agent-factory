resource "google_cloud_run_v2_service" "control_plane" {
  name     = "${local.name}-cp"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.control_plane.email
    containers {
      image = var.control_plane_image
      env {
        name  = "FACTORY_LEDGER_PATH"
        value = "gcs://${google_storage_bucket.ledger_worm.name}"
      }
    }
  }
}

resource "google_cloud_run_v2_service" "gateway" {
  name     = "${local.name}-gw"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.gateway.email
    containers {
      image = var.gateway_image
      env {
        name  = "FACTORY_SECRETS_GCP_PROJECT"
        value = var.project_id
      }
    }
  }
}

resource "google_cloud_run_v2_service" "doorman" {
  name     = "${local.name}-dm"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.doorman.email
    containers {
      image = var.doorman_image
      env {
        name  = "FACTORY_URL"
        value = google_cloud_run_v2_service.control_plane.uri
      }
    }
  }
}

# Cartridges run as Cloud Run Jobs so they scale to 0 and execute on-demand
resource "google_cloud_run_v2_job" "agents" {
  for_each = var.agents
  name     = "${local.name}-ag-${each.key}"
  location = var.region

  template {
    template {
      service_account = google_service_account.agent[each.key].email
      containers {
        image = each.value.image
        env {
          name  = "MEMORY_STORE_DIR"
          value = "gcs://${google_storage_bucket.mind.name}/${each.key}/"
        }
        # In GCP, Secret Manager secrets are mounted via volume or env var references natively in Cloud Run
        dynamic "env" {
          for_each = each.value.secrets
          content {
            name = env.value
            value_source {
              secret_key_ref {
                secret  = env.value # Assumes secret is named identically in GCP Secret Manager
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
}

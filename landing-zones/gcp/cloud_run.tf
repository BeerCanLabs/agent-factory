# ============================================================================================
# Cloud Run Services & Jobs — Agent Factory GCP Landing Zone
# Equivalent to landing-zones/aws/ecs.tf.
# Services: control-plane, gatekeeper-egress, gatekeeper-ingress (always running, min-instances=1)
# Jobs: agents (scale to 0; woken by control plane)
# ============================================================================================

locals {
  images_ready   = var.control_plane_image != "" && var.gatekeeper_ingress_image != "" && var.gatekeeper_egress_image != ""
  ar_repo_prefix = "${var.region}-docker.pkg.dev/${var.project_id}/${local.name}-agents"
  # Map of agent IDs to their Cloud Run Job names (passed to FACTORY_GCP_JOBS env var)
  agent_job_map = join(",", [for id, _ in var.agents : "${id}:${local.name}-ag-${id}"])
}

# ---- control plane -----------------------------------------------------------
resource "google_cloud_run_v2_service" "control_plane" {
  count    = local.images_ready ? 1 : 0
  name     = "${local.name}-cp"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.control_plane.email

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    containers {
      image = var.control_plane_image

      ports {
        container_port = 8088
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "1Gi"
        }
      }

      # --- Factory core config ---
      env {
        name  = "PORT"
        value = "8088"
      }
      env {
        name  = "FACTORY_RUNTIME"
        value = "cloudrun"
      }
      env {
        name  = "FACTORY_GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "FACTORY_GCP_REGION"
        value = var.region
      }
      env {
        name  = "FACTORY_GCP_JOBS"
        value = local.agent_job_map
      }
      env {
        name  = "FACTORY_ARTIFACT_REGISTRY"
        value = local.ar_repo_prefix
      }
      env {
        name  = "FACTORY_CLOUDBUILD_TRIGGER"
        value = google_cloudbuild_trigger.agent_builder.id
      }

      # --- Ledger ---
      env {
        name  = "FACTORY_LEDGER_PATH"
        value = "/tmp/ledger.jsonl"
      }
      env {
        name  = "FACTORY_LEDGER_WORM_URI"
        value = "gcs://${google_storage_bucket.ledger_worm.name}/ledger"
      }
      env {
        name  = "FACTORY_LEDGER_RETENTION_DAYS"
        value = tostring(var.ledger_retention_days)
      }

      # --- Secrets backend ---
      env {
        name  = "FACTORY_SECRETS_GCP_PROJECT"
        value = var.project_id
      }

      # --- Auth ---
      env {
        name  = "FACTORY_OIDC_ISSUER"
        value = var.oidc_issuer
      }
      env {
        name  = "FACTORY_OIDC_AUDIENCE"
        value = var.oidc_audience
      }
      env {
        name  = "FACTORY_OIDC_ROLES_CLAIM"
        value = var.oidc_roles_claim
      }

      # --- Memory store ---
      env {
        name  = "MEMORY_STORE_DIR"
        value = "/tmp/mind"
      }
      env {
        name  = "MEMORY_STORE_URI"
        value = "gcs://${google_storage_bucket.mind.name}"
      }
      env {
        name  = "MEMORY_EPHEMERAL_DIR"
        value = "/tmp/ephemeral"
      }
      env {
        name  = "FACTORY_DEFAULT_POLICY"
        value = jsonencode({ routes = ["anthropic", "openai", "discord", "google-calendar", "google-oauth", "google-gmail", "google-drive"] })
      }

      # --- Secrets (injected from Secret Manager) ---
      env {
        name = "FACTORY_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "factory-token"
            version = "latest"
          }
        }
      }
      env {
        name = "FACTORY_RUN_TOKEN_KEY"
        value_source {
          secret_key_ref {
            secret  = "factory-run-token-key"
            version = "latest"
          }
        }
      }
      env {
        name = "FACTORY_CALLBACK_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = "factory-callback-signing-key"
            version = "latest"
          }
        }
      }
      env {
        name = "GATEKEEPER_INGRESS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "gatekeeper-ingress-token"
            version = "latest"
          }
        }
      }
      env {
        name = "FACTORY_TOKENS"
        value_source {
          secret_key_ref {
            secret  = "factory-tokens"
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [google_artifact_registry_repository.dynamic_agents]
}

# ---- gatekeeper-egress -----------------------------------------------------------------
resource "google_cloud_run_v2_service" "gatekeeper_egress" {
  count    = local.images_ready ? 1 : 0
  name     = "${local.name}-gw"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.gatekeeper_egress.email

    scaling {
      min_instance_count = 1
      max_instance_count = 5
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.factory.id
        subnetwork = google_compute_subnetwork.services.id
      }
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = var.gatekeeper_egress_image

      ports {
        container_port = 8081
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "512Mi"
        }
      }

      env {
        name  = "PORT"
        value = "8081"
      }
      env {
        name  = "FACTORY_SECRETS_GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "FACTORY_GATEKEEPER_EGRESS_ROUTES"
        value = var.gatekeeper_egress_routes
      }
      env {
        name  = "FACTORY_PRICES"
        value = var.gatekeeper_egress_prices
      }
      env {
        name  = "FACTORY_TRACE_PROMPTS"
        value = var.trace_prompts ? "on" : "off"
      }
      env {
        name  = "FACTORY_TRACE_DIR"
        value = "/tmp/traces"
      }

      env {
        name = "FACTORY_GATEKEEPER_EGRESS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "gatekeeper-egress-token"
            version = "latest"
          }
        }
      }
      env {
        name = "FACTORY_RUN_TOKEN_KEY"
        value_source {
          secret_key_ref {
            secret  = "factory-run-token-key"
            version = "latest"
          }
        }
      }
    }
  }
}

# ---- gatekeeper-ingress -----------------------------------------------------------------
resource "google_cloud_run_v2_service" "gatekeeper_ingress" {
  count    = local.images_ready ? 1 : 0
  name     = "${local.name}-dm"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.gatekeeper_ingress.email

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    containers {
      image = var.gatekeeper_ingress_image

      ports {
        container_port = 8090
      }

      resources {
        limits = {
          cpu    = "500m"
          memory = "256Mi"
        }
      }

      env {
        name  = "PORT"
        value = "8090"
      }
      env {
        name  = "FACTORY_URL"
        value = local.images_ready ? google_cloud_run_v2_service.control_plane[0].uri : ""
      }
      env {
        name  = "FACTORY_SECRETS_GCP_PROJECT"
        value = var.project_id
      }

      env {
        name = "FACTORY_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "gatekeeper-ingress-operator-token"
            version = "latest"
          }
        }
      }
      env {
        name = "GATEKEEPER_INGRESS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "gatekeeper-ingress-token"
            version = "latest"
          }
        }
      }
    }
  }
}

# ---- static cartridge agents (Cloud Run Jobs, scale to 0) --------------------
# Dynamic/PaaS agents are registered by the control plane at runtime.
# These are the statically-declared cartridges from var.agents.
resource "google_cloud_run_v2_job" "agents" {
  for_each = var.agents
  name     = "${local.name}-ag-${each.key}"
  location = var.region

  labels = {
    "factory-component" = "agent"
    "factory-agent-id"  = each.key
  }

  template {
    template {
      service_account = google_service_account.agent[each.key].email
      max_retries     = 0

      timeout = "3600s" # 1-hour max per task; matches AWS run timeout pattern

      vpc_access {
        network_interfaces {
          network    = google_compute_network.factory.id
          subnetwork = google_compute_subnetwork.agents.id
        }
        egress = "ALL_TRAFFIC"
      }

      containers {
        image = each.value.image

        resources {
          limits = {
            cpu    = each.value.cpu
            memory = each.value.memory
          }
        }

        env {
          name  = "AGENT_ID"
          value = each.key
        }
        env {
          name  = "MEMORY_DIR"
          value = "/tmp/mind"
        }
        env {
          name  = "MEMORY_PREFIX"
          value = each.key
        }
        env {
          name  = "MEMORY_STORE_URI"
          value = "gcs://${google_storage_bucket.mind.name}"
        }
        env {
          name  = "DISCORD_BASE_URL"
          value = local.images_ready ? "${google_cloud_run_v2_service.gatekeeper_egress[0].uri}/discord" : ""
        }
        env {
          name  = "OPENAI_BASE_URL"
          value = local.images_ready ? "${google_cloud_run_v2_service.gatekeeper_egress[0].uri}/v1" : ""
        }
        env {
          name  = "ANTHROPIC_BASE_URL"
          value = local.images_ready ? "${google_cloud_run_v2_service.gatekeeper_egress[0].uri}/anthropic" : ""
        }
        env {
          name  = "GOOGLE_CALENDAR_BASE_URL"
          value = local.images_ready ? "${google_cloud_run_v2_service.gatekeeper_egress[0].uri}/google-calendar" : ""
        }
        env {
          name  = "GOOGLE_OAUTH_BASE_URL"
          value = local.images_ready ? "${google_cloud_run_v2_service.gatekeeper_egress[0].uri}/google-oauth" : ""
        }
        env {
          name  = "GMAIL_BASE_URL"
          value = local.images_ready ? "${google_cloud_run_v2_service.gatekeeper_egress[0].uri}/google-gmail" : ""
        }
        env {
          name  = "GOOGLE_DRIVE_BASE_URL"
          value = local.images_ready ? "${google_cloud_run_v2_service.gatekeeper_egress[0].uri}/google-drive" : ""
        }
        env {
          name  = "FACTORY_URL"
          value = local.images_ready ? google_cloud_run_v2_service.control_plane[0].uri : ""
        }

        # Secrets from Secret Manager
        dynamic "env" {
          for_each = each.value.secrets
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
    }
  }
}

# ---- outputs -----------------------------------------------------------------
output "control_plane_url" {
  value       = local.images_ready ? google_cloud_run_v2_service.control_plane[0].uri : ""
  description = "Control plane Cloud Run service URL"
}

output "gatekeeper_egress_url" {
  value       = local.images_ready ? google_cloud_run_v2_service.gatekeeper_egress[0].uri : ""
  description = "gatekeeper-egress Cloud Run service URL"
}

output "gatekeeper_ingress_url" {
  value       = local.images_ready ? google_cloud_run_v2_service.gatekeeper_ingress[0].uri : ""
  description = "gatekeeper-ingress Cloud Run service URL"
}

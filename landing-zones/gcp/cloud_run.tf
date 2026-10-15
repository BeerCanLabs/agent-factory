# ============================================================================================
# Cloud Run Services & Jobs — Agent Factory GCP Landing Zone
# Equivalent to landing-zones/aws/ecs.tf.
# Services: control-plane, console, gatekeeper-egress, gatekeeper-ingress
# Jobs: agents (scale to 0; woken by control plane)
# ============================================================================================

locals {
  images_ready   = var.control_plane_image != "" && var.gatekeeper_ingress_image != "" && var.gatekeeper_egress_image != ""
  ar_repo_prefix = "${var.region}-docker.pkg.dev/${var.project_id}/${local.name}-agents/dynamic"
  # Map of static agent IDs to their Cloud Run Job names (passed to FACTORY_CLOUDRUN_JOBS)
  agent_job_map  = join(",", [for id, _ in var.agents : "${id}:${local.name}-ag-${id}"])
  secrets_prefix = "${local.name}-"
}

# ---- control plane -----------------------------------------------------------
resource "google_cloud_run_v2_service" "control_plane" {
  count    = local.images_ready ? 1 : 0
  name     = "${local.name}-cp"
  location = var.region
  # A1: only the Cloud Armor-protected Load Balancer and internal VPC services may reach the control plane
  ingress  = "INGRESS_TRAFFIC_INTERNAL_AND_CLOUD_LOAD_BALANCING"

  template {
    service_account       = google_service_account.control_plane.email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    # LG1: single ledger writer
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.factory.id
        subnetwork = google_compute_subnetwork.services.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    # R1: durable versioned GCS state bucket mounted at /data
    volumes {
      name = "factory-state"
      gcs {
        bucket    = google_storage_bucket.state.name
        read_only = false
      }
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

      volume_mounts {
        name       = "factory-state"
        mount_path = "/data"
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
        name  = "FACTORY_DEPLOY_PROVIDER"
        value = "gcp"
      }
      env {
        name  = "FACTORY_SYSTEMS_IMPORT"
        value = var.systems_import
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
        name  = "FACTORY_CLOUDRUN_JOBS"
        value = local.agent_job_map
      }
      env {
        name  = "FACTORY_GCP_VPC_NETWORK"
        value = google_compute_network.factory.id
      }
      env {
        name  = "FACTORY_GCP_AGENTS_SUBNET"
        value = google_compute_subnetwork.agents.id
      }
      env {
        name  = "FACTORY_ARTIFACT_REGISTRY"
        value = local.ar_repo_prefix
      }
      env {
        name  = "FACTORY_BUILDER_SA"
        value = google_service_account.cloudbuild.email
      }
      env {
        name  = "FACTORY_SKILL_CHECKER_SA"
        value = google_service_account.skill_checker.email
      }
      env {
        name  = "FACTORY_ACCOUNTANT_SA"
        value = google_service_account.accountant.email
      }
      env {
        name  = "FACTORY_GCP_BILLING_DATASET"
        value = google_bigquery_dataset.billing_export.dataset_id
      }
      env {
        name  = "FACTORY_AGENT_SOURCE_TOKEN_HOSTS"
        value = join(",", var.agent_source_token_hosts)
      }
      env {
        name  = "FACTORY_AGENT_SOURCE_TOKEN_SECRET"
        value = var.agent_source_token_secret_name
      }
      env {
        name  = "FACTORY_PUBLIC_BASE_URL"
        value = var.factory_domain != "" ? "https://${var.factory_domain}" : ""
      }
      env {
        name  = "FACTORY_GATEKEEPER_EGRESS_URL"
        value = google_cloud_run_v2_service.gatekeeper_egress[0].uri
      }
      env {
        name  = "FACTORY_GATEKEEPER_EGRESS_HELD_SECRETS"
        value = join(",", var.provider_secret_names)
      }
      env {
        name  = "FACTORY_MODEL_CATALOG"
        value = var.model_catalog
      }
      env {
        name  = "FACTORY_DEFAULT_MODEL"
        value = var.default_model
      }
      env {
        name  = "FACTORY_EVENT_BUS"
        value = "pubsub:projects/${var.project_id}/topics/${google_pubsub_topic.events.name}"
      }

      # --- Durable state paths on /data (GCS volume mount, R1) ---
      env {
        name  = "FACTORY_REGISTRY_DIR"
        value = "/data/registry"
      }
      env {
        name  = "FACTORY_POLICIES_DIR"
        value = "/data/policies"
      }
      env {
        name  = "FACTORY_RUNS_DIR"
        value = "/data/runs"
      }
      env {
        name  = "FACTORY_SYSTEMS_DIR"
        value = "/data/systems"
      }
      env {
        name  = "FACTORY_SKILLS_DIR"
        value = "/data/skills"
      }
      env {
        name  = "FACTORY_SCHEDULES_PATH"
        value = "/data/schedules.json"
      }
      env {
        name  = "FACTORY_BUDGETS_PATH"
        value = "/data/budgets.json"
      }
      env {
        name  = "FACTORY_CONFIG_STORE_URI"
        value = "gcs://${google_storage_bucket.config.name}/configs"
      }

      # --- Ledger (local /tmp hydrated from & flushed to WORM GCS bucket, LG1/LG2) ---
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

      # --- Secrets backend (K2-K5) ---
      env {
        name  = "FACTORY_SECRETS_GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "FACTORY_SECRETS_GCP_PREFIX"
        value = local.secrets_prefix
      }

      # --- Auth & Cloudflare Access (A2) ---
      env {
        name  = "FACTORY_ACCESS_TEAM_DOMAIN"
        value = var.access_team_domain
      }
      env {
        name  = "FACTORY_ACCESS_AUD"
        value = var.access_aud
      }
      env {
        name  = "FACTORY_ADMIN_EMAILS"
        value = var.admin_emails
      }
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
        name  = "FACTORY_MIND_BUCKET"
        value = google_storage_bucket.mind.name
      }
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

      # --- Platform Secrets (seeded out-of-band in Secret Manager per K5) ---
      env {
        name = "FACTORY_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "${local.secrets_prefix}FACTORY_TOKEN"
            version = "latest"
          }
        }
      }
      env {
        name = "FACTORY_RUN_TOKEN_KEY"
        value_source {
          secret_key_ref {
            secret  = "${local.secrets_prefix}FACTORY_RUN_TOKEN_KEY"
            version = "latest"
          }
        }
      }
      env {
        name = "FACTORY_CALLBACK_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = "${local.secrets_prefix}FACTORY_CALLBACK_SIGNING_KEY"
            version = "latest"
          }
        }
      }
      env {
        name = "GATEKEEPER_INGRESS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "${local.secrets_prefix}GATEKEEPER_INGRESS_TOKEN"
            version = "latest"
          }
        }
      }
      env {
        name = "FACTORY_GATEKEEPER_EGRESS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "${local.secrets_prefix}FACTORY_GATEKEEPER_EGRESS_TOKEN"
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [google_artifact_registry_repository.dynamic_agents]
}

# Allow the Load Balancer / internal callers to reach the control plane HTTP port
# (Control plane itself enforces A2 Access JWT / Bearer token verification on every request)
resource "google_cloud_run_v2_service_iam_member" "control_plane_public_lb" {
  count    = local.images_ready ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.control_plane[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---- console (A2: operator dashboard, holds zero factory credentials) --------
resource "google_cloud_run_v2_service" "console" {
  count    = local.images_ready && var.console_image != "" ? 1 : 0
  name     = "${local.name}-console"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_AND_CLOUD_LOAD_BALANCING"

  template {
    service_account = google_service_account.console.email

    scaling {
      min_instance_count = 1
      max_instance_count = 2
    }

    containers {
      image = var.console_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "512Mi"
        }
      }

      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "FACTORY_INTERNAL_URL"
        value = google_cloud_run_v2_service.control_plane[0].uri
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "console_public_lb" {
  count    = local.images_ready && var.console_image != "" ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.console[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---- gatekeeper-egress -------------------------------------------------------
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
        name  = "FACTORY_GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "FACTORY_GCP_REGION"
        value = var.region
      }
      env {
        name  = "FACTORY_SECRETS_GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "FACTORY_SECRETS_GCP_PREFIX"
        value = local.secrets_prefix
      }
      env {
        name  = "FACTORY_GATEKEEPER_EGRESS_ROUTES"
        value = var.gatekeeper_egress_routes
      }
      env {
        name  = "FACTORY_MODEL_CATALOG"
        value = var.model_catalog
      }
      env {
        name  = "FACTORY_DEFAULT_MODEL"
        value = var.default_model
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
            secret  = "${local.secrets_prefix}FACTORY_GATEKEEPER_EGRESS_TOKEN"
            version = "latest"
          }
        }
      }
      env {
        name = "FACTORY_RUN_TOKEN_KEY"
        value_source {
          secret_key_ref {
            secret  = "${local.secrets_prefix}FACTORY_RUN_TOKEN_KEY"
            version = "latest"
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "gatekeeper_egress_internal" {
  count    = local.images_ready ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.gatekeeper_egress[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---- gatekeeper-ingress ------------------------------------------------------
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

    vpc_access {
      network_interfaces {
        network    = google_compute_network.factory.id
        subnetwork = google_compute_subnetwork.services.id
      }
      egress = "ALL_TRAFFIC"
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
        name  = "FACTORY_SECRETS_GCP_PREFIX"
        value = local.secrets_prefix
      }

      env {
        name = "FACTORY_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "${local.secrets_prefix}GATEKEEPER_INGRESS_OPERATOR_TOKEN"
            version = "latest"
          }
        }
      }
      env {
        name = "GATEKEEPER_INGRESS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "${local.secrets_prefix}GATEKEEPER_INGRESS_TOKEN"
            version = "latest"
          }
        }
      }
    }
  }
}

# ---- static cartridge agents (Cloud Run Jobs, scale to 0) --------------------
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
      timeout         = "3600s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.factory.id
          subnetwork = google_compute_subnetwork.agents.id
        }
        egress = "ALL_TRAFFIC"
      }

      containers {
        name  = "worker"
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
          name  = "FACTORY_MIND_BUCKET"
          value = google_storage_bucket.mind.name
        }
        env {
          name  = "FACTORY_URL"
          value = local.images_ready ? google_cloud_run_v2_service.control_plane[0].uri : ""
        }

        dynamic "env" {
          for_each = each.value.secrets
          content {
            name = env.value
            value_source {
              secret_key_ref {
                secret  = "${local.secrets_prefix}${env.value}"
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

output "console_url" {
  value       = local.images_ready && var.console_image != "" ? google_cloud_run_v2_service.console[0].uri : ""
  description = "Console Cloud Run service URL"
}

output "gatekeeper_egress_url" {
  value       = local.images_ready ? google_cloud_run_v2_service.gatekeeper_egress[0].uri : ""
  description = "gatekeeper-egress Cloud Run service URL"
}

output "gatekeeper_ingress_url" {
  value       = local.images_ready ? google_cloud_run_v2_service.gatekeeper_ingress[0].uri : ""
  description = "gatekeeper-ingress Cloud Run service URL"
}

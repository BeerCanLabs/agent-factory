# ============================================================================================
# Front Door Load Balancer & Cloud Armor — Agent Factory GCP Landing Zone (DESIGN_AUTHORITY §6.12 A1)
# Equivalent to landing-zones/aws/alb.tf.
#
# Only the identity-aware proxy (var.ingress_cidrs, e.g. Cloudflare Access edge IPs) may reach
# the platform's external load balancer, and Cloud Run services accept only internal + Cloud Load
# Balancing traffic (INGRESS_TRAFFIC_INTERNAL_AND_CLOUD_LOAD_BALANCING).
# ============================================================================================

locals {
  lb_enabled      = local.images_ready && var.factory_domain != ""
  console_enabled = local.lb_enabled && var.console_image != "" && var.console_domain != ""
  # Cloud Armor rules allow up to 10 CIDR ranges per rule; chunk var.ingress_cidrs into groups of 10.
  ingress_cidr_chunks = chunklist(var.ingress_cidrs, 10)
}

resource "google_compute_security_policy" "front_door" {
  name        = "${local.name}-front-door-armor"
  description = "A1: allow only the identity-aware proxy edge (var.ingress_cidrs) to reach the factory load balancer"

  dynamic "rule" {
    for_each = { for idx, chunk in local.ingress_cidr_chunks : idx => chunk }
    content {
      action   = "allow"
      priority = 1000 + rule.key
      match {
        versioned_expr = "SRC_IPS_V1"
        config {
          src_ip_ranges = rule.value
        }
      }
      description = "Allow identity-aware proxy CIDRs (chunk ${rule.key})"
    }
  }

  rule {
    action   = "deny(403)"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default deny all direct internet traffic bypassing the identity-aware proxy"
  }
}

resource "google_compute_global_address" "front_door" {
  count = local.lb_enabled ? 1 : 0
  name  = "${local.name}-front-door-ip"
}

resource "google_compute_region_network_endpoint_group" "control_plane" {
  count                 = local.lb_enabled ? 1 : 0
  name                  = "${local.name}-cp-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region
  cloud_run {
    service = google_cloud_run_v2_service.control_plane[0].name
  }
}

resource "google_compute_backend_service" "control_plane" {
  count                 = local.lb_enabled ? 1 : 0
  name                  = "${local.name}-cp-backend"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = google_compute_security_policy.front_door.id

  backend {
    group = google_compute_region_network_endpoint_group.control_plane[0].id
  }
}

resource "google_compute_region_network_endpoint_group" "console" {
  count                 = local.console_enabled ? 1 : 0
  name                  = "${local.name}-console-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region
  cloud_run {
    service = google_cloud_run_v2_service.console[0].name
  }
}

resource "google_compute_backend_service" "console" {
  count                 = local.console_enabled ? 1 : 0
  name                  = "${local.name}-console-backend"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = google_compute_security_policy.front_door.id

  backend {
    group = google_compute_region_network_endpoint_group.console[0].id
  }
}

resource "google_compute_url_map" "front_door" {
  count           = local.lb_enabled ? 1 : 0
  name            = "${local.name}-front-door-urlmap"
  default_service = google_compute_backend_service.control_plane[0].id

  host_rule {
    hosts        = [var.factory_domain]
    path_matcher = "control-plane"
  }

  path_matcher {
    name            = "control-plane"
    default_service = google_compute_backend_service.control_plane[0].id
  }

  dynamic "host_rule" {
    for_each = local.console_enabled ? [1] : []
    content {
      hosts        = [var.console_domain]
      path_matcher = "console"
    }
  }

  dynamic "path_matcher" {
    for_each = local.console_enabled ? [1] : []
    content {
      name            = "console"
      default_service = google_compute_backend_service.console[0].id
    }
  }
}

resource "google_compute_managed_ssl_certificate" "front_door" {
  count = local.lb_enabled ? 1 : 0
  name  = "${local.name}-front-door-cert"

  managed {
    domains = compact([var.factory_domain, local.console_enabled ? var.console_domain : ""])
  }
}

resource "google_compute_target_https_proxy" "front_door" {
  count            = local.lb_enabled ? 1 : 0
  name             = "${local.name}-front-door-https-proxy"
  url_map          = google_compute_url_map.front_door[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.front_door[0].id]
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = local.lb_enabled ? 1 : 0
  name                  = "${local.name}-front-door-https"
  target                = google_compute_target_https_proxy.front_door[0].id
  port_range            = "443"
  ip_address            = google_compute_global_address.front_door[0].address
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

output "load_balancer_ip" {
  value       = local.lb_enabled ? google_compute_global_address.front_door[0].address : ""
  description = "Global External Application Load Balancer IPv4 address (point DNS A records here)"
}

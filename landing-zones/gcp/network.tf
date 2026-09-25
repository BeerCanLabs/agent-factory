# ============================================================================================
# Network — Agent Factory GCP Landing Zone
# VPC, private subnets, Cloud Router, and Cloud NAT.
# 
# Security Perimeter Architecture:
# - Services Subnet (10.0.1.0/24): Control Plane and Gateway sit here with Cloud NAT egress.
# - Agents Subnet (10.0.2.0/24): Cartridges (Cloud Run Jobs) execute here with ZERO Cloud NAT.
#   Direct internet egress (0.0.0.0/0) is strictly dropped by GCP VPC routing.
#   All external API traffic (LLMs, Discord, Slack) must route through the Factory Gateway
#   via DISCORD_BASE_URL, OPENAI_BASE_URL, and ANTHROPIC_BASE_URL.
# ============================================================================================

resource "google_compute_network" "factory" {
  name                    = "${local.name}-vpc"
  auto_create_subnetworks = false
}

# Subnet for services (Control Plane, Gateway, Doorman)
resource "google_compute_subnetwork" "services" {
  name                     = "${local.name}-services"
  ip_cidr_range            = "10.0.1.0/24"
  region                   = var.region
  network                  = google_compute_network.factory.id
  private_ip_google_access = true
}

# Subnet for agents: isolated, no NAT gateway, zero egress to public internet
resource "google_compute_subnetwork" "agents" {
  name                     = "${local.name}-agents"
  ip_cidr_range            = "10.0.2.0/24"
  region                   = var.region
  network                  = google_compute_network.factory.id
  private_ip_google_access = true
}

# Cloud Router and NAT for services subnet only (allows Gateway to reach external APIs)
resource "google_compute_router" "router" {
  name    = "${local.name}-router"
  region  = var.region
  network = google_compute_network.factory.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${local.name}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.services.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

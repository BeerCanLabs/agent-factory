variable "project_id" {
  type        = string
  description = "GCP Project ID for the Agent Factory."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "control_plane_image" {
  type        = string
  description = "Control plane container image URI. Set to empty string to skip Cloud Run service creation."
  default     = ""
}

variable "gateway_image" {
  type    = string
  default = ""
}

variable "doorman_image" {
  type    = string
  default = ""
}

variable "agents" {
  description = "Static cartridges declared at Terraform time. Each gets its own Cloud Run Job and Service Account. Dynamic (PaaS) agents are provisioned by the control plane at runtime — those do NOT appear here."
  type = map(object({
    image   = string
    cpu     = optional(string, "1000m")
    memory  = optional(string, "512Mi")
    secrets = optional(list(string), [])
  }))
  default = {}
}

variable "provider_secret_names" {
  description = "Names of provider API-key secrets in Secret Manager (e.g. ANTHROPIC_API_KEY). Only the gateway SA reads these."
  type        = list(string)
  default     = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
}

variable "discord_secret_name" {
  description = "Name of the Discord bot token secret in Secret Manager. Leave empty to deploy Doorman in sleeping mode (no Discord app required at factory build)."
  type        = string
  default     = ""
}

variable "oidc_issuer" {
  description = "OIDC issuer URL for control-plane auth (e.g. https://accounts.google.com)"
  type        = string
  default     = ""
}

variable "oidc_audience" {
  type    = string
  default = ""
}

variable "oidc_roles_claim" {
  type    = string
  default = "roles"
}

variable "trace_prompts" {
  type    = bool
  default = false
}

variable "ledger_retention_days" {
  type    = number
  default = 365
}

variable "gateway_routes" {
  description = "JSON or YAML gateway route config passed to FACTORY_GATEWAY_ROUTES."
  type        = string
  default     = ""
}

variable "gateway_prices" {
  description = "JSON price map for budget tracking."
  type        = string
  default     = ""
}

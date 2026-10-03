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

variable "gatekeeper_egress_image" {
  type    = string
  default = ""
}

variable "gatekeeper_ingress_image" {
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
  description = "Names of provider API-key secrets in Secret Manager (e.g. ANTHROPIC_API_KEY). Only the gatekeeper-egress SA reads these."
  type        = list(string)
  default     = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
}

variable "discord_secret_name" {
  description = "Name of the Discord bot token secret in Secret Manager. Leave empty to deploy gatekeeper-ingress in sleeping mode (no Discord app required at factory build)."
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

variable "systems_import" {
  description = "TRANSITIONAL (GAP-068, TSK-066): the non-model routes this landing zone used to give the gatekeeper-egress, imported once into the factory's systems store as approved systems, with the OAuth providers the Keymaster used to define in code (TSK-067) (an existing system is never overwritten). Removed once every deployment has imported them."
  type        = string
  default     = "[{\"id\":\"discord\",\"kind\":\"http\",\"upstream\":\"https://discord.com/api/v10\",\"credential\":{\"secret\":\"{agent}_DISCORD_BOT_TOKEN\",\"header\":\"authorization\",\"format\":\"Bot {}\"}},{\"id\":\"google-calendar\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/calendar/v3\",\"connection\":\"google\"},{\"id\":\"google-oauth\",\"kind\":\"http\",\"upstream\":\"https://oauth2.googleapis.com\"},{\"id\":\"google-gmail\",\"kind\":\"http\",\"upstream\":\"https://gmail.googleapis.com\",\"connection\":\"google\"},{\"id\":\"google-drive\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/drive/v3\",\"connection\":\"google\"},{\"id\":\"google\",\"name\":\"Google (OAuth)\",\"kind\":\"http\",\"upstream\":\"https://accounts.google.com\",\"oauth\":{\"kind\":\"oauth-user\",\"authUrl\":\"https://accounts.google.com/o/oauth2/v2/auth\",\"tokenUrl\":\"https://oauth2.googleapis.com/token\",\"clientSecret\":\"GOOGLE_OAUTH_CLIENT\",\"authParams\":{\"access_type\":\"offline\",\"prompt\":\"consent\",\"include_granted_scopes\":\"true\"}}}]"
}

variable "gatekeeper_egress_routes" {
  description = "JSON gatekeeper-egress model route config passed to FACTORY_GATEKEEPER_EGRESS_ROUTES. Non-model routes are factory data (§6.3.1 E10), maintained in the control plane."
  type        = string
  default     = "[{\"id\":\"anthropic\",\"kind\":\"llm\",\"provider\":\"anthropic\",\"upstream\":\"https://api.anthropic.com\",\"credential\":{\"secret\":\"ANTHROPIC_API_KEY\",\"header\":\"x-api-key\"}},{\"id\":\"openai\",\"kind\":\"llm\",\"provider\":\"openai\",\"upstream\":\"https://api.openai.com\",\"credential\":{\"secret\":\"OPENAI_API_KEY\",\"header\":\"authorization\",\"format\":\"Bearer {}\"}}]"
}

variable "gatekeeper_egress_prices" {
  description = "JSON price map for budget tracking."
  type        = string
  default     = ""
}

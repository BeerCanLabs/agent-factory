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

variable "console_image" {
  type        = string
  description = "Console (dashboard) container image URI."
  default     = ""
}

variable "ingress_cidrs" {
  description = "CIDR blocks of the identity-aware proxy edge allowed to reach the external load balancer (A1). Direct internet (/0) is refused."
  type        = list(string)
  validation {
    condition     = length(var.ingress_cidrs) > 0 && alltrue([for c in var.ingress_cidrs : can(cidrHost(c, 0)) && !can(regex("/0$", c))])
    error_message = "ingress_cidrs must be non-empty valid CIDRs and may not contain /0."
  }
}

variable "factory_domain" {
  description = "Public hostname routed to the control plane (e.g. gcp-factory.beercanlabs.com)."
  type        = string
  default     = ""
}

variable "console_domain" {
  description = "Public hostname routed to the operator console (e.g. gcp-dashboard.beercanlabs.com)."
  type        = string
  default     = ""
}

variable "access_team_domain" {
  description = "Cloudflare Access team domain (e.g. beercanlabs.cloudflareaccess.com) for A2 JWT verification."
  type        = string
  default     = ""
}

variable "access_aud" {
  description = "Cloudflare Access Application Audience (AUD) tag for A2 JWT verification."
  type        = string
  default     = ""
}

variable "admin_emails" {
  description = "Comma-separated operator emails granted the admin role when verified by Access (A2)."
  type        = string
  default     = ""
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
  description = "Names of provider API-key secrets in Secret Manager (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY). Only the gatekeeper-egress SA reads these (S1)."
  type        = list(string)
  default     = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"]
}

variable "discord_secret_name" {
  description = "Name of the Discord bot token secret in Secret Manager. Leave empty to deploy gatekeeper-ingress in sleeping mode (no Discord app required at factory build)."
  type        = string
  default     = ""
}

variable "agent_source_token_secret_name" {
  description = "Secret Manager secret name holding the read-only GitHub PAT for cloning private agent and skill repositories during Cloud Build admission."
  type        = string
  default     = ""
}

variable "agent_source_token_hosts" {
  description = "Git hosts that may receive the agent source token during admission and skill checks (S1)."
  type        = list(string)
  default     = ["github.com"]
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

variable "model_catalog" {
  description = "JSON model catalog (M1-M3) served by both the control plane and the Executive inside gatekeeper-egress (supports Vertex AI and API-key providers)."
  type        = string
  default     = "{\"claude-sonnet-4-6\":{\"provider\":\"anthropic\",\"price\":{\"inputPerMTok\":3,\"outputPerMTok\":15}},\"claude-opus-4-6\":{\"provider\":\"anthropic\",\"price\":{\"inputPerMTok\":15,\"outputPerMTok\":75}},\"claude-haiku-4-5\":{\"provider\":\"anthropic\",\"price\":{\"inputPerMTok\":0.8,\"outputPerMTok\":4}},\"gemini-2.5-pro\":{\"provider\":\"vertex-gemini\",\"price\":{\"inputPerMTok\":1.25,\"outputPerMTok\":10}},\"gemini-2.5-flash\":{\"provider\":\"vertex-gemini\",\"price\":{\"inputPerMTok\":0.15,\"outputPerMTok\":0.6}},\"gpt-4o\":{\"provider\":\"openai\",\"price\":{\"inputPerMTok\":2.5,\"outputPerMTok\":10}},\"grok-3\":{\"provider\":\"xai\",\"price\":{\"inputPerMTok\":3,\"outputPerMTok\":15}}}"
}

variable "default_model" {
  description = "Seed for the factory default model (DESIGN_AUTHORITY M2): used only until an admin sets the default, which is factory configuration. Empty means no seed."
  type        = string
  default     = ""
}

variable "systems_import" {
  description = "TRANSITIONAL (GAP-068, TSK-066): the non-model routes this landing zone used to give the gatekeeper-egress, imported once into the factory's systems store as approved systems, with the OAuth providers the Keymaster used to define in code (TSK-067) (an existing system is never overwritten). Removed once every deployment has imported them."
  type        = string
  default     = "[{\"id\":\"discord\",\"kind\":\"http\",\"upstream\":\"https://discord.com/api/v10\",\"credential\":{\"secret\":\"{agent}_DISCORD_BOT_TOKEN\",\"header\":\"authorization\",\"format\":\"Bot {}\"}},{\"id\":\"google-calendar\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/calendar/v3\",\"connection\":\"google\"},{\"id\":\"google-oauth\",\"kind\":\"http\",\"upstream\":\"https://oauth2.googleapis.com\"},{\"id\":\"google-gmail\",\"kind\":\"http\",\"upstream\":\"https://gmail.googleapis.com\",\"connection\":\"google\"},{\"id\":\"google-drive\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/drive/v3\",\"connection\":\"google\"},{\"id\":\"google\",\"name\":\"Google (OAuth)\",\"kind\":\"http\",\"upstream\":\"https://accounts.google.com\",\"oauth\":{\"kind\":\"oauth-user\",\"authUrl\":\"https://accounts.google.com/o/oauth2/v2/auth\",\"tokenUrl\":\"https://oauth2.googleapis.com/token\",\"clientSecret\":\"GOOGLE_OAUTH_CLIENT\",\"authParams\":{\"access_type\":\"offline\",\"prompt\":\"consent\",\"include_granted_scopes\":\"true\"}}}]"
}

variable "gatekeeper_egress_routes" {
  description = "JSON gatekeeper-egress model route config passed to FACTORY_GATEKEEPER_EGRESS_ROUTES. Non-model routes are factory data (§6.3.1 E10), maintained in the control plane."
  type        = string
  default     = "[{\"id\":\"models\",\"kind\":\"models\"},{\"id\":\"anthropic\",\"kind\":\"llm\",\"provider\":\"anthropic\",\"upstream\":\"https://api.anthropic.com\",\"credential\":{\"secret\":\"ANTHROPIC_API_KEY\",\"header\":\"x-api-key\"}},{\"id\":\"openai\",\"kind\":\"llm\",\"provider\":\"openai\",\"upstream\":\"https://api.openai.com\",\"credential\":{\"secret\":\"OPENAI_API_KEY\",\"header\":\"authorization\",\"format\":\"Bearer {}\"}},{\"id\":\"xai\",\"kind\":\"llm\",\"provider\":\"xai\",\"upstream\":\"https://api.x.ai\",\"credential\":{\"secret\":\"XAI_API_KEY\",\"header\":\"authorization\",\"format\":\"Bearer {}\"}}]"
}

variable "gatekeeper_egress_prices" {
  description = "JSON price map for budget tracking."
  type        = string
  default     = ""
}

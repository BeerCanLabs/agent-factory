variable "account_id" {
  type        = string
  description = "Target AWS account id."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a valid 12-digit AWS account id."
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "ingress_cidrs" {
  type        = list(string)
  description = "The only IPv4 sources allowed to reach the load balancer (§6.12 A1): the identity-aware proxy's published ranges, e.g. https://www.cloudflare.com/ips-v4. Required; never 0.0.0.0/0."
  validation {
    condition     = length(var.ingress_cidrs) > 0 && alltrue([for c in var.ingress_cidrs : can(cidrhost(c, 0)) && !can(regex("/0$", c))])
    error_message = "ingress_cidrs must be a non-empty list of IPv4 CIDRs, none of them /0: only the identity-aware proxy may reach the load balancer."
  }
}

variable "certificate_arn" {
  type        = string
  description = "ACM certificate for the control plane's HTTPS listener. There is no plain-HTTP listener."
  validation {
    condition     = can(regex("^arn:aws:acm:", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate ARN; the control plane is HTTPS-only."
  }
}

variable "control_plane_image" {
  type    = string
  default = ""
}

variable "gatekeeper_ingress_image" {
  type    = string
  default = ""
}

variable "gatekeeper_egress_image" {
  type    = string
  default = ""
}

variable "agent_source_token_secret_arn" {
  type        = string
  default     = ""
  description = "Secrets Manager ARN of a read-only git token (e.g. a GitHub fine-grained PAT with Contents: read on the agent repositories) that the agent admission build uses to clone private agent repositories. Empty = public repositories only."
}

variable "agents" {
  description = "Cartridges to run as ECS task definitions. Each gets its own task role scoped to its mind prefix."
  type = map(object({
    image   = string
    secrets = optional(list(string), [])
    cpu     = optional(number, 512)
    memory  = optional(number, 1024)
  }))
  default = {}
}

variable "provider_secret_names" {
  description = "Credentials the gatekeeper-egress injects (S1; values set in Secrets Manager by an operator): model provider keys and shared workspace integrations such as Notion (§6.11 K5.5). Only the gatekeeper-egress can read them; they are never put in an agent task definition."
  type        = list(string)
  default     = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NOTION_API_KEY", "MOTION_API_KEY"]
}

variable "extra_provider_secret_names" {
  description = "Deployment-specific gatekeeper-held secrets (e.g. a private service's API token), merged with provider_secret_names. Same rules: only the gatekeeper-egress reads them, never an agent task definition. Until the Keymaster names every entry (TSK-071, GAP-073)."
  type        = list(string)
  default     = []
}

variable "systems_import" {
  description = "TRANSITIONAL (GAP-068, TSK-066): the non-model routes this landing zone used to give the gatekeeper-egress, imported once into the factory's systems store as approved systems, with the OAuth providers the Keymaster used to define in code (TSK-067) (actor migration:landing-zone; an existing system is never overwritten). The gatekeeper-egress no longer receives them. Removed once every deployment has imported them."
  type        = string
  default     = "[{\"id\":\"discord\",\"kind\":\"http\",\"upstream\":\"https://discord.com/api/v10\",\"credential\":{\"secret\":\"{agent}_DISCORD_BOT_TOKEN\",\"header\":\"authorization\",\"format\":\"Bot {}\"},\"stripSignInLinks\":true},{\"id\":\"notion\",\"kind\":\"http\",\"upstream\":\"https://api.notion.com\",\"credential\":{\"secret\":\"NOTION_API_KEY\",\"header\":\"authorization\",\"format\":\"Bearer {}\"}},{\"id\":\"google-calendar\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/calendar/v3\",\"connection\":\"google\"},{\"id\":\"google-oauth\",\"kind\":\"http\",\"upstream\":\"https://oauth2.googleapis.com\"},{\"id\":\"google-gmail\",\"kind\":\"http\",\"upstream\":\"https://gmail.googleapis.com\",\"connection\":\"google\"},{\"id\":\"google-drive\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/drive/v3\",\"connection\":\"google\"},{\"id\":\"google-drive-upload\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/upload/drive/v3\",\"connection\":\"google\"},{\"id\":\"google-health\",\"kind\":\"http\",\"upstream\":\"https://health.googleapis.com\",\"connection\":\"google\",\"scopes\":[\"https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly\",\"https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly\",\"https://www.googleapis.com/auth/googlehealth.sleep.readonly\"]},{\"id\":\"google-storage\",\"kind\":\"http\",\"upstream\":\"https://storage.googleapis.com\",\"connection\":\"google-service-account\",\"scopes\":[\"https://www.googleapis.com/auth/devstorage.read_write\"]},{\"id\":\"github\",\"kind\":\"http\",\"upstream\":\"https://api.github.com\",\"credential\":{\"secret\":\"{agent}_GITHUB_TOKEN\",\"header\":\"authorization\",\"format\":\"Bearer {}\",\"fallback\":false}},{\"id\":\"motion\",\"kind\":\"http\",\"upstream\":\"https://api.usemotion.com/v1\",\"credential\":{\"secret\":\"MOTION_API_KEY\",\"header\":\"x-api-key\"}},{\"id\":\"linkedin\",\"kind\":\"http\",\"upstream\":\"https://api.linkedin.com\",\"connection\":\"linkedin\",\"hold\":{\"methods\":[\"POST\",\"PUT\",\"PATCH\",\"DELETE\"],\"preview\":\"linkedin-post\"},\"oauth\":{\"kind\":\"oauth-user\",\"authUrl\":\"https://www.linkedin.com/oauth/v2/authorization\",\"tokenUrl\":\"https://www.linkedin.com/oauth/v2/accessToken\",\"clientSecret\":\"LINKEDIN_OAUTH_CLIENT\",\"authParams\":{},\"refresh\":false}},{\"id\":\"google\",\"name\":\"Google (OAuth)\",\"kind\":\"http\",\"upstream\":\"https://accounts.google.com\",\"oauth\":{\"kind\":\"oauth-user\",\"authUrl\":\"https://accounts.google.com/o/oauth2/v2/auth\",\"tokenUrl\":\"https://oauth2.googleapis.com/token\",\"clientSecret\":\"GOOGLE_OAUTH_CLIENT\",\"authParams\":{\"access_type\":\"offline\",\"prompt\":\"consent\",\"include_granted_scopes\":\"true\"}}},{\"id\":\"google-service-account\",\"name\":\"Google service account\",\"kind\":\"http\",\"upstream\":\"https://oauth2.googleapis.com\",\"oauth\":{\"kind\":\"jwt-bearer\",\"tokenUrl\":\"https://oauth2.googleapis.com/token\",\"keySecret\":\"GOOGLE_SERVICE_ACCOUNT\",\"defaultScopes\":[\"https://www.googleapis.com/auth/devstorage.read_write\"]}}]"
}

variable "extra_gatekeeper_egress_routes" {
  description = "TRANSITIONAL (GAP-068, TSK-066): a deployment's own routes, imported once into the factory's systems store with systems_import. Never given to the gatekeeper-egress. Removed once imported."
  type        = string
  default     = "[]"
  validation {
    condition     = can(tolist(jsondecode(var.extra_gatekeeper_egress_routes)))
    error_message = "extra_gatekeeper_egress_routes must be a JSON array of routes."
  }
}

variable "gatekeeper_egress_routes" {
  description = "JSON array of model gatekeeper-egress routes (anthropic, openai, models). Non-model routes are factory data (§6.3.1 E10), maintained in the control plane."
  type        = string
  default     = "[{\"id\":\"anthropic\",\"kind\":\"llm\",\"provider\":\"anthropic\",\"upstream\":\"https://api.anthropic.com\",\"credential\":{\"secret\":\"ANTHROPIC_API_KEY\",\"header\":\"x-api-key\"}},{\"id\":\"openai\",\"kind\":\"llm\",\"provider\":\"openai\",\"upstream\":\"https://api.openai.com\",\"credential\":{\"secret\":\"OPENAI_API_KEY\",\"header\":\"authorization\",\"format\":\"Bearer {}\"}},{\"id\":\"models\",\"kind\":\"models\"}]"
}


variable "gatekeeper_egress_prices" {
  description = "JSON object of model -> USD per million tokens. Unpriced models are refused."
  type        = string
  default     = "{}"
}

variable "model_catalog" {
  description = "Models the factory model API offers (§6.9 M3): neutral name -> provider adapter, provider model id, region, and USD per million tokens. Passed to the gatekeeper-egress as FACTORY_MODEL_CATALOG."
  type = map(object({
    provider = string
    id       = string
    region   = optional(string)
    price    = object({ inputPerMTok = number, outputPerMTok = number })
  }))
  default = {
    "claude-sonnet-4-5" = {
      provider = "bedrock-converse"
      id       = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
      region   = "us-east-1"
      price    = { inputPerMTok = 3, outputPerMTok = 15 }
    }
    "claude-haiku-4-5" = {
      provider = "bedrock-converse"
      id       = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
      region   = "us-east-1"
      price    = { inputPerMTok = 1, outputPerMTok = 5 }
    }
    "claude-sonnet-4-6" = {
      provider = "bedrock-converse"
      id       = "us.anthropic.claude-sonnet-4-6"
      region   = "us-east-1"
      price    = { inputPerMTok = 3, outputPerMTok = 15 }
    }
    "claude-opus-4-6" = {
      provider = "bedrock-converse"
      id       = "us.anthropic.claude-opus-4-6-v1"
      region   = "us-east-1"
      price    = { inputPerMTok = 5, outputPerMTok = 25 }
    }
  }
}

variable "gatekeeper_egress_count" {
  type    = number
  default = 1
}

variable "oidc_issuer" {
  type    = string
  default = ""
}

variable "oidc_audience" {
  type    = string
  default = ""
}

variable "oidc_roles_claim" {
  type    = string
  default = ""
}

# §6.12 A2: the identity-aware proxy's signed assertion. Both empty (the default) disables Access identity: only
# factory tokens authenticate, and nobody reaches the control plane as themselves through the dashboard.
variable "access_team_domain" {
  type        = string
  default     = ""
  description = "Cloudflare Access team domain, e.g. example.cloudflareaccess.com (issuer https://<domain>; keys from /cdn-cgi/access/certs). Empty disables Access identity."
}

variable "access_aud" {
  type        = string
  default     = ""
  description = "Cloudflare Access application audience tag(s), comma-separated; the assertion's aud must contain one. Empty disables Access identity."
}

variable "admin_emails" {
  type        = string
  default     = ""
  description = "Comma-separated emails that get the admin roles when they arrive with a verified Access assertion. Empty: no admins through Access."
}

variable "ledger_retention_days" {
  type        = number
  default     = 365
  description = "COMPLIANCE-mode retention for ledger checkpoints. Cannot be shortened once objects are written."
}

variable "config_noncurrent_retention_days" {
  type        = number
  default     = 365
  description = "§6.13 R1: how long the configuration bucket keeps superseded or deleted object versions for point-in-time restore."
  validation {
    condition     = var.config_noncurrent_retention_days >= 90
    error_message = "Keep non-current configuration versions for at least 90 days."
  }
}

variable "trace_prompts" {
  type    = bool
  default = false
}

variable "otel_collector_image" {
  type    = string
  default = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
}

variable "garrison_image" {
  type        = string
  description = "Docker image for Agent Garrison gaming interface and control deck"
  default     = ""
}
variable "console_image" {
  type        = string
  description = "Docker image for Factory Dashboard 2D UI"
  default     = ""
}

variable "ledger_recover_seq" {
  description = "LG2: set only for the deploy that archives a failed ledger; must equal the failing seq the control plane reports."
  type        = string
  default     = ""
}

variable "ledger_recover_reason" {
  description = "LG2: why the ledger is being archived (recorded with the new segment). Required with ledger_recover_seq."
  type        = string
  default     = ""
}

variable "factory_public_base_url" {
  description = "Public origin of the factory for browser flows (Keymaster OAuth consent and callbacks, §6.11), e.g. https://factory.example.com. Register <this>/api/v1/connections/google/callback as a redirect URI on the Google OAuth client. Empty disables consent links."
  type        = string
  default     = ""
}

variable "default_model" {
  description = "The model an agent gets when its policy names none (DESIGN_AUTHORITY M2). Must be in model_catalog."
  type        = string
  default     = "claude-haiku-4-5"
}

variable "agent_source_token_hosts" {
  type        = list(string)
  default     = ["github.com"]
  description = "Hosts the agent source token may be sent to. Admission and skill-check builds, and the control plane's skill.yaml fetch, clone any other host without it, so a registration can never send the token elsewhere."
}

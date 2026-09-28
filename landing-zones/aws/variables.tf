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

variable "doorman_image" {
  type    = string
  default = ""
}

variable "gateway_image" {
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
  description = "Provider credentials the gateway injects (values set in Secrets Manager by an operator). Only the gateway can read them."
  type        = list(string)
  default     = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
}

variable "gateway_routes" {
  description = "JSON array of gateway routes. Google routes name a Keymaster `connection` (§6.11): the gateway injects the access token the control plane's Keymaster issues; no Google credential is configured here or held by agents."
  type        = string
  default     = "[{\"id\":\"anthropic\",\"kind\":\"llm\",\"provider\":\"anthropic\",\"upstream\":\"https://api.anthropic.com\",\"credential\":{\"secret\":\"ANTHROPIC_API_KEY\",\"header\":\"x-api-key\"}},{\"id\":\"openai\",\"kind\":\"llm\",\"provider\":\"openai\",\"upstream\":\"https://api.openai.com\",\"credential\":{\"secret\":\"OPENAI_API_KEY\",\"header\":\"authorization\",\"format\":\"Bearer {}\"}},{\"id\":\"discord\",\"kind\":\"http\",\"upstream\":\"https://discord.com/api/v10\",\"credential\":{\"secret\":\"{agent}_DISCORD_BOT_TOKEN\",\"header\":\"authorization\",\"format\":\"Bot {}\"}},{\"id\":\"google-calendar\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/calendar/v3\",\"connection\":\"google\"},{\"id\":\"google-oauth\",\"kind\":\"http\",\"upstream\":\"https://oauth2.googleapis.com\"},{\"id\":\"google-gmail\",\"kind\":\"http\",\"upstream\":\"https://gmail.googleapis.com\",\"connection\":\"google\"},{\"id\":\"google-drive\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/drive/v3\",\"connection\":\"google\"},{\"id\":\"google-drive-upload\",\"kind\":\"http\",\"upstream\":\"https://www.googleapis.com/upload/drive/v3\",\"connection\":\"google\"},{\"id\":\"google-health\",\"kind\":\"http\",\"upstream\":\"https://health.googleapis.com\",\"connection\":\"google\"},{\"id\":\"google-storage\",\"kind\":\"http\",\"upstream\":\"https://storage.googleapis.com\",\"connection\":\"google-service-account\",\"scopes\":[\"https://www.googleapis.com/auth/devstorage.read_write\"]},{\"id\":\"models\",\"kind\":\"models\"}]"
}

variable "gateway_prices" {
  description = "JSON object of model -> USD per million tokens. Unpriced models are refused."
  type        = string
  default     = "{}"
}

variable "model_catalog" {
  description = "Models the factory model API offers (§6.9 M3): neutral name -> provider adapter, provider model id, region, and USD per million tokens. Passed to the gateway as FACTORY_MODEL_CATALOG."
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
  }
}

variable "gateway_count" {
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

variable "ledger_retention_days" {
  type        = number
  default     = 365
  description = "COMPLIANCE-mode retention for ledger checkpoints. Cannot be shortened once objects are written."
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

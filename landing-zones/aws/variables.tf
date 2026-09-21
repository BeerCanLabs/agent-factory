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
  description = "JSON array of gateway routes."
  type        = string
  default     = "[{\"id\":\"anthropic\",\"kind\":\"llm\",\"provider\":\"anthropic\",\"upstream\":\"https://api.anthropic.com\",\"credential\":{\"secret\":\"ANTHROPIC_API_KEY\",\"header\":\"x-api-key\"}},{\"id\":\"openai\",\"kind\":\"llm\",\"provider\":\"openai\",\"upstream\":\"https://api.openai.com\",\"credential\":{\"secret\":\"OPENAI_API_KEY\",\"header\":\"authorization\",\"format\":\"Bearer {}\"}}]"
}

variable "gateway_prices" {
  description = "JSON object of model -> USD per million tokens. Unpriced models are refused."
  type        = string
  default     = "{}"
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

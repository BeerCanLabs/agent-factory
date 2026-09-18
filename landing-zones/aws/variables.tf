variable "account_id" {
  type        = string
  description = "BeerCanLabs AWS account id. Set by scripts/bcl-aws (TF_VAR_account_id); terraform refuses any other account."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id)) && !contains(["854882517534", "108327567228", "992163310528"], var.account_id)
    error_message = "account_id must be the 12-digit BeerCanLabs account, never a Frontline account."
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

variable "control_plane_image" {
  type        = string
  description = "ECR URI for factory-control-plane (set after first apply + push)"
  default     = ""
}

variable "doorman_image" {
  type    = string
  default = ""
}

variable "sidecar_image" {
  type    = string
  default = ""
}

variable "echo_worker_image" {
  type    = string
  default = ""
}

variable "oidc_issuer" {
  type    = string
  default = ""
}

variable "oidc_audience" {
  type    = string
  default = ""
}

variable "trace_prompts" {
  type    = bool
  default = false
}

variable "trace_ttl_seconds" {
  type    = number
  default = 86400
}

variable "ledger_retention_days" {
  type        = number
  default     = 365
  description = "COMPLIANCE-mode retention for ledger checkpoints. Cannot be shortened once objects are written."
}

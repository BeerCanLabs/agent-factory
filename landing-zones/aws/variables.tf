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

variable "factory_auth" {
  type    = string
  default = "bearer"
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

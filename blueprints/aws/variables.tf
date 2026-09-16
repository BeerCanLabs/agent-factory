variable "environment" {
  type        = string
  default     = "production"
  description = "Deployment environment"
}

variable "aws_region" {
  type        = string
  default     = "us-east-1"
}

variable "worker_image" {
  type        = string
  description = "OCI image for the agent worker"
}

variable "sidecar_image" {
  type        = string
  description = "OCI image for the factory sidecar"
}

variable "secret_arns" {
  type        = list(string)
  default     = []
  description = "Secrets Manager ARNs the task role may read (names from secrets.manifest.yaml)"
}

variable "factory_ledger_url" {
  type        = string
  description = "Factory control-plane ledger POST URL"
}

variable "agent_id" {
  type    = string
  default = "echo-agent"
}

variable "subnet_ids" {
  type        = list(string)
  description = "Private subnets for Fargate RunTask from zero"
}

variable "security_group_ids" {
  type        = list(string)
  default     = []
}

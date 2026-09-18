variable "project_id" {
  type        = string
  description = "GCP Project ID"
}

variable "region" {
  type        = string
  default     = "us-central1"
}

variable "worker_image" {
  type = string
}

variable "gateway_url" {
  type        = string
  description = "Internal URL of the fleet egress gateway (the only egress for agents)"
}

variable "secret_ids" {
  type        = list(string)
  default     = []
  description = "Secret Manager secret ids declared in secrets.manifest.yaml"
}

variable "factory_url" {
  type        = string
  description = "Control plane URL agents use for run input, results and heartbeats"
}

variable "agent_id" {
  type    = string
  default = "echo-agent"
}

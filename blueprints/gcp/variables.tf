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

variable "sidecar_image" {
  type = string
}

variable "secret_ids" {
  type        = list(string)
  default     = []
  description = "Secret Manager secret ids declared in secrets.manifest.yaml"
}

variable "factory_ledger_url" {
  type = string
}

variable "agent_id" {
  type    = string
  default = "echo-agent"
}

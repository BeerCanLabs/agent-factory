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
  type    = string
  default = "gcr.io/google-containers/pause:3.2" # Placeholder
}

variable "gateway_image" {
  type    = string
  default = "gcr.io/google-containers/pause:3.2"
}

variable "doorman_image" {
  type    = string
  default = "gcr.io/google-containers/pause:3.2"
}

variable "agents" {
  description = "Cartridges to run as Cloud Run Jobs. Each gets its own service account scoped to its mind prefix."
  type = map(object({
    image   = string
    secrets = optional(list(string), [])
  }))
  default = {}
}

variable "provider_secret_names" {
  description = "Provider credentials the gateway injects (values set in Secret Manager by Locksmith). Only the gateway can read them."
  type        = list(string)
  default     = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
}

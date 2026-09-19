terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # Partial config: scripts/aws-deploy.sh passes bucket/key/region from the bootstrap stack.
  backend "s3" {}
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { owner = "beercanlabs", system = "agent-factory", environment = var.environment }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name         = "factory-${var.environment}"
  azs          = slice(data.aws_availability_zones.available.names, 0, 2)
  images_ready = var.control_plane_image != "" && var.doorman_image != "" && var.gateway_image != ""
  ns           = "factory.internal"
  cp_url       = "http://control-plane.${local.ns}:8088"
  gateway_url  = "http://gateway.${local.ns}:8081"
  doorman_url  = "http://doorman.${local.ns}:8090"
  secret_arn   = "arn:aws:secretsmanager:${var.aws_region}:${var.account_id}:secret:factory/${var.environment}"
  agent_images = { for id, a in var.agents : id => a.image if a.image != "" }
}

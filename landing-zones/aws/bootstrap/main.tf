# One-time, per account: remote state for the landing zone and a keyless CI deploy role.
# Run through scripts/bcl-aws; its own state stays local (landing-zones/aws/bootstrap/terraform.tfstate, gitignored).
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id)) && !contains(["854882517534", "108327567228", "992163310528"], var.account_id)
    error_message = "account_id must be the 12-digit BeerCanLabs account, never a Frontline account."
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "github_repo" {
  type    = string
  default = "BeerCanLabs/agent-factory"
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { owner = "beercanlabs", system = "agent-factory", stack = "bootstrap" }
  }
}

resource "aws_s3_bucket" "state" {
  bucket = "agent-factory-tfstate-${var.account_id}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# GitHub Actions deploys with short-lived OIDC credentials. Only the main branch of this repo can assume it.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "factory-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

# Terraform manages IAM, networking, ECS, S3 and more, so the deploy role is broad. Its blast
# radius is limited by who can assume it (main branch only) and by living in a dedicated account.
resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

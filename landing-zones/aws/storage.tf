resource "aws_s3_bucket" "mind" {
  bucket        = "agent-factory-mind-${var.environment}-${random_id.suffix.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "mind" {
  bucket                  = aws_s3_bucket.mind.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "mind" {
  bucket = aws_s3_bucket.mind.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mind" {
  bucket = aws_s3_bucket.mind.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Write-once ledger copy. COMPLIANCE-mode Object Lock: no principal, including root, can delete or
# overwrite a checkpoint before its retention date. This bucket cannot be destroyed while locked.
resource "aws_s3_bucket" "ledger_worm" {
  bucket              = "agent-factory-ledger-${var.environment}-${random_id.suffix.hex}"
  object_lock_enabled = true
  force_destroy       = false
}

resource "aws_s3_bucket_versioning" "ledger_worm" {
  bucket = aws_s3_bucket.ledger_worm.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "ledger_worm" {
  bucket = aws_s3_bucket.ledger_worm.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.ledger_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.ledger_worm]
}

resource "aws_s3_bucket_public_access_block" "ledger_worm" {
  bucket                  = aws_s3_bucket.ledger_worm.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ledger_worm" {
  bucket = aws_s3_bucket.ledger_worm.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Hot ledger + runs + policies + approvals. One writer (control plane desired_count = 1).
resource "aws_efs_file_system" "ledger" {
  encrypted = true
  tags      = { Name = "${local.name}-ledger" }
}

resource "aws_efs_mount_target" "ledger" {
  count           = 2
  file_system_id  = aws_efs_file_system.ledger.id
  subnet_id       = aws_subnet.service[count.index].id
  security_groups = [aws_security_group.efs.id]
}

# The control plane image runs as uid 1000; the access point pins ownership so it can write.
resource "aws_efs_access_point" "ledger" {
  file_system_id = aws_efs_file_system.ledger.id
  posix_user {
    uid = 1000
    gid = 1000
  }
  root_directory {
    path = "/factory"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0750"
    }
  }
}

resource "aws_ecr_repository" "repo" {
  for_each             = toset(concat(["control-plane", "doorman", "gateway"], [for id in keys(var.agents) : "agent-${id}"]))
  name                 = "factory-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "factory" {
  name              = "/ecs/${local.name}"
  retention_in_days = 30
}

# Enterprise event bus: run outcomes and blocks, budget alerts, crashes, approval requests.
resource "aws_cloudwatch_event_bus" "factory" {
  name = local.name
}

resource "aws_ecr_repository" "dynamic_agents" {
  name                 = "factory-dynamic-agents"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

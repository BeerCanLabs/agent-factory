# AWS bind — pattern `orchestrated-tasks` only

Use this directory **only** if the SDP interview selected **orchestrated-tasks** and **AWS**. It is not the factory kernel. Azure/GCP/Compose use `PATTERNS.md`, not this Terraform.

Implements `landing-zones/CONTRACT.md` on a greenfield AWS account (ECS+ALB+S3+EFS).

Creates: VPC (public subnets), ALB, ECS cluster, Fargate **control plane** + **Doorman** services, S3 mind bucket, EFS ledger, Secrets Manager token, ECR repos, echo **task definition** (worker + sidecar) with **no** 24/7 service. Wake is `ecs RunTask` from the control plane (`FACTORY_RUNTIME=ecs`).

## Apply order

1. `terraform init && terraform apply -var="aws_region=us-east-1"` with empty image vars — creates ECR/VPC/IAM/S3/EFS.
2. Build and push:

```bash
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker build -f packages/control-plane/Dockerfile -t "$ECR_CP:0.1" .
docker build -f packages/doorman/Dockerfile -t "$ECR_DOORMAN:0.1" .
docker build -f sidecar/Dockerfile -t "$ECR_SIDECAR:0.1" .
docker build -f runtimes/generic/Dockerfile -t "$ECR_ECHO:0.1" .
# push each
```

3. `terraform apply` again with `control_plane_image`, `doorman_image`, `sidecar_image`, `echo_worker_image`.
4. Read `factory_token_secret_arn`; put cartridge secrets (`ECHO_WEBHOOK_SECRET`, …) in Secrets Manager.
5. Hit `control_plane_url/healthz`.

Do not create an ECS service for echo. Do not require a Discord app.

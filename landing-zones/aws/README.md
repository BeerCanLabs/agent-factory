# AWS bind — pattern `orchestrated-tasks` only

Use this directory **only** if the SDP interview selected **orchestrated-tasks** and **AWS**. It is not the factory kernel. Azure/GCP/Compose use `PATTERNS.md`, not this Terraform.

Implements `landing-zones/CONTRACT.md` on a greenfield AWS account (ECS+ALB+S3+EFS).

Creates: VPC (public subnets), ALB, ECS cluster, Fargate **control plane** + **Doorman** services, S3 mind bucket, EFS ledger, Secrets Manager token, ECR repos, echo **task definition** (worker + sidecar) with **no** 24/7 service. Wake is `ecs RunTask` from the control plane (`FACTORY_RUNTIME=ecs`).

## Credentials (BeerCanLabs account only)

This deploys to the **BeerCanLabs** AWS account, never an employer or shared account.

1. `~/.aws/beercanlabs/config` holds only the BeerCanLabs Identity Center profile:
   ```ini
   [profile beercanlabs-deploy]
   sso_start_url = <BeerCanLabs Identity Center start URL>
   sso_region = us-east-1
   sso_account_id = <BeerCanLabs account id>
   sso_role_name = FactoryAdmin
   region = us-east-1
   ```
2. `export BCL_AWS_ACCOUNT_ID=<id>` (uncomment in `.envrc`), then `AWS_CONFIG_FILE=~/.aws/beercanlabs/config aws sso login --profile beercanlabs-deploy`.
3. Every AWS-touching command goes through `scripts/bcl-aws`, which checks the account before anything runs:
   `scripts/bcl-aws terraform -chdir=landing-zones/aws plan`.
   The provider's `allowed_account_ids` makes terraform refuse any other account.

## Apply order

1. `scripts/bcl-aws terraform -chdir=landing-zones/aws init && scripts/bcl-aws terraform -chdir=landing-zones/aws apply` with empty image vars — creates ECR/VPC/IAM/S3/EFS.
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

# AWS landing zone (ECS Fargate, pattern `orchestrated-tasks`)

Deploys to the **BeerCanLabs** AWS account only. Every AWS-touching command goes through `scripts/bcl-aws`, which reads an isolated config (`~/.aws/beercanlabs/config`), refuses Frontline accounts, and checks the live account before anything runs. The provider's `allowed_account_ids` refuses any other account at plan time.

## What it builds

| Tier | Subnets | Route out | Runs |
|---|---|---|---|
| Service | public ×2 | IGW | ALB (HTTPS only, :80 redirects), control plane (1 task, the single ledger writer), gateway, Doorman |
| Agents | private ×2 | **none** — no NAT, no IGW | one Fargate task per run, started by the control plane |

- **Agents' reachable set** is the control plane (`control-plane.factory.internal:8088`), the gateway (`gateway.factory.internal:8081`), and VPC endpoints for ECR, S3 (mind bucket and ECR layers only), Secrets Manager and CloudWatch Logs. Endpoint policies admit only this account's principals, so the endpoints cannot be used to ship data to another account.
- **IAM:** each agent gets its own task role limited to `s3://<mind>/<agent-id>/*`. The control plane can `RunTask` only `factory-prod-agent-*` definitions in this cluster and is explicitly denied provider keys. Only the gateway role can read provider keys.
- **Ledger:** EFS (encrypted, uid-1000 access point) holds the hot chain. Checkpoints ship to an S3 bucket with **Object Lock in COMPLIANCE mode** (`ledger_retention_days`). The control plane deploys stop-before-start, so the chain never has two writers.
- **Metrics:** an ADOT collector next to the control plane and gateway turns OTLP into CloudWatch metrics.
- **Secrets:** Terraform generates every factory credential (one per caller→callee edge). Provider keys (`provider_secret_names`) are created empty for you to fill.

## What you do once

1. Create the BeerCanLabs AWS account (not a Frontline email) and enable IAM Identity Center with a `FactoryAdmin` permission set.
2. Create `~/.aws/beercanlabs/config`:
   ```ini
   [profile beercanlabs-deploy]
   sso_start_url = <BeerCanLabs Identity Center start URL>
   sso_region = us-east-1
   sso_account_id = <BeerCanLabs account id>
   sso_role_name = FactoryAdmin
   region = us-east-1
   ```
3. `AWS_CONFIG_FILE=~/.aws/beercanlabs/config aws sso login --profile beercanlabs-deploy`
4. A DNS name for the control plane and an ACM certificate for it in `us-east-1`.

## Deploy

```bash
export BCL_AWS_ACCOUNT_ID=<id> FACTORY_CERT_ARN=<acm arn> FACTORY_DOMAIN=<name on the cert>
./scripts/aws-deploy.sh
```

The script runs the bootstrap stack (state bucket, GitHub OIDC `factory-deploy` role), applies the landing zone, builds and pushes immutable images tagged with the commit, applies the services, and runs the definition-of-done checks:
- HTTP redirects to HTTPS, and unauthenticated calls get 401;
- an echo run completes from a private subnet with no NAT;
- the ledger verifies against its Object Lock checkpoints.

Point `FACTORY_DOMAIN` at `alb_dns_name` before the checks run.

After the first deploy, `.github/workflows/deploy.yml` (manual trigger, `main` only) does the same with OIDC credentials. Set repository variables `BCL_AWS_ACCOUNT_ID`, `FACTORY_CERT_ARN` and `FACTORY_DOMAIN`.

## Enable LLM egress for an agent

1. Put the key in Secrets Manager: `scripts/bcl-aws aws secretsmanager put-secret-value --secret-id factory/prod/ANTHROPIC_API_KEY --secret-string ...`
2. Set `gateway_prices` (USD per million tokens). Unpriced models are refused.
3. `PUT /api/v1/agents/<id>/policy {"routes":["anthropic"], "budgetUsd":{"perDay":5}}`, or run `factory-bench --apply` to set the model and budget from measured cost and quality.

## Cost notes

There are no NAT gateways. Fixed costs are the ALB, the four interface endpoints (billed hourly per AZ, two AZs), EFS, and the always-on control plane, gateway and Doorman tasks. Agents cost nothing while idle.

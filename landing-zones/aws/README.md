# AWS landing zone (ECS Fargate, pattern `orchestrated-tasks`)

This landing zone provisions the reference Agent Factory architecture on AWS ECS Fargate.

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

## Prerequisites

1. An AWS account with permissions to provision VPC, ECS, S3, Secrets Manager, and IAM roles.
2. An ACM TLS certificate and domain name for the control plane ALB in `us-east-1`.

## Provisioning

### 1. Bootstrap State & CI Deploy Role
```bash
cd landing-zones/aws/bootstrap
terraform init
terraform apply -var="account_id=<YOUR_AWS_ACCOUNT_ID>" -var="github_repo=<OWNER>/<OPS_REPO>"
```
Only the `main` branch of `github_repo` (your private deployment repo, not this public reference) can assume the deploy role.

### 2. Provision Landing Zone
```bash
cd landing-zones/aws
terraform init -reconfigure \
  -backend-config="bucket=<STATE_BUCKET>" \
  -backend-config="key=agent-factory/landing-zone.tfstate" \
  -backend-config="region=us-east-1"
terraform apply \
  -var="account_id=<YOUR_AWS_ACCOUNT_ID>" \
  -var="certificate_arn=<YOUR_ACM_CERT_ARN>"
```

## Enable LLM egress for an agent

1. Put the key in Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value --secret-id factory/prod/ANTHROPIC_API_KEY --secret-string ...
   ```
2. Set `gateway_prices` (USD per million tokens). Unpriced models are refused.
3. `PUT /api/v1/agents/<id>/policy {"routes":["anthropic"], "budgetUsd":{"perDay":5}}`, or run `factory-bench --apply` to set the model and budget from measured cost and quality.

## Factory model API (Bedrock)

Agents call models at `${FACTORY_MODEL_BASE_URL}/chat/completions` (OpenAI Chat Completions format). The gateway's `models` route translates each call to Bedrock Converse and signs it with the gateway task role, which is allowed `bedrock:InvokeModel` on foundation models and this account's inference profiles; agents hold no AWS credentials.

1. Set `model_catalog` to the models this factory offers (default: `claude-sonnet-4-5` and `claude-haiku-4-5` via US cross-region inference profiles). Enable model access for them in the Bedrock console.
2. `PUT /api/v1/agents/<id>/policy {"routes":["models"], "models":["claude-sonnet-4-5"], "budgetUsd":{"perDay":5}}`.

## Cost notes

There are no NAT gateways. Fixed costs are the ALB, the four interface endpoints (billed hourly per AZ, two AZs), EFS, and the always-on control plane, gateway and Doorman tasks. Agents cost nothing while idle.

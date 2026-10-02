# AWS landing zone (ECS Fargate, pattern `orchestrated-tasks`)

This landing zone provisions the reference Agent Factory architecture on AWS ECS Fargate.

## What it builds

| Tier | Subnets | Route out | Runs |
|---|---|---|---|
| Service | public ×2 | IGW | ALB (HTTPS only, :80 redirects), control plane (1 task, the single ledger writer), gatekeeper-egress, gatekeeper-ingress |
| Agents | private ×2 | **none** — no NAT, no IGW | one Fargate task per run, started by the control plane |

- **Agents' reachable set** is the control plane (`control-plane.factory.internal:8088`), the gatekeeper-egress (`gatekeeper-egress.factory.internal:8081`), and VPC endpoints for ECR, S3 (mind bucket and ECR layers only), Secrets Manager and CloudWatch Logs. Endpoint policies admit only this account's principals, so the endpoints cannot be used to ship data to another account.
- **IAM:** each agent gets its own task role limited to `s3://<mind>/<agent-id>/*`. The control plane can `RunTask` only `factory-prod-agent-*` definitions in this cluster and is explicitly denied provider keys. Only the gatekeeper-egress role can read provider keys.
- **Ledger:** EFS (encrypted, uid-1000 access point) holds the hot chain. Checkpoints ship to an S3 bucket with **Object Lock in COMPLIANCE mode** (`ledger_retention_days`). The control plane deploys stop-before-start, so the chain never has two writers.
- **Metrics:** an ADOT collector next to the control plane and gatekeeper-egress turns OTLP into CloudWatch metrics.
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
2. Set `gatekeeper_egress_prices` (USD per million tokens). Unpriced models are refused.
3. `PUT /api/v1/agents/<id>/policy {"routes":["anthropic"], "budgetUsd":{"perDay":5}}`, or run `factory-bench --apply` to set the model and budget from measured cost and quality.

## Factory model API (Bedrock)

Agents call models at `${FACTORY_MODEL_BASE_URL}/chat/completions` (OpenAI Chat Completions format). The gatekeeper-egress's `models` route translates each call to Bedrock Converse and signs it with the gatekeeper-egress task role, which is allowed `bedrock:InvokeModel` on foundation models and this account's inference profiles; agents hold no AWS credentials.

1. Model offerings are factory data maintained in the factory (M3; baseline: `claude-sonnet-4-5` and `claude-haiku-4-5` via US cross-region inference profiles). Enable model access for them in the Bedrock console.
2. `PUT /api/v1/agents/<id>/policy {"routes":["models"], "models":["claude-sonnet-4-5"], "budgetUsd":{"perDay":5}}`.

## Operator identity (Cloudflare Access)

The control plane takes a person's identity only from the Access assertion it verifies itself (Design Authority §6.12 A2): an RS256 JWT in `cf-access-jwt-assertion` or the `CF_Authorization` cookie, checked against `https://<access_team_domain>/cdn-cgi/access/certs`, issuer `https://<access_team_domain>`, and `access_aud`. The `cf-access-authenticated-user-email` header grants nothing. The dashboard adds no token; it forwards each caller's assertion.

- `access_team_domain`, `access_aud`: both empty (default) disables Access identity, so only factory tokens work and the dashboard cannot act for anyone. List every Access application that fronts the dashboard or the control plane in `access_aud` (comma-separated).
- `admin_emails`: verified emails that get the admin roles; every other verified user is a viewer. Empty: no admins through Access.
- Access service tokens authenticate as `cloudflare-service:<common name>` with no roles; machine callers also send a factory bearer token.

## Cost notes

There are no NAT gateways. Fixed costs are the ALB, the four interface endpoints (billed hourly per AZ, two AZs), EFS, and the always-on control plane, gatekeeper-egress and gatekeeper-ingress tasks. Agents cost nothing while idle.

# Lockout recovery (AWS console and back door)

Use this when people cannot sign in at the factory's front door and an operator can sign in to the **deployment's own AWS account**. It restores an admin grant in the stores the control plane already uses.

Dale decided on 2026-11-27 to drop front-door D-6 options A and B: a separate sealed recovery key, and an IAM-gated `/token` exchange. This procedure does not create, rotate, read, or print any key. Whether an existing sealed secret is removed later is a separate decision. Leave that secret alone.

The steps below are the reference AWS landing zone (`landing-zones/aws`). Another landing zone (GCP, Azure, Compose) is covered in [Other deployments](#5-other-deployments). This runbook was written from the code and Terraform in this repository. It was not rehearsed against a live account. Items that could not be checked that way are in [What this repository does not prove](#what-this-repository-does-not-prove).

## Rules for every command

- Sign in to the AWS account that runs this factory. Pass that account id into the recovery script. The script refuses a caller whose STS account does not match (`scripts/factory-recover.mjs`).
- Read secret **names** only. Do not call Secrets Manager `GetSecretValue`. Do not print a task's environment, and do not paste a task definition into a ticket or chat: the `environment` block carries the account id, and the `secrets` block is injected into the container.
- The recovery command is `node scripts/factory-recover.mjs` with `--account` and `--email` only. Do not add `--reseed-break-glass`. That flag is still on the script and is outside this procedure.
- Do not start a second control-plane process. The ledger has one writer (Design Authority LG1). The one-off task below replaces the container command so it runs the recovery script and then exits.

Set these once. `prod` and `us-east-1` are the landing-zone defaults (`variable "environment"` and `variable "aws_region"` in `landing-zones/aws/variables.tf`). Use the values this deployment was applied with.

```bash
export AWS_REGION="${AWS_REGION:-us-east-1}"
export FACTORY_ENV="${FACTORY_ENV:-prod}"
export ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export CLUSTER="factory-${FACTORY_ENV}"
```

`$ACCOUNT` is whatever account the current credentials are in. Do not copy an account id from a comment in `scripts/factory-recover.mjs`.

## 1. Lockout or outage

Judge the control plane from AWS, then interpret the public URL. The load balancer accepts connections only from the identity-aware proxy (`landing-zones/aws/alb.tf`, Design Authority A1). A timeout on the load balancer's own DNS name, from a laptop, is the expected direct-connect result. It does not by itself mean the factory is down.

In the AWS console, region `$AWS_REGION`:

| Look at | Where | Lockout (continue this runbook) | Outage (stop; this runbook does not restart the fleet) |
|---|---|---|---|
| ECS service `control-plane` | Cluster `$CLUSTER` | `runningCount` is 1 and matches `desiredCount` (the service sets `desired_count = 1`) | `runningCount` is 0, the service is `DRAINING`, or deployments are stuck |
| Target group `factory-${FACTORY_ENV}-cp` | EC2 → Target groups | Targets are `healthy`. The check is `GET /healthz` on port **8089** | No healthy target |
| The other services on the same cluster | `gatekeeper-egress`, `gatekeeper-ingress`, and `console` / `garrison` when those images are set | Control plane healthy, and the complaint is sign-in | Several services at 0 running tasks |

CLI equivalents:

```bash
aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services control-plane gatekeeper-egress gatekeeper-ingress console garrison \
  --query '{services:services[].{name:serviceName,status:status,desired:desiredCount,running:runningCount},absent:failures[].reason}'

TG=$(aws elbv2 describe-target-groups --region "$AWS_REGION" \
  --names "factory-${FACTORY_ENV}-cp" --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --region "$AWS_REGION" --target-group-arn "$TG" \
  --query 'TargetHealthDescriptions[].TargetHealth.State'
```

`console` and `garrison` exist only when their image variables are set (`landing-zones/aws/ecs.tf`). The reason `MISSING` in `absent` means that service was not deployed.

What the public site means, once the target group is healthy:

- A Cloudflare Access login wall, or an Access denial, is the identity proxy (`cloudflare_zero_trust_access_application.factory`, name `factory-<environment>-front-door`, only when Cloudflare is enabled in `landing-zones/aws/cloudflare.tf`). The factory process can still be up.
- `GET /healthz`, `GET /`, and `GET /api/v1/health` on the control plane return **401** `{ "error": "unauthorized" }` to an anonymous caller (`packages/control-plane/src/app.ts`). That 401 means the process answered. A signed-in caller receives `{ "status": "ok", "version", "uptime", "timestamp" }`.
- The private probe on port 8089 returns `{ "status": "ok" }` with no version (`createProbeServer` in the same file). Only the load balancer is meant to reach that port.
- HTTP 502, 503, or 504 from the public hostname, with an unhealthy target, is an outage.

The adopter guide used to describe health as `{"ok":true}`. The control plane does not return that body.

The default listener action forwards to the control-plane target group. A host-header rule sends the dashboard hostname to the `console` service, whose target group `factory-<environment>-console` probes `/healthz` on port **3001**. Check the control-plane target group even when the dashboard hostname is the thing people cannot open.

## 2. Find the factory in the account

Resource names come from `local.name = "factory-${var.environment}"` in `landing-zones/aws/main.tf`. Default tags on the AWS provider are `owner = beercanlabs`, `system = agent-factory`, and `environment = <environment>`. The `owner` value is the module default; section 5 says what that means for another account.

| Resource | Name |
|---|---|
| ECS cluster | `factory-<environment>` |
| ECS services | `control-plane`, `gatekeeper-egress`, `gatekeeper-ingress`, plus `console` and `garrison` when their images are set |
| Control-plane task family | `factory-<environment>-control-plane` |
| Load balancer | `factory-<environment>` |
| Control-plane target group | `factory-<environment>-cp` (port 8088; health check port 8089) |
| Log group | `/ecs/factory-<environment>` (stream prefix `control-plane`) |
| EFS file system | tag `Name = factory-<environment>-ledger` |
| Hot ledger and auth stores | EFS access point root `/factory`, mounted in the container at `/data`. Ledger file: `/data/ledger.jsonl` (`FACTORY_LEDGER_PATH`) |
| Configuration bucket | `agent-factory-config-<environment>-<suffix>` prefix `config/` (`FACTORY_CONFIG_STORE_URI`) |
| Mind bucket | `agent-factory-mind-<environment>-<suffix>` |
| Ledger checkpoint bucket | `agent-factory-ledger-<environment>-<suffix>` prefix `ledger/` (Object Lock) |
| Secrets Manager prefix | `factory/<environment>/` (`FACTORY_SECRETS_AWS_PREFIX`) |

Principals and grants are versioned JSON documents on that EFS volume. The landing zone's storage resources are the EFS file system and the S3 buckets in `landing-zones/aws/storage.tf`.

List secret names, and stop there:

```bash
aws secretsmanager list-secrets --region "$AWS_REGION" \
  --filters Key=name,Values="factory/${FACTORY_ENV}/" \
  --query 'SecretList[].Name' --output text
```

On the reference task definition the auth stores are **not** given `FACTORY_PRINCIPALS_STORE_URI`, `FACTORY_GRANTS_STORE_URI`, `FACTORY_KEYS_STORE_URI`, or `FACTORY_RECOVERY_OUTBOX_URI` (`landing-zones/aws/ecs.tf`). The control plane then uses directories under the ledger directory (`packages/control-plane/src/index.ts`):

- `/data/auth/principals`
- `/data/auth/grants`
- `/data/auth/keys`
- `/data/auth/recovery-outbox`

IdP configuration, when its URI is also unset, is `/data/auth/idp-config`. Confirm the running task definition before assuming that. Read the `environment` array only:

```bash
TD=$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services control-plane --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --region "$AWS_REGION" --task-definition "$TD" \
  --query 'taskDefinition.containerDefinitions[?name==`control-plane`].environment[?name==`FACTORY_PRINCIPALS_STORE_URI` || name==`FACTORY_GRANTS_STORE_URI` || name==`FACTORY_KEYS_STORE_URI` || name==`FACTORY_RECOVERY_OUTBOX_URI` || name==`FACTORY_LEDGER_PATH` || name==`FACTORY_SECRETS_AWS_PREFIX`]' \
  --output json
```

That query returns the store URIs, the ledger path, and the secrets prefix. It leaves out the rest of the environment, including the account id.

If those four `FACTORY_*_STORE_URI` variables are present, the one-off task must use the same values. If they are absent, use the `file://` paths in the next section. A deployment repo that wraps this module can set them; this repository's landing zone does not.

## 3. Restore an admin grant

The control-plane image contains `scripts/factory-recover.mjs` for a one-off task (`packages/control-plane/Dockerfile`). The script calls `recoverLockout` (`packages/control-plane/src/recover.ts`), which:

1. Finds or creates a principal for the email and writes an active fleet `admin` grant (`PrincipalStore` / `GrantStore` in `packages/bouncer/src/principals.ts` and `packages/bouncer/src/grants.ts`).
2. Appends a recovery-outbox event `LOCKOUT_RECOVERED:admin` with actor `service:recovery`.
3. Leaves the ledger to the running control plane. That process drains the outbox on startup and every 30 seconds, reloads the stores, and appends the ledger row (`drainRecoveryOutbox` in `recover.ts`, called from `packages/control-plane/src/index.ts`).

This works while the control plane is running, including when some other human admin grant already exists. `FACTORY_BOOTSTRAP_ADMIN` does not: it is ignored while any active human admin grant exists (`bootstrapAdmin` in the same file). Do not set it for this case.

ECS Exec is not part of the reference landing zone. No service sets `enable_execute_command`, and the control-plane task role in `landing-zones/aws/iam.tf` has no `ssmmessages` actions. The back door this image is built for is a one-off task that mounts the same EFS volume.

The caller needs permission to `ecs:RunTask` and `iam:PassRole` on the existing roles `factory-<environment>-exec` and `factory-<environment>-control-plane`. This runbook does not add a role or a policy.

```bash
TD=$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services control-plane --query 'services[0].taskDefinition' --output text)
NET=$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services control-plane --query 'services[0].networkConfiguration' --output json)
```

`$NET` is the `networkConfiguration` object the service already uses (service subnets, the control-plane security group, and `assignPublicIp`, which the reference service sets to true so the task can reach STS). Reuse it. The EFS mount targets are in those service subnets (`landing-zones/aws/storage.tf`).

`EMAIL` is a plain address (no quotes or spaces) for the person who should be an admin and who can already authenticate at the identity provider once the grant exists. The script lowercases it. It does not create an identity-provider user.

```bash
export EMAIL="person@example.com"
OVERRIDES=$(cat <<EOF
{
  "containerOverrides": [{
    "name": "control-plane",
    "command": ["node", "scripts/factory-recover.mjs", "--account", "${ACCOUNT}", "--email", "${EMAIL}"],
    "environment": [
      {"name": "FACTORY_PRINCIPALS_STORE_URI", "value": "file:///data/auth/principals"},
      {"name": "FACTORY_GRANTS_STORE_URI", "value": "file:///data/auth/grants"},
      {"name": "FACTORY_KEYS_STORE_URI", "value": "file:///data/auth/keys"},
      {"name": "FACTORY_RECOVERY_OUTBOX_URI", "value": "file:///data/auth/recovery-outbox"}
    ]
  }]
}
EOF
)
```

Replace the four `file://` values with the task definition's URIs when those variables are already set. ECS merges container `environment` overrides by name and replaces `command` (AWS ECS `RunTask` override behavior; not re-executed in this repository). In the console wizard, if the form replaces the whole environment list, keep the existing `environment` entries and add these four. Do not type secret values into that list, and do not copy the `secrets` block into `environment`.

```bash
aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --task-definition "$TD" --launch-type FARGATE \
  --network-configuration "$NET" \
  --overrides "$OVERRIDES" \
  --started-by "lockout-recovery" \
  --query 'tasks[0].taskArn' --output text
```

In the console the same action is: ECS → cluster `$CLUSTER` → task definition `factory-<environment>-control-plane` → **Run task**, launch type Fargate, the service's network settings, container `control-plane` command and environment as above.

Wait until the task stops. Exit code 0 and a log line `{"recovered":true,"adminId":"user:…"}` mean the stores were written. The JSON has no secret field when `--reseed-break-glass` is absent. The log group is `/ecs/factory-<environment>`. The stream name is `control-plane/control-plane/<task-id>`, where `<task-id>` is the last segment of the task ARN (`awslogs-stream-prefix`, then the container name, then the task id).

```bash
TASK_ARN="<task arn from run-task>"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN"
aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[?name==`control-plane`].{exit:exitCode,reason:reason}'
```

Within about 30 seconds the **running** control-plane service logs `applied N lockout recovery row(s)`. That line is the in-memory reload. If the service was down, this is an outage: start it by the normal deploy path. On startup it opens the stores from disk and drains the outbox. Do not clear the outage by running `node packages/control-plane/dist/index.js` in the one-off task.

Do not edit `/data/auth/*/current.json` by hand. `FileDocBackend` rejects a snapshot whose `sha256` does not match (`packages/bouncer/src/principals.ts`).

### If the person still cannot sign in

The grant is in the store, and the identity provider or the Access application is still refusing them. This repository has no out-of-band command that rewrites IdP configuration. Hand-editing `/data/auth/idp-config` breaks the snapshot hash. Read only these identity settings from the task definition environment:

```bash
aws ecs describe-task-definition --region "$AWS_REGION" --task-definition "$TD" \
  --query 'taskDefinition.containerDefinitions[?name==`control-plane`].environment[?name==`FACTORY_ACCESS_TEAM_DOMAIN` || name==`FACTORY_ACCESS_AUD` || name==`FACTORY_ADMIN_EMAILS` || name==`FACTORY_OIDC_ISSUER` || name==`FACTORY_OIDC_AUDIENCE`]' \
  --output json
```

Client secret values stay in Secrets Manager. When Cloudflare is enabled, the Access application name is `factory-<environment>-front-door`. Fixing that application is done in Cloudflare. The incident note records the one restored email, not this admin list and not any token.

## 4. Confirm and record

1. The one-off task exited 0 and logged `recovered: true` with an `adminId`.
2. The running control plane logged `applied N lockout recovery row(s)`.
3. The person signs in on the normal front door. `GET /api/v1/whoami` returns `principal` equal to that `adminId` and `roles` containing `admin` (`getWhoami` in `packages/control-plane/src/grants-routes.ts`).
4. `GET /api/v1/ledger?agent=control-plane&limit=20` (privilege `ledger.read`) includes a row with `type` `action`, `action` `LOCKOUT_RECOVERED:admin`, `actor` `service:recovery`, and `subject` set to that principal id. The drain writes this row. There is no separate ledger type to invent.

Incident note, in the place this deployment already records incidents: the time, the operator, the email, the `adminId`, the ECS task id, and that the outbox drain was observed. Omit secret values, task-definition documents, access keys, and the contents of `/data`.

## 5. Other deployments

Any AWS account that applied `landing-zones/aws` uses the same steps. Sign in to **that** account, set `FACTORY_ENV` and `AWS_REGION` to the values it applied, and let `aws sts get-caller-identity` supply `ACCOUNT`. Bucket names include a random suffix (`random_id.suffix` in `landing-zones/aws/main.tf`); find them by the `system=agent-factory` tag or the name prefix, not by copying another account's bucket.

The reference module's default provider tags include `owner = beercanlabs` (`landing-zones/aws/main.tf`). An adopter who did not change that tag will see it in their own account. It is not an instruction to use a BeerCanLabs account.

GCP, Azure, and Compose are not this procedure. The same recovery script accepts `s3://`, `gs://`, `gcs://`, or a filesystem path (`docBackendFromUri` in `packages/bouncer/src/principals.ts`), and it still requires the caller to pass an AWS account id and to pass `aws sts get-caller-identity`. A non-AWS deployment has no documented equivalent in this repository.

## What this repository does not prove

- These AWS CLI calls were not run against a live account, and ECS override merging was not re-tested here.
- An ops repository that wraps the module may set store URIs or a different `environment`. Read the running task definition.
- ECS Exec was not enabled, so a shell on the running task is not a step in this landing zone.
- No command here repairs a broken IdP document or a Cloudflare Access policy.
- `scripts/factory-recover.mjs` still contains a `--reseed-break-glass` flag and a sample account id in a comment. This procedure uses neither.

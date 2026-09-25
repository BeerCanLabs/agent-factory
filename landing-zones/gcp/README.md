# GCP Landing Zone — Agent Factory

Implements the native PaaS orchestrator pattern on Google Cloud Platform.
Equivalent in architecture to `landing-zones/aws/` but using GCP-native services.

## Service Mapping (AWS → GCP)

| AWS Service | GCP Service | Purpose |
|---|---|---|
| ECR (`dynamic_agents` repo) | **Artifact Registry** repository | Stores PaaS-built agent images |
| CodeBuild project | **Cloud Build** inline + Artifact Registry | Builds Docker images dynamically |
| ECS Fargate Task Definition | **Cloud Run Job** | Agent compute unit, scale to 0 |
| IAM Role (task + exec) | **Service Account** (single SA) | Per-agent zero-trust identity |
| Secrets Manager | **Secret Manager** | Runtime secrets |
| S3 (mind bucket) | **Cloud Storage** (mind bucket) | Agent working memory |
| S3 (ledger WORM, Object Lock) | **Cloud Storage** with retention policy | Immutable ledger checkpoints |
| ECS Cluster + ALB | **Cloud Run** Services | Control plane, gateway, doorman |
| EventBridge | Cloud Audit Logs / Pub/Sub | (Future) Event routing |

## Terraform Files

| File | Purpose |
|---|---|
| `main.tf` | Provider config, backend (GCS), API enablement |
| `variables.tf` | All input variables |
| `artifact_registry.tf` | Artifact Registry repo for dynamic agent images |
| `cloudbuild.tf` | Cloud Build SA + IAM + template trigger |
| `iam.tf` | Service Accounts for all components |
| `cloud_run.tf` | Cloud Run Services (CP, GW, DM) + Jobs (agents) |
| `storage.tf` | Mind + ledger WORM buckets |

## PaaS Deploy Flow

When a user hits `POST /api/v1/registry/agents/<id>/deploy` with `provider: "gcp"`:

1. **Provision SA** — `gcp/iam.ts` creates a dedicated Service Account scoped to the agent's mind prefix and required secrets.
2. **Cloud Build** — `gcp/cloudbuild.ts` submits an inline build to Cloud Build; it clones the Git repo, runs `docker build`, and pushes to Artifact Registry.
3. **Register Job** — `gcp/cloudrun.ts` creates a Cloud Run Job (idempotent) using the new image and the agent's SA.
4. **Wake** — The Cloud Run runtime invokes the Job on-demand when the agent is started.

## First Deploy

```bash
# 1. Bootstrap: create the Terraform state bucket
gcloud storage buckets create gs://your-project-tf-state --project=your-project

# 2. Init
terraform init \
  -backend-config="bucket=your-project-tf-state" \
  -backend-config="prefix=agent-factory"

# 3. Plan (images not set yet — services will be created when images are ready)
terraform plan -var="project_id=your-project"

# 4. Apply
terraform apply -var="project_id=your-project"
```

## Required APIs

Enabled automatically by `main.tf`:
- `run.googleapis.com`
- `cloudbuild.googleapis.com`
- `artifactregistry.googleapis.com`
- `secretmanager.googleapis.com`
- `storage.googleapis.com`
- `iam.googleapis.com`
- `logging.googleapis.com`

## Control Plane Environment Variables (set by Terraform outputs)

| Variable | Source | Purpose |
|---|---|---|
| `FACTORY_RUNTIME` | `"cloudrun"` | Runtime mode selector |
| `FACTORY_GCP_PROJECT` | `var.project_id` | GCP Project ID |
| `FACTORY_GCP_REGION` | `var.region` | GCP Region |
| `FACTORY_ARTIFACT_REGISTRY` | AR repo URI | Image push/pull target |
| `FACTORY_CLOUDBUILD_TRIGGER` | trigger ID | Reference for Cloud Build |
| `FACTORY_GCP_JOBS` | comma-map | Static agent-id:job-name map |
| `MEMORY_STORE_URI` | GCS URI | Agent mind bucket URI |
| `FACTORY_LEDGER_WORM_URI` | GCS URI | Ledger WORM checkpoint URI |

## Secrets (Set in Secret Manager before first apply)

```
factory-token               # Control plane bearer token
factory-run-token-key       # JWT signing key for run tokens
factory-callback-signing-key # Callback HMAC key
doorman-token               # Doorman ↔ Control plane token
doorman-operator-token      # Doorman operator token
factory-tokens              # Multi-token map
gateway-token               # Gateway bearer token
```

> [!NOTE]
> Doorman deploys **sleeping** — no Discord bot token is required at `terraform apply`. Add `DISCORD_BOT_TOKEN` to Secret Manager and set `discord_secret_name` variable to go live.

## Zero-Trust Network Perimeter & Egress Architecture

Equivalent to the AWS security boundary, GCP isolates agent cartridges from direct internet access:
- **`factory-vpc` Network:** Configured with two distinct subnets:
  - `services` (`10.0.1.0/24`): Hosts Control Plane, Gateway, and Doorman with Cloud NAT enabled for outbound provider communication.
  - `agents` (`10.0.2.0/24`): Hosts all cartridge Cloud Run Jobs with **Zero Cloud NAT** and `egress = "ALL_TRAFFIC"`.
- **Egress Dropped at Perimeter:** Cartridge containers cannot reach `0.0.0.0/0` directly; any raw outbound connection to public internet is dropped by GCP routing.
- **Base URL Reverse Proxy & Credential Injection:**
  The Factory Gateway sits in the `services` subnet and acts as an internal HTTP reverse proxy (`INGRESS_TRAFFIC_INTERNAL_ONLY`).
  Agent jobs receive environment variables pointing to the Gateway:
  - `DISCORD_BASE_URL` (`https://<gateway-internal-uri>/discord`)
  - `OPENAI_BASE_URL` (`https://<gateway-internal-uri>/v1`)
  - `ANTHROPIC_BASE_URL` (`https://<gateway-internal-uri>/anthropic`)
  Agents authenticate requests to the Gateway using short-lived `FACTORY_RUN_TOKEN`. The Gateway validates policy, strips the run token, resolves `{agent}_DISCORD_BOT_TOKEN` or provider API keys from Secret Manager, and forwards to the upstream service.

## Zero-Trust IAM Model

- **Control plane SA**: can invoke/admin Cloud Run Jobs, trigger Cloud Build, create SAs, read factory secrets.
- **Gateway SA**: reads ONLY provider API-key secrets (Anthropic, OpenAI, etc.) and Discord bot tokens (`DISCORD_BOT_TOKEN`). Cannot read factory tokens.
- **Doorman SA**: reads ONLY the Discord bot token secret (conditional on `discord_secret_name`).
- **Agent SAs** (one per agent): reads/writes ONLY their own `<agentId>/` prefix in the mind bucket. Reads only their declared `requires` secrets.

## Registering a GCP Agent via API

```bash
# Register
curl -X POST https://your-cp-url/api/v1/registry/agents \
  -H "Authorization: Bearer $FACTORY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "role": "Specialist",
    "repo": "https://github.com/org/my-agent",
    "secrets": ["MY_AGENT_API_KEY"],
    "provider": "gcp"
  }'

# Deploy (triggers Cloud Build → Artifact Registry → Cloud Run Job)
curl -X POST https://your-cp-url/api/v1/registry/agents/<agentId>/deploy \
  -H "Authorization: Bearer $FACTORY_TOKEN"
```

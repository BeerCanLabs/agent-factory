# GCP Agent Container Build Strategy

## Objective
Implement the same native PaaS model as the AWS implementation but using GCP-native services.

## Architecture Flow

1. **API Invocation:** `POST /api/v1/registry/agents/<id>/deploy` with a GitHub repository URL.
2. **Provision IAM:** The control plane calls `provisionAgentServiceAccount()` (gcp/iam.ts) to create a dedicated Service Account scoped to the agent's mind prefix and required secrets.
3. **Trigger Build:** The control plane calls `buildAgentImage()` (gcp/cloudbuild.ts) which uses the Cloud Build API to clone the repo, run `docker build`, and push to Artifact Registry.
4. **Register Job:** On build success, the control plane calls `registerAgentJob()` (gcp/cloudrun.ts) to create or update a Cloud Run Job that the runtime can invoke on-demand.
5. **Wake:** When the agent is later started via `POST /api/v1/agents/<id>/wake`, the Cloud Run runtime invokes the Job.

## Service Mapping (AWS → GCP)

| AWS | GCP |
|-----|-----|
| ECR (dynamic_agents repo) | Artifact Registry repository |
| CodeBuild project | Cloud Build inline build + Artifact Registry |
| ECS Task Definition | Cloud Run Job |
| IAM Role (task + exec) | GCP Service Account (single SA per agent) |
| Secrets Manager ARNs | Secret Manager secret names |
| S3 (mind bucket) | Cloud Storage (mind bucket) |
| S3 (ledger WORM) | Cloud Storage with retention policy |

## Authentication

Cloud Build authenticates to Artifact Registry via the `cloudbuild` Service Account (provisioned by Terraform). No explicit docker login is required — ADC handles this automatically in Cloud Build.

The control plane uses Application Default Credentials (ADC) which are automatically injected by Cloud Run.

## Environment Variables

The control plane needs these env vars set (by Terraform output):
- `FACTORY_GCP_PROJECT` — GCP Project ID
- `FACTORY_GCP_REGION` — GCP Region (e.g., us-central1)
- `FACTORY_ARTIFACT_REGISTRY` — Full AR repo prefix (e.g., us-central1-docker.pkg.dev/my-project/factory-prod-agents)
- `FACTORY_CLOUDBUILD_TRIGGER` — Cloud Build trigger ID (for reference; builds are run inline)
- `MEMORY_STORE_URI` — GCS URI for the mind bucket
- `FACTORY_MIND_BUCKET` — Just the bucket name (for IAM binding)

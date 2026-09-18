# Three baseline patterns

The factory kernel does not choose a cloud. Draftsman (or any implementing AI) runs the interview in `AGENTS.md`, picks **one** pattern, then binds provider products to the slots in `.draft/sdp.yaml`.

| Slot (kernel) | Pattern 1 — Serverless containers | Pattern 2 — Orchestrated tasks | Pattern 3 — Compose host |
|---|---|---|---|
| RA | Serverless Event-Driven (`01KS8N4KR4-SVED`) | Containerized Microservices (`01KV0REFAR-CMSV`) | Same RA, single host |
| Ingress | Cloud Run URL / Azure ingress / Front Door / ALB | ALB / App Gateway / GCLB | Published ports |
| Mailbox (control plane + Doorman) | min=0 or 1 on the same platform | ECS/AKS/GKE **service** desired ≥ 1 | Compose services |
| Agent + sidecar | Revision/job min=0 | RunTask / Job / ACA Job — **no** 24/7 service | Process spawn |
| Mind | S3 / Blob / GCS | S3 / Blob / GCS | Volume |
| Ledger | Object or file on durable volume | EFS / Azure Files / Filestore / JSONL | Volume |
| Secrets | SM / Key Vault / GCP SM | same | gitignored file |

## Provider bind (interview, not code)

| Slot | Azure | AWS | GCP |
|---|---|---|---|
| Ingress | Front Door or Container Apps ingress | ALB / API Gateway | Cloud Run / HTTPS LB |
| Mailbox | Container Apps (or ACA + Functions) | ECS service / App Runner | Cloud Run |
| Agent job | ACA Job / Container Instances | ECS RunTask / Batch | Cloud Run job / GKE Job |
| Mind | Blob Storage | S3 | GCS |
| Ledger | Azure Files or Blob | EFS or S3 | Filestore or GCS |
| Secrets | Key Vault | Secrets Manager | Secret Manager |
| IdP | Entra | Cognito / Entra / Cloudflare | Google / Cloudflare |

`landing-zones/aws` is a **pattern 2 × AWS** example. It is not required to deploy the factory. Azure has no special-case kernel — bind the table and provision.

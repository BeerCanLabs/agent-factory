# Three baseline patterns

The factory kernel does not choose a cloud. Draftsman (or any implementing AI) runs the interview in `AGENTS.md`, picks **one** pattern, then binds provider products to the slots in `.draft/sdp.yaml`.

| Slot (kernel) | Pattern 1 — Serverless containers | Pattern 2 — Orchestrated tasks | Pattern 3 — Compose host |
|---|---|---|---|
| RA | Serverless Event-Driven (`01KS8N4KR4-SVED`) | Containerized Microservices (`01KV0REFAR-CMSV`) | Same RA, single host |
| Ingress | Cloud Run URL / Azure ingress / Front Door / ALB | ALB / App gatekeeper-egress / GCLB | Published ports |
| Mailbox (control plane + gatekeeper-ingress) | min=0 or 1 on the same platform | ECS/AKS/GKE **service** desired ≥ 1 | Compose services |
| Agent           | Revision/job min=0 | RunTask / Job / ACA Job — **no** 24/7 service | Process spawn |
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

## Canonical Service Traffic & Firewall Matrix

Every landing zone (whether AWS ECS, GCP Cloud Run, Azure Container Apps, or Docker Compose) must enforce the following traffic matrix across security groups, firewalls, and network interfaces.

### Inter-Service Network Ingress Matrix

| Source | Destination | Protocol / Port | Purpose & Contract | Required Rules |
|---|---|---|---|---|
| **External (Clients / IdP)** | Load Balancer / Ingress Proxy | TCP 443 (HTTPS) | Public ingress protected by Identity Provider (A1: Cloudflare Access / Entra / Google OIDC). Port 80 redirects to 443. | Allow `var.ingress_cidrs` only. Internet `0.0.0.0/0` is strictly forbidden. |
| **Load Balancer** | `control-plane` | TCP 8088 | Public API, MCP tools, webhooks, console API proxy. | Inbound from LB security group / internal network only. |
| **Load Balancer** | `console` / Garrison | TCP 3000 | Web UI management console. | Inbound from LB security group / internal network only. |
| **`control-plane`** | `control-plane` | TCP 8088 | Internal loopback (Console server proxy to Control Plane API). | Inbound from `control-plane`. |
| **`agents`** | `control-plane` | TCP 8088 | Run input prefetch, heartbeat, mailbox long-polling, run completion. | Inbound from `agents`. |
| **`gatekeeper-egress`** | `control-plane` | TCP 8088 | Run context verification, ledger sync, connection tokens, dynamic model catalog sync (`/api/v1/models/internal/catalog`). | Inbound from `gatekeeper-egress`. |
| **`gatekeeper-ingress`** | `control-plane` | TCP 8088 | Wake on incoming message (`POST /api/v1/agents/:id/wake`), conversation handoff. | Inbound from `gatekeeper-ingress`. |
| **`control-plane`** | `gatekeeper-ingress` | TCP 8090 | Live activity indicator heartbeat (`POST /api/v1/activity`), presence sync (`POST /api/v1/presence`). | Inbound from `control-plane`. |
| **`agents`** | `gatekeeper-egress` | TCP 8081 | Outbound model calls (E5: OpenAI Chat Completions), external tool calls with credential injection (E1–E4). | Inbound from `agents`. |
| **`control-plane`** | `gatekeeper-egress` | TCP 8081 | Model vendor discovery (`POST /internal/vendor-models`) without reading held keys (S1, K5, GAP-164). | Inbound from `control-plane`. |
| **`control-plane`** | Storage (EFS / NFS / GCS) | TCP 2049 / 443 | Single-writer WORM ledger volume mount (LG1). | Inbound from `control-plane`. |
| **Services / Agents** | Cloud VPC Endpoints | TCP 443 | AWS / GCP / Azure private APIs (ECR/Artifact Registry, Secrets Manager, S3/GCS, CloudWatch/Cloud Logging). | Inbound from VPC CIDR / subnets. |

### Outbound Perimeter Rules (Egress)

1. **`agents` Egress Perimeter (E1, E6):**
   - Direct internet egress (`0.0.0.0/0`) is **strictly forbidden**. Agent subnets must have no NAT Gateway and no route to an Internet Gateway.
   - Outbound traffic from `agents` is restricted to:
     - `control-plane:8088` (task coordination and mailbox)
     - `gatekeeper-egress:8081` (all external API and LLM traffic)
     - Cloud VPC endpoints (private storage and registry)
2. **Platform Services Egress (`control-plane`, `gatekeeper-egress`, `gatekeeper-ingress`):**
   - Permitted outbound to internet (`0.0.0.0/0`) on TCP 443 for external AI model providers, Discord gateway WebSockets, OAuth IdPs, and webhook callbacks.


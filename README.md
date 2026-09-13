# 🏭 BeerCanLabs Agent Factory

> **The Turnkey Infrastructure & Runtime Plumbing for Autonomous AI Agent Fleets.**  
> Native hosting blueprints for AWS (Bedrock / ECS) and GCP (Vertex AI / Cloud Run) with out-of-the-box compatibility with [Agent Garrison](https://github.com/BeerCanLabs/agent-garrison).

---

## 🎯 Architecture: Factory vs. Garrison (C2)

```
┌────────────────────────────────────────────────────────────────────────┐
│  AGENT GARRISON (C2 Deck & War Room)                                   │
│  - 3D Hex-Tile Forward Operating Base (FOB)                            │
│  - Spatial FinOps Burn Rate & Budget Kill-Switches                     │
│  - Multi-Cloud Fleet Readiness HUD & Container WebTTY                  │
│  - Enterprise Identity (Cloudflare Access / Entra ID) & Role Approvals  │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │
               WebSocket Telemetry & REST Control Plane
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│  AGENT FACTORY (Plumbing & Infrastructure Layer)                       │
│  - Cloud Hosting: AWS (Bedrock / ECS) & GCP (Vertex / Cloud Run)       │
│  - Container Orchestration, IAM Roles, VPC Peering & Secret Injection  │
│  - Embedded Garrison Sidecar (Heartbeats, Logs, C2 Command Intercept)  │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │
                    Runs Any Autonomous Agent Runtime
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│  AGENT RUNTIMES ("The Soldiers")                                       │
│  - Nous Research Hermes / Hermes Agent                                 │
│  - OpenClaw / OpenDevin                                                │
│  - LangGraph / CrewAI / AutoGen                                        │
│  - BeerCanLabs Skippy Matrix (`SM-archie`, `SM-donna`, `SM-finley`)    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Key Capabilities

1. **Opinionated Cloud Blueprints:**
   - **AWS Blueprint (`blueprints/aws/`):** Provisions Amazon ECS Fargate tasks or Bedrock AgentCore orchestrations with automated Garrison tagging (`garrison-agent=true`, `garrison-sector=sector-eng`), CloudWatch streaming, and least-privilege IAM roles.
   - **GCP Blueprint (`blueprints/gcp/`):** Provisions Google Cloud Run services or Vertex AI Agent Engine instances with Pub/Sub event streaming and Cloud Logging ingestion.
   - **Local Sandbox (`blueprints/docker/`):** Instant multi-container Docker Compose environment running Hermes and OpenClaw agents that connect directly to your local Agent Garrison instance.

2. **Universal Garrison Sidecar (`sidecar/`):**
   - Lightweight proxy container or process that attaches to any agent runtime.
   - Emits real-time heartbeats, resource usage (CPU/memory/TPM), and token costs to Garrison.
   - Streams container `stdout`/`stderr` into the Garrison WebTTY viewer.
   - Listens for tactical C2 commands: `PAUSE`, `RESUME`, `THROTTLE`, `ISOLATE` (quarantine), and remote shell `EXEC`.

3. **Pluggable Agent Runtimes (`runtimes/`):**
   - Native adapters and environment presets for **Hermes**, **OpenClaw**, and custom Python/Node agent scripts.

---

## 📁 Repository Structure

```
agent-factory/
├── blueprints/
│   ├── aws/                 # Terraform & CDK for AWS Bedrock / ECS Fargate
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── gcp/                 # Terraform for GCP Vertex AI / Cloud Run
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── docker/              # Local Docker Compose testing sandbox
│       ├── docker-compose.yml
│       └── .env.example
├── sidecar/                 # Garrison Telemetry & C2 Sidecar
│   ├── src/
│   │   ├── index.ts         # Main sidecar daemon
│   │   ├── collector.ts     # Process metrics & log scraper
│   │   └── client.ts        # Garrison WebSocket / REST client
│   ├── Dockerfile
│   └── package.json
├── runtimes/                # Runtime wrappers and entrypoints
│   ├── hermes/              # Nous Research Hermes Agent entrypoint
│   │   ├── Dockerfile
│   │   └── start.sh
│   └── openclaw/            # OpenClaw Agent entrypoint
│       ├── Dockerfile
│       └── start.sh
├── package.json
└── tsconfig.json
```

---

## ⚡ Quickstart (Local Docker Sandbox)

1. Ensure **Agent Garrison** is running at `http://localhost:3001`.
2. Start the local agent factory:
   ```bash
   cd blueprints/docker
   docker compose up -d
   ```
3. Open `http://localhost:5173` in Agent Garrison. Both **Hermes** and **OpenClaw** will auto-register on the 3D hex grid with real-time health checks, FinOps telemetry, and streaming logs.

---

## 🛡️ License
Apache-2.0 © BeerCanLabs

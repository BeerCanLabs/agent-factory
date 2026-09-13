# 🏭 BeerCanLabs Agent Factory — Architectural Specification

## 1. Overview & Separation of Concerns
The **Agent Factory** is the hosting, plumbing, optimization, and lifecycle infrastructure for autonomous AI agents. It is strictly decoupled from **Agent Garrison**, which serves as the 3D Command & Control (C2), spatial telemetry, and human-in-the-loop (HITL) approval deck.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  AGENT GARRISON (C2 Console & 3D Spatial Deck)                              │
│  - 3D Hex FOB: Operational Sectors + "The Training Gym / Guild Hall"        │
│  - Operator Approvals (Jira, Slack, Garrison HUD)                           │
│  - FinOps Cost Visualizers & Enterprise RBAC (Entra ID, Cloudflare Access)  │
└──────────────────────────────────────▲──────────────────────────────────────┘
                                       │ WebSocket Highway & REST Telemetry
┌──────────────────────────────────────┴──────────────────────────────────────┐
│  AGENT FACTORY (Infrastructure, Identity & Lifecycle Plumbing)              │
│  ├── 1. The Doorman: Scale-to-zero wake daemon (Discord/Slack/Queue leases) │
│  ├── 2. Cloud OAuth Broker: Central redirect URI & user delegation (OBO)    │
│  ├── 3. MCP Tool Gateway: Zero-trust tool broker & API credential vault     │
│  ├── 4. Optimization Engine (Gym): Multi-model cost-to-accuracy benchmark   │
│  └── 5. Persistent Memory Substrate: Survives restarts & session compaction │
└──────────────────────────────────────▲──────────────────────────────────────┘
                                       │ Hosts & Executes
┌──────────────────────────────────────┴──────────────────────────────────────┐
│  FOUNDATIONAL FACTORY AGENTS                                                │
│  ├── 1. FinOps Officer: Real-time token burn, budget caps & kill-switches    │
│  ├── 2. The Librarian: Skill definitions, system prompts & MCP catalogs     │
│  ├── 3. MedDoc: Agent runtime health diagnostics & crash post-mortems       │
│  ├── 4. Factory Mechanic: Cloud infrastructure & container pipeline triage  │
│  └── 5. Compliance Officer: Egress security, PII redaction & SOC2 audits     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. What the Factory Provides vs. What the Adopter Brings

### What the Factory Provides (The Substrate):
1. **Compute & Auto-Scaling:** Cloud Run, AWS ECS Fargate, or Kubernetes with scale-to-zero support.
2. **The Doorman:** Socket lease handover service for long-lived listener sockets (Discord/Slack/Queues) waking sleeping containers on-demand.
3. **Cloud OAuth Broker:** Centralized OAuth 2.0 PKCE callback handler (`https://factory.domain/oauth/callback`) storing encrypted tokens for headless cloud execution.
4. **Persistent Memory Substrate:** Managed vector database / relational state surviving container lifecycle restarts.
5. **Universal Garrison Sidecar:** Embedded agent daemon streaming heartbeats, CPU/memory/TPM metrics, container WebTTY stdout/stderr, and intercepting C2 tactical commands (pause/resume/isolate).

### What the Adopter Brings (The Agent Specification):
Adopting companies define an agent with 4 simple declarative files:
```
my-agent/
├── soul.md          # Identity, persona, tone, purpose, operating boundaries
├── skills.yaml      # Permitted tool bindings & MCP server endpoints
├── surface.yaml     # Ingress triggers (Slack channel, Discord DM, webhook, Garrison sortie)
└── identity.yaml    # Execution mode: Daemon (Service Principal) vs. On-Behalf-Of (User Delegation)
```

---

## 3. The Execution Identity Model: Daemon vs. On-Behalf-Of (OBO)
Headless cloud agents execute in one of two modes:
1. **Daemon Mode (Service Principal):**
   - The agent acts as an autonomous service account (e.g. `finops-officer@factory.iam`).
   - Used for scheduled background audits, monitoring, and infrastructure tasks.
2. **On-Behalf-Of Mode (User Delegation):**
   - When triggered by a human (e.g. via Slack DM or Garrison sortie), the Factory injects the requesting user's scoped OAuth access token.
   - Allows the agent to read personal calendars, query private Jira boards, or submit Git PRs strictly within the delegating user's permissions.

---

## 4. The Model Optimization Engine ("The Training Gym")
Every agent is designed to accomplish a specific capability contract. The Factory includes an automated evaluation harness:
1. **Benchmark Suite:** Runs the agent against representative test scenarios with defined assertions.
2. **Multi-Model Evaluation Matrix:** Sweeps the agent across candidate models (e.g. Claude 3.7 Sonnet -> Claude 3.5 Haiku -> Gemini 2.0 Flash -> Hermes 3 8B -> DeepSeek R1).
3. **Cost-to-Accuracy Optimization:** Finds the cheapest model that achieves $\ge 98\%$ task pass rate.
4. **Graduation to Garrison FOB:**
   - In **Agent Garrison**, the agent resides in **"The Training Gym"** hex tile during evaluation.
   - Once optimized, the agent graduates with a verified cost-efficiency rating and deploys to production sector tiles.

---

## 5. The 5 Foundational Factory Agents (Customizable Personas)
All 5 pre-built agents ship with standard capability contracts and customizable persona/prompt overlays:

| Agent Identifier | Default Role | Core Mandate | Primary Tools |
| :--- | :--- | :--- | :--- |
| `finops-officer` | FinOps Officer | Monitors token burn rates against monthly limits; triggers kill-switches | Cloud billing APIs, Garrison FinOps stream |
| `librarian` | The Librarian | Curates skills, system documentation, and MCP server registries | Vector search, schema validator, git repos |
| `med-doc` | MedDoc | Triage container crashes, OOMs, and tool execution failures | Container logs, memory profiler, stack trace parser |
| `factory-mechanic` | Factory Mechanic | Cloud infrastructure health, scaling issues, and CI/CD pipelines | Docker, Terraform, Cloud Run/ECS APIs |
| `compliance-officer` | Compliance Officer | Egress security, data loss prevention (DLP), PII redaction, SOC2 audit trails | Audit logs, regex DLP filters, IAM policies |

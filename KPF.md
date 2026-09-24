# Key Product Flows (KPF) — Agent Factory

Source of truth for factory-owned flows. Canonical architecture: [POSITION_PAPER.md](./POSITION_PAPER.md). Overlay UX (Garrison, web, CLI) is a client of these flows, not a participant inside them.

---

## Core Functional Pillars & UI Binding Interfaces

The Factory provides distinct functional domains. External UIs (like Garrison) bind to these capabilities using strictly defined interfaces, ensuring the infrastructure remains completely decoupled from the frontend experience.

### 1. Agent Registry Service (Factory-Driven Deployment & Governance)
- **Description:** Cartridges (Agents) must not live inside the Factory repository. Each agent lives in its own standalone repository (e.g., `github.com/dalesackrider/SM-rosie`). The Factory itself is the deployment engine, taking over from standard CI/CD. The deployment lifecycle is a strict state machine, governed by Role-Based Access Control (RBAC). **Every state transition is appended to the Immutable Ledger, cryptographically recording the authenticated OIDC identity of the user who performed the action.**
  1. **Registration (RBAC: `Factory.Registrar`):** An authenticated operator submits the agent manifest. The Factory pulls the definition, validates that the source repo is accessible, and verifies that the agent's declared secrets already exist in the Bring-Your-Own Secrets Manager (BYO-SM).
  2. **Validation:** If the secrets are missing or the code violates Factory constraints, the registration is rejected. If it passes, the agent enters a `PENDING_BUDGET` state.
  3. **Policy Engine Evaluation (Budget):** To prevent FinOps admins from becoming a manual deployment bottleneck, the Factory executes an automated Policy Engine. Authorized `Factory.FinOps` users pre-define organizational constraints (e.g., "Default budget of $10/day for all new agents" or "Shared circuit-breaker for the Engineering Department"). When an agent is registered, the Policy Engine evaluates it. If it complies, it automatically transitions to the `PENDING_DEPLOY` state. Exceptions require a manual RBAC override.
  4. **Deployment (RBAC: `Factory.Deployer`):** An authorized user explicitly triggers the deployment. The Factory Control Plane transitions the agent to `DEPLOYING` and natively orchestrates the cloud provider (e.g., dynamically provisioning the ECS Task Definition and strict IAM Task Role in AWS) to push the agent into production (`SLEEPING`).
  5. **Retirement & Decommissioning (RBAC: `Factory.Deployer` / `Factory.Admin`):** When an agent reaches end-of-life, the Factory executes a two-stage retirement workflow designed to prevent accidental data destruction while guaranteeing zero ongoing cloud costs:
     - **Stage 1 (Soft-Retire / "Scream Test"):** Triggering retirement immediately disables all ingress triggers, Doorman presence, and compute wakeups, dropping active compute and egress costs to $0. The agent enters `RETIRED_PENDING_PURGE` for a configurable holding period (default: 1 calendar week). Secrets and persistent memory remain preserved in case of accidental retirement. If an operator invokes reinstatement during this window, the agent returns to `SLEEPING`.
     - **Stage 2 (Permanent Purge & Archival):** Once the scream-test holding period expires (or upon explicit administrative purge), the Factory destroys cloud task definitions, revokes and purges the agent's secrets from the vault, and compresses/archives persistent mind storage to cold archive. The cryptographic execution ledger history remains immutable forever.
- **Interface (REST API):**
  - `POST /api/v1/registry/agents` (Registers and validates the new Cartridge)
  - `PUT /api/v1/registry/agents/:id/budget` (FinOps user assigns the budget)
  - `POST /api/v1/registry/agents/:id/deploy` (Authorized action that triggers cloud provisioning)
  - `POST /api/v1/registry/agents/:id/retire` (Transitions agent to `RETIRED_PENDING_PURGE`; cuts compute and triggers)
  - `POST /api/v1/registry/agents/:id/reinstate` (Aborts retirement during holding period; returns agent to active service)
  - `POST /api/v1/registry/agents/:id/purge` (Permanently destroys task definitions, purges vault secrets, archives mind)

### 2. Key Management (The "Locksmith")
- **Description:** A secure pathway for operators to inject credentials into the Enterprise's Bring-Your-Own Secrets Manager (BYO-SM) such as AWS Secrets Manager or HashiCorp Vault. The Factory *reads* these secrets at boot, but the Locksmith is the *write* path. 
- **Interface (CLI/SDK):** `factory-cli locksmith set <agent> <secret_name> <value>`. The UI/CLI communicates directly with the cloud provider's SDK to vault the secret.
- **Architectural Boundary:** The Factory Control Plane does not accept plaintext secrets over its REST API to prevent itself from becoming a vault or a high-value attack vector.

### 3. Cost Management & Policy Engine (FinOps & Kill-Switch)
- **Description:** Real-time visibility into token burn and automated governance. The Factory intercepts all egress traffic, prices tokens, and evaluates them against the Policy Engine's rules. If an agent (or an overarching departmental budget) hits its circuit-breaker limit, the Factory automatically pauses egress.
- **Interface (REST API):** 
  - `GET /api/v1/gateway/runs/:runId` (UI pulls current spend)
  - `PUT /api/v1/policies/budget` (FinOps user sets organizational, departmental, or per-agent budget thresholds)
  - `POST /api/v1/agents/:id/pause` (UI manually triggers the kill-switch)

### 4. LLM & MCP Gateway (Unified Egress & Tool Governance)
- **Description:** The network proxy that intercepts all outbound traffic from the Cartridges. It strips the agent's run-token and injects the real API keys (OpenAI, Anthropic, etc.), meters the token consumption, and allows the Factory to transparently reroute or downgrade models. It also intercepts Model Context Protocol (MCP) tool calls, enforcing allowlists and parking unauthorized calls for human approval.
- **Interface (REST / WebSockets):**
  - `GET /api/v1/approvals?state=pending` (UI fetches held tool calls)
  - `POST /api/v1/approvals/:id` (UI approves or rejects the action)
  - `WebSocket /stream` (UI streams live tool execution logs directly to the user)

### 5. Doorman (Presence & Real-Time Routing)
- **Description:** The persistent, stateful connection manager. Because Agents scale to zero to save costs, they cannot hold WebSockets open. Doorman holds these connections (like Discord Gateway, Slack RTM, or Custom WebSockets) 24/7, manages the "Online/Offline" presence, and wakes the agent when an event occurs.
- **Interface (WebSockets / Webhooks):**
  - Custom UI frontends establish a WebSocket connection directly with Doorman.
  - Doorman uses an internal Webhook (`POST /wake`) to trigger the stateless Agent.

### 6. Triage Function (Unified Error Surface Area)
- **Description:** A unified, append-only ledger where all system faults converge. Whether an agent crashes from an Out-of-Memory error, lacks a secret during pre-flight, gets blocked by the LLM, or fails a DOM parsing task internally, the error is written here.
- **Interface (REST API / PubSub):**
  - `GET /api/v1/ledger` (UI pulls the immutable audit trail for debugging)
  - `Webhook (EventBridge/SQS)` (The Factory drops a crash event into a queue)
  - **Kernel Module (`packages/triage`):** The Factory's triage module consumes these infrastructure faults (like OOM crashes) and routes them to external observability dashboards or Slack webhooks for operators.

### 7. Quality Governance & Benchmarking (Definition of Good)
- **Description:** Objective measurement of agent quality against deterministic expectations. The Factory enforces a two-phase model:
  1. **Phase 1 (Offline Rubric Gating):** Every cartridge may declare a `bench.yaml` suite of deterministic test cases with concrete inputs and assertions (`equals`, `contains`, `matches`). The Factory can execute benchmark simulations across candidate LLMs to generate a Cost-vs-Quality Scorecard before production promotion. (Policy engine rules may require passing scores or allow administrative exception).
  2. **Phase 2 (Live Runtime Evaluation — Roadmap):** Continuous evaluation of live conversation and task traces (`FACTORY_TRACE_PROMPTS`) by designated evaluator cartridges.
- **Interface (CLI / REST API):** 
  - `POST /api/v1/agents/:id/runs` with `{ model: "pinned-model", trace: true }`. The UI forces the factory to run a pinned simulation and collect prompt traces for evaluation.
  - CLI: `factory-bench --cartridge <dir> --models a,b` runs cases, scores accuracy, measures cost from the ledger, and outputs recommended models.

### 8. Headless Observability & Telemetry Surface (Cost, Quantity, Quality)
- **Description:** The Factory operates strictly on a headless architecture. It does not format PDF reports, build email templates, or render dashboard charts—those are client/UX layer concerns. Instead, the Factory captures structured telemetry (Cost, Quantity of work, and Quality pass rates) as a native byproduct of execution and exposes them via clean, queryable APIs for scheduled or ad-hoc enterprise reporting.
- **Interface (REST & GraphQL APIs):**
  - **REST (Real-time snapshots & metrics):** `GET /api/v1/metrics`, `GET /metrics` for cluster/agent health and operational counters.
  - **GraphQL (Flexible Telemetry & Analytics):** `POST /graphql` provides an expressive query surface allowing reporting engines, dashboards (Garrison, BI tools), and automated crons to pull precisely filtered time-series data without over-fetching:
    - Multi-dimensional rollups across daily, weekly, or monthly cadences.
    - Cost breakdown by agent, model, department, and tool.
    - Throughput metrics (completed tasks, failed runs, warm-window durations).
    - Quality metrics (benchmark regression history and pass rates).

---

## Deferred flows (not kernel)

These remain documented so they are not reintroduced as silent kernel scope.

### D1. Multi-channel identity and real-time voice/robotics streaming
Voice transcript streaming and gesture clocks are overlay/runtime concerns, not factory kernel. Doorman can hold the connection, but the heavy lifting of streaming logic belongs in the Cartridge.

### D2. Shared skills catalog execution
The factory does not host a plug-and-play code library. MCP is for peripherals only.

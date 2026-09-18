# Position Paper: The Agent Factory Architecture

## Abstract
As the deployment of autonomous AI agents transitions from isolated experiments to enterprise fleets, the infrastructure hosting them must mature. This document outlines the guiding design principles for the **Agent Factory**: an open-source orchestration manifesto designed to securely build, host, govern, and observe autonomous agents. 

The core mission of the Factory is to achieve three enterprise mandates simultaneously, enabling enterprise-class guardrails at vibe-code speeds:
1. **Ease of Creation:** Radically accelerate the building of agentic workflows by standardizing skills and configurations.
2. **Protection from Risk:** Govern the ability of the agent to execute actions that could produce bad outcomes via strict network controls, credential injection, and action governance.
3. **Tracking on Value:** Provide immutable insight into the cost, quality, and quantity of the work the agent performs.

To achieve this, the Agent Factory is designed as a holistic ecosystem composed of Three Pillars: **The Assembly Line, The Execution Engine, and The Observability Plane**.

---

## 1. The Three Pillars of the Factory

### Pillar 1: The Assembly Line (Creation & Training)
The Factory provides the standards and blueprints for agent creation. Rather than forcing developers to write bespoke infrastructure code, the Assembly Line allows creators to compile approved dependencies into a standardized, portable artifact called a **Cartridge**. 

**Continuous Agent Optimization (Training)**
The Factory equips the ecosystem with a mandatory **Benchmark Harness** (`bench.yaml` is required in every cartridge), while its usage remains an optional business practice. "Training" in the Factory is not black-box fine-tuning; it is Automated Cost/Quality Benchmarking. The Harness automatically runs an agent's regression suite against multiple LLMs (e.g., Opus vs. Haiku). It outputs a Cost vs. Quality Matrix, allowing human administrators to define the FinOps policy before deployment.

**Skills & Systems of Record**
* **Build-Time Skills:** An agent's capabilities are standard open-source dependencies compiled into the Cartridge at build-time. The runtime Factory is unconcerned with these.
* **No Data Replication:** The agent's persistent memory is strictly an ephemeral scratchpad. The Factory forbids syncing massive enterprise datasets into agent memory. Agents must query Systems of Record live using injected secrets.

### Pillar 2: The Execution Engine (Governance & Risk)
The Execution Engine is the serverless runtime environment that powers the Cartridge. It enforces strict separation of concerns. The Cartridge holds the business logic; the Execution Engine holds the rules.

**Zero Trust Identity & RBAC**
In adherence with the "Zero Agent Logic" rule, agent developers never write authentication validators. The Factory is the universal Identity Gateway:
1. **Inbound AuthZ:** The Factory validates the caller's Enterprise Identity and RBAC roles before waking an agent.
2. **Outbound AuthZ:** The Factory issues short-lived, run-scoped tokens and per-agent cloud roles so they can securely access internal resources.
3. **Control Plane RBAC:** Factory administration (budgets, secrets, ledgers) is strictly gated by Enterprise RBAC.

**The Egress Gateway & Action Governance**
Agents are firewalled from directly accessing the internet. A single central, network-enforced egress gateway is the only route out. The Gateway handles:
* **Credential Injection:** The agent never holds provider keys. The gateway injects the real credentials into egress traffic.
* **Action Governance:** The gateway enforces an MCP tool allowlist. Actions requiring human approval are held until explicitly authorized for those exact arguments.
* **FinOps:** The gateway implements strict budget semantics. It checks the budget before each call (including unacknowledged spend) and settles it after. Overshoot is strictly bounded by one request. If exceeded, the Factory drops the connection and emits `BLOCKED_BUDGET_EXCEEDED`.

**Secrets & The Readiness Protocol**
The Factory favors federated identity (OAuth/OIDC) but supports legacy static keys through a strictly governed Control Plane API. Plaintext secrets must never be passed in conversational prompts. 
Instead, the Factory implements a **Readiness Loop**:
* **Pre-Flight:** Before boot, if a declared secret is missing from the Vault, the Factory aborts and emits `PRE_FLIGHT_MISSING_SECRET`.
* **Runtime:** If a token is rejected at runtime (401 Unauthorized), the Factory catches the failure, purges the cache, and emits `RUNTIME_AUTH_FAILURE`.

**Event-Driven Autonomy**
The Factory rejects holding open synchronous API connections for long-running reasoning. It mandates the **Asynchronous Request-Reply Pattern**. Triggers return an immediate acknowledgment (`HTTP 202`), the agent spins up from zero, does its work, and egresses results asynchronously.

### Pillar 3: The Observability Plane (Value & Insight)
Because autonomous agents operate without constant human supervision, the Factory provides a tamper-proof Observability Plane, strictly separating compliance data from ephemeral diagnostics.

**The Immutable Execution Ledger**
Every token spent, tool invoked, and system action taken is recorded in an append-only ledger for compliance and ROI tracking. 
* **Hash-Chained & WORM:** The ledger is hash-chained (tamper-evident locally) and continuously synced to Write-Once-Read-Many (WORM) storage (tamper-proof once checkpointed).
* **No Prompt Logging:** The ledger does *not* record conversational prompts, strictly recording execution metadata to prevent massive data spills.

**Health & Diagnostics (OpenTelemetry)**
Because health diagnostics (stack traces, memory metrics, crash loops) are high-volume and ephemeral, writing them to an immutable ledger causes massive database bloat. Instead, the Factory's runtime natively emits this data using the **OpenTelemetry (OTel)** standard, routing it to enterprise APMs (e.g., CloudWatch). If fatal thresholds are crossed, the Factory halts compute and emits a `BLOCKED_UNHEALTHY` state.

---

## 2. The Integration Contract (Headless by Design)
The Agent Factory is inherently headless. The Factory (not the agent itself) exposes standard integration patterns for all capabilities:

1. **REST APIs:** For Control Plane management (provisioning secrets, setting budgets, MCP tool management) and immediate status polling.
2. **WebSockets:** For persistent, bidirectional stateful communication (e.g., streaming events and ledger rows).
3. **Webhooks:** For asynchronous, point-to-point push notifications in and out.
4. **Queues & Event Buses:** SQS queues for inbound triggers and EventBridge for outbound event routing across an enterprise event bus.

External interfaces—whether they are standard web dashboards or messaging bots—act purely as privileged clients connecting to these surfaces. The user experience is strictly an overlay; it is never a structural dependency of the Factory.

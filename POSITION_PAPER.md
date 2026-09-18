# Position Paper: The Agent Factory Architecture

## Abstract
As the deployment of autonomous AI agents transitions from isolated experiments to enterprise fleets, the infrastructure hosting them must mature. This document outlines the guiding design principles for the **Agent Factory**: an open-source orchestration manifesto designed to securely build, host, govern, and observe autonomous agents. 

The core mission of the Factory is to achieve three enterprise mandates simultaneously, enabling **enterprise-class guardrails at vibe code speeds**:
1. **Ease of Creation:** Radically accelerate the building of agentic workflows by standardizing skills and configurations.
2. **Protection from Risk:** Govern the ability of the agent to execute actions that could produce bad outcomes via strict network and credential firewalls.
3. **Tracking on Value:** Provide absolute, immutable insight into the cost, quality, and quantity of the work the agent performs.

To achieve this, the Agent Factory is designed as a holistic ecosystem composed of Three Pillars: **The Assembly Line, The Execution Engine, and The Observability Plane**.

---

## 1. The Three Pillars of the Factory

### Pillar 1: The Assembly Line (Creation & Training)
The Factory provides the standards and blueprints for agent creation. Rather than forcing developers to write bespoke infrastructure code, the Assembly Line (often exposed via UX overlays or tools like DRAFT) allows creators to compile approved dependencies into a standardized, portable artifact called a **Cartridge**. 

**Continuous Agent Optimization (Training)**
The Factory equips the ecosystem with a mandatory **Benchmark Harness**, while its usage remains an optional business practice. "Training" in the Factory is not black-box fine-tuning; it is Automated Cost/Quality Benchmarking. The Harness automatically runs an agent's regression suite against multiple LLMs (e.g., Opus vs. Haiku). It outputs a Cost vs. Quality Matrix (e.g., 98% pass rate for $2,000/mo vs. 80% pass rate for $200/mo), allowing human administrators to define the FinOps policy before deployment.

**Skills & Systems of Record**
* **Build-Time Skills:** 90% of an agent's capabilities are standard open-source dependencies compiled into the Cartridge at build-time. The runtime Factory is unconcerned with these.
* **No Data Replication:** The agent's persistent memory is strictly an ephemeral scratchpad. The Factory forbids syncing massive enterprise datasets into agent memory. Agents must query Systems of Record live using injected secrets.

### Pillar 2: The Execution Engine (Governance & Risk)
The Execution Engine (The Console) is the serverless runtime environment that powers the Cartridge. It enforces strict separation of concerns. The Cartridge holds the business logic; the Console holds the rules.

**Zero Trust Identity & RBAC**
In adherence with the "Zero Agent Logic" rule, agent developers never write authentication validators. The Factory is the universal Identity Gateway:
1. **Inbound AuthZ:** The Factory validates the caller's Enterprise Identity (e.g., Entra ID) and RBAC roles before waking an agent.
2. **Outbound AuthZ:** The Factory issues short-lived Workload Identities to agents so they can securely access internal databases without hardcoded passwords.
3. **Control Plane RBAC:** Factory administration (budgets, secrets, ledgers) is strictly gated by Enterprise RBAC.

**FinOps: The Policy Engine & Egress Proxy**
Agents are firewalled from directly accessing paid LLMs. All outbound requests route through the Factory's Sidecar (Egress Proxy). The Proxy counts the tokens, calculates the exact cost, and checks the **Policy Engine**. If the admin-defined budget is exceeded, the Factory drops the connection and shifts the agent into a `BLOCKED_BUDGET_EXCEEDED` state.

**Secrets & The Readiness Protocol**
The Factory favors federated identity (OAuth/OIDC) but supports legacy static keys through a strictly governed Control Plane API. Plaintext secrets must never be passed in conversational prompts. 
Instead, the Factory implements a **Readiness Loop**:
* **Pre-Flight:** Before boot, if a declared secret is missing from the Vault, the Factory aborts and emits `PRE_FLIGHT_MISSING_SECRET`. UX overlays route this to provisioning workflows (e.g., The Librarian).
* **Runtime:** If a token is rejected at runtime (401 Unauthorized), the Factory catches the failure, purges the cache, and emits `RUNTIME_AUTH_FAILURE`. UX overlays route this to diagnostic workflows (e.g., The Infirmary).

**Event-Driven Autonomy**
The Factory rejects holding open synchronous API connections for long-running reasoning. It mandates the **Asynchronous Request-Reply Pattern**. Triggers return an immediate acknowledgment (`HTTP 202`), the agent spins up from zero, does its work, and egresses results asynchronously via Webhooks or Pub/Sub topics.

### Pillar 3: The Observability Plane (Value & Insight)
Because autonomous agents operate without constant human supervision, the Factory provides a tamper-proof Observability Plane, strictly separating compliance data from ephemeral diagnostics.

**The Immutable Execution Ledger**
Every token spent, tool invoked, and system action taken is recorded in an append-only, immutable ledger for SOC2 compliance and ROI tracking. 
* **Deterministic Secret Redaction:** The Factory sidecar automatically redacts injected secrets from both the ledger and the agent's egress traffic.
* **No Prompt Logging:** The ledger does *not* record conversational prompts, strictly recording execution metadata to prevent massive data spills.

**Health & Diagnostics (OpenTelemetry)**
Because health diagnostics (stack traces, memory metrics, crash loops) are high-volume and ephemeral, writing them to an immutable ledger causes massive database bloat. Instead, the Factory's Sidecar natively emits this data using the **OpenTelemetry (OTel)** standard, routing it to enterprise APMs (Datadog, Splunk). If fatal thresholds are crossed, the Factory halts compute and emits a `BLOCKED_UNHEALTHY` state.

---

## 2. The Integration Contract (Headless by Design)
The Agent Factory is inherently headless. It does not invent proprietary networking paradigms. Instead, it mandates that every agent exposes its capabilities through the four standard integration patterns:

1. **REST APIs:** For Control Plane management (provisioning secrets, setting budgets) and immediate status polling.
2. **WebSockets:** For persistent, bidirectional stateful communication.
3. **Webhooks:** For asynchronous, point-to-point push notifications when an agent finishes a long-running task.
4. **Pub/Sub:** For decoupled event routing across an enterprise event bus.

External interfaces—whether they are command-line tools or rich 3D gamification environments (like Agent Garrison)—act purely as privileged clients connecting to these four surfaces. The user experience is strictly an overlay; it is never a structural dependency of the Factory.

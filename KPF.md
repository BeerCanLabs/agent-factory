# Key Product Flows (KPF) — Agent Factory

Source of truth for factory-owned flows. Canonical architecture: [POSITION_PAPER.md](./POSITION_PAPER.md). Overlay UX (Garrison, web, CLI) is a client of these flows, not a participant inside them.

---

## Kernel flows

### 1. Declarative Agent Provisioning
- **Description:** An operator submits a cartridge (`soul.md`, `surface.yaml`, `secrets.manifest.yaml`, artifact pointer). The factory validates the contract and provisions serverless compute, memory storage, secret bindings, and triggers. No agent logic is copied into the factory.
- **Entry points:** Cartridge directories, IaC modules, `factory validate`.
- **If it silently breaks:** Agents fail to deploy, crash-loop on missing bindings, or run with an incomplete contract.

### 2. Fast Cold-Start State Hydration
- **Description:** On wake, the entrypoint hydrates markdown/db snapshots from object storage into ephemeral disk and replicates back out. The agent must assume local disk will be destroyed.
- **Entry points:** Runtime entrypoints, hydration config on the cartridge.
- **If it silently breaks:** Amnesia on restart.

### 3. Event-Driven Wake (surface.yaml)
- **Description:** Cron, authenticated webhook, queue, or HTTP triggers scale an agent from zero, pass the event, and allow scale-back to zero.
- **Entry points:** Control-plane wake, cloud scheduler, ingress.
- **If it silently breaks:** Events dropped, or agents stay warm and burn idle compute.

### 4. Always Available, Not Always On
- **Description:** Idle agents use zero active compute. Wake is authenticated. After work, scale to zero.
- **Entry points:** Cloud scheduling, ingress, control-plane `POST /api/v1/agents/:id/wake`.
- **If it silently breaks:** Cron never fires, or instances run 24/7.

### 5. Zero Plaintext Secrets (binding, not storage)
- **Description:** Cartridges declare secret *names*. The factory binds values from the adopter’s BYO manager (Vault, AWS SM, GCP SM) at boot. The factory does not store secrets and is not a vault. MCP is not a credential store.
- **Entry points:** `secrets.manifest.yaml`, IaC bindings.
- **If it silently breaks:** Secrets in git, or boot with unbound names.

### 6. Injected Observability + Kill-Switch
- **Description:** The factory gateway intercepts LLM and MCP egress, counts tokens, records tool calls, and can pause / isolate / throttle by closing or rate-limiting the proxy. Agents do not emit custom spend telemetry.
- **Entry points:** Gateway proxy, control-plane pause/isolate.
- **If it silently breaks:** Unmetered spend, or kill-switch that fails to stop egress.

### 6b. Optional prompt traces (mind, not ledger)
- **Description:** Admins may enable `FACTORY_TRACE_PROMPTS` so the gateway stores secret-masked LLM request/response JSON under the agent’s hydrated mind, pruned by `FACTORY_TRACE_TTL_SECONDS`. Off by default. Deletable; not append-only audit.
- **If it silently breaks:** Operators cannot replay what was sent to the model; or traces retain secrets / never expire.

### 7. Immutable Execution Ledger
- **Description:** Every token, MCP invocation, and system action is appended to a factory-owned ledger with actor/authorization. Entries are metadata + payload hash only; the ledger masks bound secret strings before flush. Clients (Garrison, FinOps cartridge) query it. They do not own it.
- **Entry points:** Gateway/shim writer, `GET /api/v1/ledger`.
- **If it silently breaks:** No SOC2 trail, disputed spend, missing “who authorized this,” or an immutable PII/secret spill.

### 8. Authenticated Factory MCP + REST
- **Description:** External clients talk to the factory control plane over REST and MCP with OIDC/bearer auth. The gateway lists cartridges, wakes agents, applies kill-switch, and queries the ledger. It does not catalog a shared skill library or vault API keys.
- **Entry points:** Control-plane MCP server, `/api/v1/*`.
- **If it silently breaks:** Unauthenticated control, or clients scraping fake MCP JSON.

### 9. Crash and budget event routing
- **Description:** Worker non-zero exits / OOM become ledger events. If the MedDoc cartridge is installed, the factory wakes it. Budget anomalies are visible on the ledger for the FinOps cartridge. Remediation logic lives in those agents, not in factory modules.
- **Entry points:** Sidecar exit hooks, control-plane event routes.
- **If it silently breaks:** Crashes vanish; FinOps has nothing to read.

---

## Deferred flows (not kernel)

These remain documented so they are not reintroduced as silent kernel scope.

### D1. Multi-channel identity and real-time voice/robotics streaming
Voice transcript streaming and gesture clocks are overlay/runtime concerns, not factory kernel.

### D2. Autonomous capability triage bot
A factory bot that sweeps per-agent backlogs and a centralized skills catalog contradicts portable cartridges (skills live in the artifact).

### D3. Shared skills catalog execution
The factory does not host a plug-and-play code library. MCP is for peripherals only.

### D4. OAuth broker / Training Gym
Factory-stored OBO tokens and multi-model graduation are out of paper scope. Doorman is a kernel *module*: deployed idle, no Discord app at factory build; Gateway + offline/available presence when a Discord-surface cartridge binds a token.

## The Four Factory Interfaces (Action-to-Interface Mapping)

The Factory is a strictly headless infrastructure engine. External clients, UIs, and enterprise systems interact with the Factory's Kernel flows exclusively through four documented interfaces. This decoupled architecture guarantees that a UI designer can build robust UX (e.g., chat interfaces, debugging consoles, dashboard metrics) without ever modifying the Factory's internal code.

### 1. The Synchronous API (REST)
*Use for immediate, transactional commands and configuration.*
* **Declarative Provisioning (KPF 1):** `POST` a cartridge manifest to the registry.
* **Access & Lifecycle (KPF 4, 8):** `POST` to manually wake an agent; `PUT` to update authentication/RBAC.
* **Governance Command (KPF 6):** `POST` to toggle the Kill-Switch or close the egress proxy.
* **Ledger Query (KPF 7):** `GET` the immutable execution ledger for FinOps or auditing.

### 2. Webhooks
*Use for asynchronous handoffs and lifecycle state changes.*
* **Asynchronous Wake & Callback (KPF 3):** An external system triggers an agent via an authenticated POST to a webhook endpoint, allowing the agent to spin up, process, and POST the result back when complete.
* **Crash & Budget Routing (KPF 9):** The Factory alerts an external system (or an ITSM tool) when an agent hits a FinOps circuit breaker or exits with an OOM crash.

### 3. WebSockets
*Use for persistent, real-time bidirectional streaming between the Cartridge and a Client.*
* **Execution Streaming:** Bridging the active Cartridge execution (live token generation, human-in-the-loop approval requests) to a frontend UI.
* **Live Telemetry Taps (KPF 6b):** A developer connects to stream live prompt traces and egress logs from the Sidecar during active execution.

### 4. Events (Pub/Sub)
*Use for decoupled background triggers and immutable exhaust.*
* **Queue Triggers (KPF 3):** A background event (e.g., a database record is created) drops onto the queue to silently wake a Cartridge.
* **Ledger Exhaust (KPF 7):** The Factory drops continuous `Tokens_Burned` and `Tool_Executed` events onto the message broker for enterprise data lakes (like Datadog/Splunk) to ingest without blocking the Cartridge's execution loop.

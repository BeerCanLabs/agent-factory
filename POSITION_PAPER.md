# Position Paper: The Agent Factory Architecture

## Abstract
As the deployment of autonomous AI agents transitions from isolated experiments to enterprise fleets, the infrastructure hosting them must mature. This document outlines the guiding design principles for the **Agent Factory**: a universal, open-source orchestration model designed to securely host, scale, govern, and observe autonomous agents. 

The core philosophy of the Agent Factory is summarized by a strict architectural mandate: **The Factory is the universal console; the Agent is the portable cartridge.**

To achieve this, the architecture is strictly segmented into the Agent/Factory Contract, Core Functionality, Governance, Reporting, and a clean separation from gamified visualization overlays.

---

## 1. The Agent / Factory Contract
For an agent to be portable across different Factory environments, the Factory must have a rigid, opinionated definition of what an agent *is*. The Factory defines an agent as a standardized bundle containing:

1. **A Portable Compute Artifact:** A standardized execution package (e.g., an OCI container image, a serverless function, or a managed reasoning engine definition like Vertex AI / AWS Bedrock) capable of running the agent's logic.
2. **Declarative Configuration:** Metadata defining the agent's operating parameters (e.g., `soul.md` for persona/instructions, `surface.yaml` for ingress event triggers).
3. **A Secrets Manifest:** A declarative list of credential *variables* it requires (e.g., `Requires: API_KEY`), without any plaintext values.
4. **Standard I/O & Telemetry:** The artifact must emit its telemetry and logs via standardized streams or open observability protocols.

**The Contract:** If the Agent provides this bundle, the Factory promises to provision the compute, inject the required secrets at boot, route wake-events to the execution environment, and hydrate its memory. 

---

## 2. Functionality (The Engine)
The Factory provides the physical plumbing and compute optimization necessary to host fleets of agents at scale.

### Always Available, Not Always On
Autonomous agents possess intermittent burst workloads. To prevent runaway FinOps costs, the Factory architecture is strictly bound to serverless and on-demand execution. The Factory orchestration ensures agents consume zero active compute when idle. When an event occurs (e.g., a webhook or cron schedule), the Factory wakes the appropriate agent from zero instances, allows it to execute, and seamlessly scales it back to zero.

### Ephemeral Compute, Persistent Mind
Because the Factory enforces "Scale-to-Zero" compute, the agent's compute instance is entirely disposable. The agent must assume its local storage will be destroyed at any moment. The Factory provides a persistence substrate where all memories, databases, and session logs are continuously synced to remote object storage and instantly re-hydrated the exact millisecond the agent wakes up on a cold boot.

### Runtime Agnosticism (The Polyglot Factory)
The Factory remains entirely agnostic to the agent's internal framework. Whether an agent is written in Python (CrewAI), TypeScript (LangChain), runs inside a raw Docker container, or leverages a managed AI orchestrator (like Vertex AI Reasoning Engine), it makes no difference. The universal contract is defined by standardized APIs, input/output streams, and portable deployment artifacts, rather than proprietary framework lock-in.

### Skill Distribution: Dependencies vs. Peripherals
The Factory does not host a centralized library of agent code. 
- **Code Dependencies (Default):** 90% of shared skills (e.g., JSON parsing, math, web scraping) must be packaged as standard software libraries (`npm` / Python packages) bundled *within* the agent's compute artifact. This ensures execution is fast and the agent remains fully portable.
- **MCP Servers (Micro-Tools):** The Factory only exposes skills as external Model Context Protocol (MCP) servers when the skill is an *Environmental Peripheral* (e.g., a local LAN printer), unacceptably bloated (e.g., a 4GB headless browser), or requires centralized stateful security (e.g., a database connection pool).

---

## 3. Governance (Rules & Boundaries)
Governance ensures the Factory remains a secure, agnostic platform rather than a bloated monolith.

### The Cartridge & The Console (Zero Agent Logic)
If there is specific logic necessary for an agent to perform its duties, that logic *must* live with the agent. An agent must be perfectly portable. If a Factory contains agent-specific logic or proprietary standard libraries, it has violated this design principle. The Factory does not care *what* the agent is doing; it simply provides the electricity.

### Secret Binding, Not Secret Storage
An agent repository must never contain plaintext secrets, nor should the Factory attempt to act as a proprietary vault. The Agent is responsible only for declaring *what* it needs. The Factory is responsible for the *plumbing*—fetching the actual secret from the enterprise's preferred BYO secrets manager (e.g., HashiCorp Vault, AWS Secrets Manager) and dynamically injecting it at boot.

### Agentic Infrastructure Management (Decentralized Control Plane)
Instead of bloating the Factory's codebase with complex, hardcoded logic to enforce budgets or debug crashed execution environments, the Factory relies on a decentralized control plane. It delegates infrastructure management to specialized, standard agents (e.g., a *FinOps Agent*, a *MedDoc Agent*). If an instance crashes, the Factory routes the crash log to the MedDoc Agent to diagnose.

---

## 4. Reporting (Observability & Accountability)
Because autonomous agents operate without constant human supervision, the Factory must provide rigorous, tamper-proof reporting.

### Observability is Injected, Not Coded (The Sidecar Pattern)
An agent should never be burdened with writing custom code to report its budget usage or health telemetry. The Factory achieves observability by wrapping every agent in a universal "Sidecar" proxy or injecting telemetry endpoints. The agent simply executes its logic; the Factory sidecar intercepts the traffic, counts the tokens, streams logs, and acts as the emergency kill-switch.

### Immutable Accountability (The Execution Ledger)
While Observability answers *"What is the agent doing right now?"*, the Ledger answers *"What did the agent do yesterday, and who authorized it?"* Every token spent, every MCP tool invoked, and every system action taken by an agent is recorded in an append-only, immutable execution ledger provided by the Factory. This provides a non-repudiable audit trail required for SOC2 compliance, trust, and FinOps billing.

### Zero-Knowledge Logging & Deterministic Redaction
Because the Execution Ledger is immutable, accidentally recording Personally Identifiable Information (PII) or plaintext credentials creates a permanent, non-compliant data spill. To prevent this, the Factory enforces a zero-knowledge boundary before any data is flushed to disk:
- **Deterministic Secret Masking:** Because the Factory dynamically injects secrets at boot, the Sidecar knows their exact string values. It acts as an outbound firewall, automatically finding and redacting those secrets from all logs and ledger entries.
- **Metadata-First Ledgers:** The ledger strictly records execution *metadata* (e.g., actor ID, tool invoked, token cost, timestamp) and cryptographic *hashes* of the payloads, rather than raw text. This guarantees a verifiable audit trail without accumulating toxic, regulated data.

---

## 5. Headless by Design (UX as an Overlay)
The Agent Factory is inherently headless. It is designed to be API-first and MCP-first, meaning there is absolutely no User Experience (UX) or graphical interface hardcoded into the Factory's architecture. 

External interfaces—whether they are command-line developer tools (`claude code`, `codex`, `agy`), standard Web UIs, or rich 3D gamification environments (like Agent Garrison)—act purely as privileged clients. They consume the Factory's telemetry and issue standard REST, WebSocket, or MCP commands. 

If any UX layer is taken offline or replaced, the Agent Factory and its fleets of agents must continue to operate, scale, and report flawlessly. The user experience is strictly an overlay; it is never a structural dependency.

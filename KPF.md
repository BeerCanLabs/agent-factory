# Key Product Flows (KPF) — Agent Factory

This document is the single source of truth for user-facing flows and core capabilities supported by the Agent Factory orchestration framework. The focus is strictly on the infrastructure, orchestration, and capabilities of the factory itself, independent of any specific agent implementation or cloud provider.

---

## 1. Declarative Agent Provisioning
- **Description:** An operator defines a new agent or updates an existing one via configuration files. Applying the configuration automatically provisions the underlying serverless compute instance, dedicated persistent memory storage, identity bindings, and scheduled triggers. The flow abstracts away the underlying cloud infrastructure into a unified agent definition.
- **Entry points:** Infrastructure as Code (IaC) modules, agent configuration directories.
- **If it silently breaks:** Agents fail to deploy, crash loop due to missing bindings, or experience downtime.

---

## 2. Fast Cold-Start State Hydration & Anti-"50 First Dates" Persistence
- **Description:** When an agent instance spins up, the container entrypoint downloads the latest markdown memories and starts a replication process to restore and continuously replicate the internal databases to remote object storage with sub-second replication latency.
- **Entry points:** Container entrypoints, state replication configuration.
- **If it silently breaks:** Agents suffer amnesia on container restart, forgetting past user conversations, user preferences, or task progress.

---

## 3. Multi-Channel Identity & Real-Time Streaming
- **Description:** The factory allows agents to natively interface across multiple surfaces (chat apps, Web UI, voice). For voice and robotics, external clients send user transcript text to a streaming endpoint. The agent streams back structured chunks, enabling physical gestures during long-path cognition and real-time audio playback upon first token arrival.
- **Entry points:** Gateway routing, voice protocol endpoints.
- **If it silently breaks:** Robot gets stuck in a thinking hold, voice replies fail to stream, or integrations drop messages.

---

## 4. Event-Driven Agent Triggers
- **Description:** Agents dynamically react to asynchronous webhook events originating from external event engines (e.g., code repositories, monitoring logs, system alerts). The agent receives the webhook, verifies the signature, and autonomously executes the necessary remediation or operational task.
- **Entry points:** Webhook ingress controllers, event handler skills.
- **If it silently breaks:** Critical events are ignored, or agents fail to authenticate the incoming payload.

---

## 5. Always Available, Not Always On (Serverless Execution)
- **Description:** The factory orchestration ensures agents consume zero active compute when idle. The scheduler or an incoming event sends an authenticated request to wake the agent. The serverless instance wakes up from zero, executes the autonomous task, logs results to persistent memory, and seamlessly scales back down to zero.
- **Entry points:** Cloud scheduling modules, server ingress configurations.
- **If it silently breaks:** Scheduled routines do not run, or agents run continuously without scaling down, inflating compute costs.

---

## 6. Zero Plaintext Secrets Enforcement (Plug-and-Play)
- **Description:** No plaintext tokens, passwords, or local environment files are stored in version control. All credentials are fetched dynamically at runtime via a plug-and-play secrets management architecture (BYO-cloud secrets manager). The factory binds the required secrets securely to the agent's environment at boot.
- **Entry points:** IaC secret bindings, environment configuration.
- **If it silently breaks:** Secrets leak into repositories, or agents fail to boot due to missing permission grants on the secrets provider.

---

## 7. Autonomous Task & Capability Triage
- **Description:** When an agent encounters a limitation or receives a request outside its current capabilities, it automatically generates a structured task or feature request on its own designated backlog. A centralized factory orchestration bot is accountable for sweeping these backlogs and tracking capability gaps across the entire matrix.
- **Entry points:** Triage skills, factory catalog configurations.
- **If it silently breaks:** Agent limitations are lost, or feature requests produce unformatted issues that cannot be actioned by human operators.

---

## 8. Authenticated MCP Gateway
- **Description:** External client interfaces and peer agents communicate over an internet-exposed Model Context Protocol (MCP) gateway. The gateway acts as a strict zero-trust boundary enforcing secure OAuth/OIDC identity checks. The gateway lists factory agents, catalogs available skills, routes work to the owning agent, checks status, and enforces scope authorization without relying on static API keys.
- **Entry points:** OAuth server modules, MCP gateway routers.
- **If it silently breaks:** Unauthenticated or expired requests are admitted, unauthorized identities get in, or agents cannot securely delegate skills.

---

## 9. Extensible Capability Execution (Shared Skills Catalog)
- **Description:** Agents can securely invoke internal systems, third-party APIs, and external tooling via a shared, plug-and-play skills repository. The factory provides the mechanism for agents to access capabilities dynamically, without hardcoding specific tools into the core factory engine. The infrastructure simply facilitates the connection between the agent and the capability.
- **Entry points:** Centralized skills directory, agent capability manifests.
- **If it silently breaks:** Agents cannot utilize tools, execution requests fail with unclear errors, or agents execute unauthorized commands outside their scoped capabilities.

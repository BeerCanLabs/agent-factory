# Network Isolation, Perimeter Defense, and Egress Architecture

This document specifies the network topology, perimeter security model, and egress proxy architecture used by the **Agent Factory**.

It serves as the definitive reference for how the Factory enables zero-trust container network isolation while providing reliable, metered, and policy-governed outbound access for agent cartridges.

---

## 1. Architectural Philosophy: The Zero-Trust Perimeter

In enterprise environments, autonomous AI agents cannot be given direct, unfettered access to the public internet or internal networks. Giving arbitrary agent reasoning loops direct internet access presents severe security risks:
- **Secret exfiltration:** LLM prompt injection or malicious dependencies sending credentials to third-party endpoints.
- **Runaway spending:** Unmetered LLM API usage or runaway recursive tool calls draining cloud budgets.
- **Non-compliance:** Lack of an immutable audit trail showing exactly what external systems an agent contacted, when, and who authorized it.

To solve this, the Agent Factory enforces a **Zero-Trust Network Perimeter**:

```
 ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 │ VPC PRIVATE SUBNETS (No Internet Gateway route 0.0.0.0/0, No NAT Gateway, No Public IPs)      │
 │                                                                                               │
 │  ┌─────────────────────────────────┐                 ┌──────────────────────────────────────┐ │
 │  │        Agent Container          │                 │        Agent gatekeeper-egress          │ │
 │  │                                 │                 │                                      │ │
 │  │  - Standard SDKs                │                 │  - Validates FACTORY_RUN_TOKEN       │ │
 │  │  - Zero provider secrets        │ HTTP_PROXY      │  - Enforces route & host allowlists  │ │
 │  │  - Egress via gatekeeper-egress only      │ HTTPS CONNECT   │  - Strips run token, injects secrets │ │
 │  │    (Base URLs or Forward Proxy) ├────────────────►│  - Meters tokens & ledger audit      │ │
 │  │                                 │                 │  - Circuit-breaks on budget exceeded │ │
 │  └─────────────────────────────────┘                 └──────────────────┬───────────────────┘ │
 │                                                                         │                     │
 └─────────────────────────────────────────────────────────────────────────┼─────────────────────┘
                                                                           │ Routed via Egress NAT
                                                                           ▼
                                                             ┌───────────────────────────┐
                                                             │      PUBLIC INTERNET      │
                                                             │  - api.anthropic.com      │
                                                             │  - api.openai.com         │
                                                             │  - discord.com            │
                                                             │  - Third-party APIs       │
                                                             └───────────────────────────┘
```

1. **Agent Tasks Run in Isolated Subnets:** Agent task containers (e.g. AWS ECS Fargate, Kubernetes pods) are placed in private subnets with **no default route to an Internet Gateway (`0.0.0.0/0`)** and **no NAT Gateway attachment**.
2. **No Direct Ingress or Egress:** Agents have no public IP addresses and accept no inbound connections.
3. **The gatekeeper-egress is the Sole Conduit:** The only outbound TCP path permitted by network security groups is to the internal **gatekeeper-egress** (`http://factory-gatekeeper-egress:3001` or ECS service discovery `http://gatekeeper-egress.factory-prod.local:3001`).

---

## 2. Egress Mechanism: Dual Reverse & Forward Proxy

To allow standard third-party tools, language SDKs (Python `requests`, `httpx`, Node.js `fetch`, `axios`), and CLI tools (cURL, Git) to operate without code modifications, the gatekeeper-egress supports two complementary egress patterns:

### Pattern A: Reverse Proxy with Base URL Redirection

For well-known, high-volume APIs (such as LLM providers and core integrations), the Factory Shim (`packages/hydrate/src/gatekeeper-egress-env.ts`) injects standard Base URL environment variables into the agent container:

| Environment Variable | gatekeeper-egress Path Route | Upstream Target | Credential Injection |
|---|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://<gatekeeper-egress>/anthropic` | `https://api.anthropic.com` | `x-api-key: <ANTHROPIC_API_KEY>` |
| `OPENAI_BASE_URL` | `http://<gatekeeper-egress>/v1` | `https://api.openai.com/v1` | `Authorization: Bearer <OPENAI_API_KEY>` |
| `DISCORD_BASE_URL` | `http://<gatekeeper-egress>/discord` | `https://discord.com/api/v10` | `Authorization: Bot <*_DISCORD_BOT_TOKEN>` |

**How It Works:**
1. The agent's SDK is configured with `api_key=os.environ["FACTORY_RUN_TOKEN"]`.
2. The SDK sends requests to `${ANTHROPIC_BASE_URL}/v1/messages`.
3. The gatekeeper-egress validates that `anthropic` is in the agent's policy `routes`.
4. The gatekeeper-egress strips the ephemeral `FACTORY_RUN_TOKEN` from the headers.
5. The gatekeeper-egress fetches the real secret from Secrets Manager, injects `x-api-key: sk-ant-...`, streams the response from Anthropic, meters token consumption, writes a row to the immutable ledger, and returns the response to the agent.

### Pattern B: Forward Proxy & HTTPS `CONNECT` Tunneling

Not all tools support custom Base URL overrides (e.g., Notion SDK, GitHub SDK, Google APIs, Stripe, Jira, raw HTTP requests). 

To support any external API without code rewriting:
1. The Factory Shim automatically sets standard forward proxy environment variables:
   ```bash
   HTTP_PROXY=http://<gatekeeper-egress-host>:<port>
   HTTPS_PROXY=http://<gatekeeper-egress-host>:<port>
   http_proxy=http://<gatekeeper-egress-host>:<port>
   https_proxy=http://<gatekeeper-egress-host>:<port>
   ```
2. When the agent application initiates an HTTPS request to `https://api.github.com`:
   - The runtime or HTTP client connects to the gatekeeper-egress and sends an HTTP `CONNECT api.github.com:443 HTTP/1.1` request.
   - The request includes `Proxy-Authorization: Bearer ${FACTORY_RUN_TOKEN}` (or `x-factory-run-token`).
   - The gatekeeper-egress evaluates the target hostname against the agent's declared policy `hosts` allowlist (e.g. `api.github.com` or `*.github.com`).
   - If permitted, the gatekeeper-egress establishes a raw TCP socket to the upstream host, returns `200 Connection Established`, pipes the client and server sockets together, and logs an `EGRESS_TUNNEL` entry in the execution ledger.
   - If unauthorized, the gatekeeper-egress terminates the tunnel with `403 Forbidden` (`host_not_allowed`).

---

## 3. Cartridge Contract: Declaring Egress Requirements

Cartridge authors declare their required network egress in `cartridge.yaml` using the `egress` block:

```yaml
schemaVersion: "1.0"
id: compliance-auditor
name: "Compliance Auditor"
role: "Automated Evidence Collector"
prompt: "./soul.md"

# Network Egress Requirements
egress:
  routes:
    - llm              # Standard LLM providers (anthropic, openai)
    - discord          # Discord REST API for notifications
  hosts:
    - api.github.com
    - api.notion.com
    - "*.googleapis.com"

secrets:
  requires:
    - name: NOTION_API_KEY
      description: "Notion integration token"
    - name: GITHUB_TOKEN
      description: "GitHub personal access token"
```

### Automatic Egress Derivation

To maintain developer ergonomics and prevent accidental network lockouts:
- If a cartridge declares a `discord` trigger, the contract automatically derives the `discord` egress route and `discord.com` host.
- If `egress.routes` is empty or omitted, the contract automatically derives default `llm` egress (`['anthropic', 'openai']`).
- When the Control Plane provisions or wakes a run (`startRun`), it synchronizes the cartridge's derived egress routes and host allowlists directly into the agent's active runtime policy.

---

## 4. Secret Binding and Per-Agent Credential Resolution

In the Agent Factory model: **Agents Never Hold Upstream Provider Keys.**

The gatekeeper-egress resolves credentials dynamically just-in-time:

1. **Agent-Specific Credentials:** For multi-tenant or multi-agent integrations (like Discord bots where each agent possesses its own bot identity), the gatekeeper-egress searches for secrets in the following order:
   - `{AGENT_ID}_{SECRET_NAME}` (e.g. `donna_DISCORD_BOT_TOKEN`, `DONNA_DISCORD_BOT_TOKEN`)
   - `{SECRET_NAME}` (e.g. `DISCORD_BOT_TOKEN`)
2. **Landing Zone IAM Scoping:** In AWS deployments, the gatekeeper-egress ECS execution role is granted read permissions to secrets scoped under `${local.secret_arn}/*`, ensuring that newly declared routes in cartridges can resolve their keys without Terraform changes.
3. **Cache & Invalidation:** Injected credentials are encrypted in-memory and cached with TTL ≤ 60s. An upstream `401 Unauthorized` response immediately purges the cached secret and records a `RUNTIME_AUTH_FAILURE` event in the ledger.

---

## 5. Failure Modes, Diagnostic Signals, and Recovery

When debugging agent connectivity in production, check these specific indicators:

| Symptom | Root Cause | Diagnosis & Fix |
|---|---|---|
| gatekeeper-egress returns `403 Forbidden` (`route_not_allowed`) | The requested route is not present in the agent's active policy. | Check `cartridge.yaml` `egress.routes`. The Control Plane automatically syncs derived routes at run start. |
| gatekeeper-egress returns `403 Forbidden` (`host_not_allowed`) | A forward proxy or CONNECT request targeted a hostname not in `egress.hosts`. | Add the domain or wildcard (e.g. `*.github.com`) to `egress.hosts` in `cartridge.yaml`. |
| Agent receives `401 Unauthorized` on `/api/v1/runs/:id/result` | Idle timeout reached while waiting in warm-down window. | Fixed in Factory: polling `/mailbox` refreshes the run deadline. Control plane accepts results within grace window. |
| Discord gatekeeper-ingress shows `❌ failed to load` after ~75s | Fargate container cold start and initial reasoning exceeded 75 seconds. | Configured via `GATEKEEPER_INGRESS_STANDBY_TIMEOUT_MS` (default is now 180 seconds). |
| Discord Bot drops connection (`4004` / WebSocket disconnects) | Split-brain gatekeeper-egress connections (multiple processes running with the same bot token). | Ensure legacy deployments (e.g. Cloud Run, local daemons) are terminated so only one gatekeeper-ingress instance connects per token. |

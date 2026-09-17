# Agent Factory — Architectural Specification

Canonical architecture: [POSITION_PAPER.md](./POSITION_PAPER.md). This file is the implementation spec. On conflict, the paper wins.

---

## 1. Separation of concerns

The **Agent Factory** is hosting, plumbing, governance, and lifecycle. **Agent Garrison** (and any other UI) is a privileged client of the factory control plane. Garrison is not a structural dependency.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PRIVILEGED CLIENTS (optional overlays)                                     │
│  Garrison C2, CLIs (claude code, codex, agy), Web UIs                       │
└──────────────────────────────────────▲──────────────────────────────────────┘
                                       │ REST / WebSocket / MCP
┌──────────────────────────────────────┴──────────────────────────────────────┐
│  AGENT FACTORY KERNEL                                                       │
│  ├── Cartridge registry (soul.md, surface.yaml, secrets.manifest.yaml)      │
│  ├── Scale-to-zero compute + wake routing                                   │
│  ├── Secret binding (BYO Vault / AWS SM / GCP SM)                           │
│  ├── Persistent mind (object-storage hydrate / replicate)                   │
│  ├── Factory sidecar (egress intercept, kill-switch, OTLP)                  │
│  └── Immutable execution ledger                                             │
└──────────────────────────────────────▲──────────────────────────────────────┘
                                       │ hosts, does not author
┌──────────────────────────────────────┴──────────────────────────────────────┐
│  PORTABLE CARTRIDGES (example set in agents/)                               │
│  FinOps Officer, Librarian, MedDoc, Factory Mechanic, Compliance Officer    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Cartridge contract

Adopters define an agent as:

```
my-agent/
├── soul.md                  # identity, persona, tone, purpose, boundaries
├── surface.yaml             # ingress: cron, webhook, queue, http
├── secrets.manifest.yaml    # requires: [NAME, ...] — never values
├── skills.yaml              # optional MCP peripheral allowlist
├── identity.yaml            # optional: daemon | on_behalf_of
└── artifact.yaml            # portable compute pointer (OCI / serverless / managed engine)
```

`skills.yaml` is **not** a factory-hosted code library. Ordinary skills ship inside the artifact. MCP entries are environmental peripherals, bloated tools, or centralized stateful security.

The factory does not import agent logic. Example cartridges under `agents/` are fixtures, not kernel modules.

---

## 3. Kernel capabilities

### 3.1 Always available, not always on

Agents consume zero active compute when idle. A `surface.yaml` trigger or control-plane `wake` request scales the instance from zero, runs the work, persists mind, and scales back to zero.

### 3.2 Ephemeral compute, persistent mind

Local disk is disposable. On cold start the factory hydrates memory from object storage and continuously replicates out.

### 3.3 Secret binding, not secret storage

The cartridge declares names. The factory fetches values from the adopter’s secrets manager and injects them at boot. The factory is not a vault. An MCP gateway must not store API credentials.

### 3.4 Sidecar (injected observability)

Every worker is wrapped by a factory sidecar that:

- intercepts LLM HTTP and MCP egress (the agent does not report its own token counts)
- writes token, tool, and action records to the factory ledger
- acts as kill-switch: `PAUSE` / `RESUME` / `ISOLATE` / `THROTTLE` at the proxy
- taps stdout/stderr and emits OTLP
- optionally writes **redacted** LLM prompt/response traces into the agent’s mind (`$MEMORY_DIR/traces/`) when `FACTORY_TRACE_PROMPTS` is on. TTL is `FACTORY_TRACE_TTL_SECONDS` (default 86400; `0` disables expiry). This is not the ledger.

The sidecar is not the agent’s PID 1 and is not named for Garrison. An optional `TELEMETRY_SINKS=garrison` adapter may push heartbeats to a client.

Remote shell `EXEC` is **not** a factory kernel command.

### 3.5 Immutable execution ledger

Append-only store of tokens, MCP invocations, and system actions, with actor/authorization. Answers “what did the agent do, and who authorized it?” Garrison and FinOps *read* this API; they do not own it.

**Zero-knowledge flush:** the write path is a closed schema (metadata + `payloadSha256`). Prompt text, MCP params, and Discord bodies are hashed, never stored. The sidecar redacts bound secret *values* from logs and ledger lines before disk. There is no post-hoc redact of JSONL.

### 3.6 Headless control plane

Factory gateway (REST + MCP):

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz`, `/api/v1/health` | liveness |
| GET | `/api/v1/agents` | cartridge catalog |
| POST | `/api/v1/agents/:id/wake` | scale from zero |
| POST | `/api/v1/agents/:id/pause\|resume\|isolate` | kill-switch |
| GET | `/api/v1/ledger` | audit query |

The same surface is exposed as MCP tools. Auth is bearer/OIDC. Per-container fake `/v1/mcp/agents` JSON is not MCP and is not the factory catalog.

Discovery payload (control plane, not sidecar):

```json
{
  "id": "agent-id",
  "name": "Human-Readable Agent Name",
  "role": "Functional role",
  "state": "IDLE | WORKING | PAUSED | ISOLATED | BLOCKED_FOR_HUMAN | ERROR",
  "model": "optional",
  "provider": "gcp-cloud-run | aws-ecs | local",
  "artifact": "oci://..."
}
```

`sectorId` and other overlay geometry belong to Garrison, not the factory schema.

### 3.7 Decentralized control plane

Budget enforcement and crash diagnosis are *cartridges* (FinOps, MedDoc), not hardcoded factory modules. The factory routes ledger events and crash logs; it does not contain agent-specific remediation logic.

---

## 4. Foundational example cartridges

Shipped under `agents/` as portable examples. Factory code must not import them.

| Identifier | Mandate |
|---|---|
| `finops-officer` | Read the factory ledger; recommend or trigger kill-switch via factory API |
| `librarian` | Index *peripheral* MCP endpoints and docs; not a factory skill runtime |
| `med-doc` | Consume crash/OOM events routed by the factory; produce post-mortems |
| `factory-mechanic` | IaC and pipeline triage as an agent, not as factory code |
| `compliance-officer` | DLP / audit consumption of ledger + logs |

---

## 5. Deferred — not factory kernel

These appear in earlier drafts. They are **not** required to satisfy the position paper and must not be implemented as kernel:

1. **Doorman (module, not a deploy-time Discord app).** Always installed, idle until a cartridge declares `type: discord` and `DISCORD_BOT_TOKEN` (or `secretRef`) binds. Gateway stays up; presence is offline while the agent sleeps and available after conversation handoff. Slack RTM and true TCP socket transfer remain deferred.
2. **Cloud OAuth broker** — factory-stored OBO refresh tokens.
3. **Training Gym** — Promptfoo / multi-model graduation / Garrison hex “gym” tile.
4. **LiteLLM-as-product** — a model-router SKU. A sidecar intercept proxy *is* kernel; a routing marketplace is not.
5. **Shared skills catalog / capability triage bot** — contradicts “skills live in the artifact.”
6. **Voice / robotics streaming gateway.**
7. **MCP tool gateway as credential vault** — contradicts secret binding.

Daemon vs on-behalf-of identity (`identity.yaml`) may land later as optional cartridge metadata. It is not required for the kernel contract.

---

## 6. Current tree vs kernel (gap)

| Kernel piece | In tree today |
|---|---|
| Cartridge schema + validator | `packages/contract` + `npm run validate` |
| `surface.yaml` / `secrets.manifest.yaml` / `memory.yaml` | Present on all example agents |
| Doorman | `packages/doorman` — idle without a bot token; presence offline/available |
| Auth | `packages/auth` — bearer or OIDC iss/aud (Cloudflare / Entra / Google) |
| Factory sidecar intercept | `sidecar/`: LLM proxy, isolate/pause/throttle, optional Garrison sink |
| Control plane REST + MCP | `packages/control-plane` |
| Secret binding | `packages/secrets-bind` (env, file, HTTP vault/SM). Wake returns 412 if unbound |
| Scale-to-zero + wake | Control-plane wake + idle timer; webhook from `surface.yaml`; AWS RunTask schedule; Cloud Run `min_instance_count = 0` |
| Memory hydration | `packages/hydrate` + `runtimes/generic/start.sh` |
| Factory ledger | `packages/ledger` closed schema + hash + secret mask; sidecar POSTs here |
| Event routing | `type=crash` wakes `med-doc`; `budget.alert` wakes `finops-officer` |
| Blueprints | AWS/GCP modules with sidecar+worker, named-secret IAM, mind bucket, no `AmazonBedrockFullAccess` |

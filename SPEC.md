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
│  ├── Egress gateway (only route out: meter, budget, tools, credentials)     │
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

### 3.4 Agent shim and health

There is no sidecar container. Every agent image runs under the factory shim (`packages/hydrate/dist/shim.js`, the entrypoint of `runtimes/generic`), which has no security role:

- hydrates mind from object storage, replicates it every `FACTORY_MIND_SYNC_SECONDS` and on exit;
- points stock SDKs at the gateway (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) with the run token as their API key;
- heartbeats `POST /api/v1/runs/:id/heartbeat` with worker RSS every `FACTORY_HEARTBEAT_SECONDS`;
- reports `failed` if the worker exits non-zero without reporting.

A run that has sent a heartbeat and then goes silent for `FACTORY_HEARTBEAT_TIMEOUT_MS`, or reports RSS over `FACTORY_MAX_RSS_MB`, has its compute halted and is parked in `BLOCKED_UNHEALTHY`, with a `crash` event routed to MedDoc. `FACTORY_CRASH_LOOP_THRESHOLD` consecutive failed runs within 10 minutes pause the agent until an operator resumes it.

Health and throughput are OpenTelemetry metrics (`factory.runs.*`, `factory.run.duration`, `factory.health.events`, `factory.gateway.*`) exported over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. They are never written to the ledger. Overlays such as Garrison poll the REST surface; the factory does not push to them.

### 3.5 Tamper-evident execution ledger

Append-only store of tokens, costs, MCP invocations, and system actions, with actor/authorization. Answers "what did the agent do, and who authorized it?" Garrison and FinOps *read* this API; they do not own it.

**Zero-knowledge flush:** the write path is a closed schema (metadata + `payloadSha256`). Prompt text, MCP params, and Discord bodies are hashed, never stored. Bound secret *values* are masked before a row is hashed or written.

**Hash chain:** every row carries `seq`, `prevHash` and `hash = sha256(prevHash + "\n" + canonical(row))`. Editing, deleting or reordering any row breaks the chain from that `seq` on. `GET /api/v1/ledger/verify` recomputes the chain from disk (409 on failure), and the control plane refuses to start on a chain that does not verify rather than append on top of it. The control plane is the single writer.

**Write-once anchor:** every `FACTORY_LEDGER_CHECKPOINT_SECONDS` (and on shutdown) the rows since the last checkpoint are shipped to `FACTORY_LEDGER_WORM_URI`. On AWS this is an S3 bucket with Object Lock in COMPLIANCE mode (`ledger_retention_days`), so the checkpoint — rows included — cannot be deleted or overwritten by anyone before retention ends. `verify` checks that the local chain lands on every checkpoint hash, which catches truncation and a history rewritten from genesis. Tamper-*evident* locally, tamper-*proof* for everything already checkpointed.

### 3.6 Headless control plane

Factory gateway (REST + MCP):

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/healthz`, `/api/v1/health` | none | liveness |
| GET | `/api/v1/agents` | viewer | cartridge catalog |
| POST | `/api/v1/agents/:id/runs` (alias `/wake`) | operator | start a run: **202** + run; body `{input?, callbackUrl?}`; 412 on missing secrets; 409 if paused/isolated |
| POST | `/api/v1/agents/:id/pause\|resume\|isolate` | operator | kill-switch |
| GET | `/api/v1/runs`, `/api/v1/runs/:runId` | viewer | run status |
| POST | `/api/v1/runs/:runId/cancel` | operator | stop a run |
| GET | `/api/v1/runs/:runId/input` | run token | agent fetches its input |
| POST | `/api/v1/runs/:runId/result` | run token | agent reports `{status: succeeded\|failed, output?, error?}` |
| POST | `/api/v1/hooks/:id` | cartridge secret | webhook trigger, creates a run |
| GET | `/api/v1/ledger` | viewer | audit query |
| POST | `/api/v1/ledger` | ingest | metadata-only event write |
| GET/PUT | `/api/v1/agents/:id/policy` | viewer / admin | egress policy (routes, models, tools, budget, TPM) |
| GET | `/api/v1/approvals?state=pending` | viewer | held tool calls |
| POST | `/api/v1/approvals/:id` | approver | `{decision: approve\|reject}` |
| GET | `/api/v1/gateway/runs/:runId` | gateway | run state, agent kill-switch state, policy, spend |
| POST | `/api/v1/gateway/approvals`, `.../:id/consume` | gateway | open / use a one-shot approval |

**Runs.** Every wake (manual, webhook, cron, event route, Doorman) creates a run: `QUEUED → STARTING → WORKING →` one of `DONE`, `FAILED`, `TIMED_OUT`, `CANCELLED`, or `PRE_FLIGHT_MISSING_SECRET`. One run per agent executes at a time; others queue. Runs persist on disk (`FACTORY_RUNS_DIR`) and are reconciled on restart: remote tasks (ECS) are re-adopted or finished from DescribeTasks, in-process tasks are marked `FAILED`. The agent receives `FACTORY_RUN_ID`, `FACTORY_URL` and a short-lived `FACTORY_RUN_TOKEN` (HS256, `FACTORY_RUN_TOKEN_KEY`) valid only while its run is live. On a terminal state the factory POSTs to `callbackUrl` (https, public addresses only) with `x-factory-signature: t=<unix>,v1=hex(HMAC-SHA256(FACTORY_CALLBACK_SIGNING_KEY, "<t>.<body>"))`. On ECS, cartridge secrets come from the task definition's Secrets Manager `secrets` block under `factory/<env>/<NAME>`, the same names pre-flight checks via `FACTORY_SECRETS_AWS_PREFIX`; RunTask overrides carry only run metadata.

The same surface is exposed as MCP tools. Per-container fake `/v1/mcp/agents` JSON is not MCP and is not the factory catalog.

**Auth and roles.** The control plane refuses to start without auth configured (`FACTORY_AUTH=none` works only with `FACTORY_INSECURE_NO_AUTH=1`). Humans use OIDC: the JWT signature is verified against the IdP's JWKS, plus iss, aud and exp; roles come from `FACTORY_OIDC_ROLES_CLAIM` (default `roles`), optionally mapped through `FACTORY_OIDC_ROLE_MAP`. Services use named bearer tokens (`FACTORY_TOKENS`, JSON `[{name, token, roles}]`). `FACTORY_TOKEN` is a break-glass admin token.

| Role | Can |
|---|---|
| `viewer` | list agents, read ledger, MCP read tools |
| `operator` | viewer + wake/pause/resume/isolate, conversation handoff |
| `approver` | viewer + approve held actions |
| `ingest` | `POST /api/v1/ledger` only (actor forced to the token's name, server timestamp) |
| `admin` | everything |

Every ledger action row records the authenticated principal as `actor` (`oidc:<email>`, `token:<name>`, `webhook:<agent>`, or `factory:<subsystem>` for self-initiated actions). Webhooks authenticate with the cartridge's `secretRef` (header `x-factory-secret`), not a factory bearer. Doorman's presence API requires `DOORMAN_TOKEN`; the sidecar command API requires `SIDECAR_TOKEN`, and both fail closed.

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

### 3.7 Policy lives in the kernel

Budgets, model and route allowlists, tool allowlists and approval requirements are admin-set per agent (`PUT /api/v1/agents/:id/policy`) and enforced by the factory. Policy is deny-by-default: an agent with no policy has no egress. Cartridges such as FinOps and MedDoc *consume* factory events (`budget.alert`, `crash`) to recommend and diagnose; they are not the enforcement point.

### 3.8 Egress gateway

One fleet-wide gateway (`packages/gateway`) is the only route out of the agent network. Agents point their SDK base URLs at `http://<gateway>/<route-id>` and present their run token as the API key (`x-api-key`, `Authorization: Bearer`, or `x-factory-run-token`). The gateway:

- verifies the run token (HS256, shared `FACTORY_RUN_TOKEN_KEY`) and asks the control plane whether the run is live, the agent is paused/isolated, and what its policy and spend are (cached ≤1s);
- strips the run token and injects the real credential for the route from the adopter's secret manager — **agents never hold provider keys**; an upstream 401 purges the cached credential and records `RUNTIME_AUTH_FAILURE`;
- meters LLM usage from JSON and SSE (Anthropic Messages, OpenAI Chat and Responses; forces `stream_options.include_usage`), prices it from the operator's price table (unpriced models are refused), and writes `llm` ledger rows with `costUsd` attested as `run:<agent>`. A response with no usage is charged at its `max_tokens` and marked `METERING_GAP`;
- enforces budgets **before** each call using control-plane spend plus spend not yet acknowledged; the control plane moves the run to `BLOCKED_BUDGET_EXCEEDED` when a settled call crosses a limit. Overshoot is therefore bounded by one in-flight request per replica;
- governs MCP `tools/call`: tools outside the route's allowlist are refused without contacting the server; `requireApproval` tools return JSON-RPC error `-32003` with an `approvalId`, park the run in `BLOCKED_FOR_HUMAN`, and are released exactly once — for the same arguments — after an `approver` decides.

Route and price configuration: `FACTORY_GATEWAY_CONFIG` (JSON `{routes, prices}`) or `FACTORY_GATEWAY_ROUTES` + `FACTORY_PRICES`. Prices are USD per million tokens and are the operator's responsibility; the factory ships none.

---

### 3.9 Benchmark harness (cost vs quality)

Every cartridge ships `bench.yaml`: cases with an `input` and deterministic expectations (`status`, `equals`, `contains`, `matches`). Running it is optional. `factory-bench --cartridge <dir> --models a,b` runs each case as a real run through the factory with the run **pinned** to the model (`POST /runs {model}`; the gateway refuses any other model for that run), reads each run's cost from the ledger, and prints the Cost vs Quality Matrix projected to `--runs-per-month`. It recommends the cheapest model meeting `--min-pass` with a per-run budget of 2× the most expensive observed case; `--apply` writes that into the agent's policy (admin). No LLM judge: grading is reproducible.

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
4. **LiteLLM-as-product** — a model-router SKU. A sidecar intercept proxy *is* kernel; a routing marketplace is not.
5. **Shared skills catalog / capability triage bot** — contradicts “skills live in the artifact.”
6. **Voice / robotics streaming gateway.**
7. **MCP tool gateway as credential vault** — contradicts secret binding.

Daemon vs on-behalf-of identity (`identity.yaml`) may land later as optional cartridge metadata. It is not required for the kernel contract.

---

## 6. Where each kernel piece lives

| Kernel piece | In tree |
|---|---|
| Cartridge schema + validator | `packages/contract` + `npm run validate` |
| Auth + RBAC | `packages/auth` — JWKS-verified OIDC, named service tokens, run tokens |
| Control plane REST + MCP, runs, policy, approvals, health | `packages/control-plane` |
| Egress gateway | `packages/gateway` |
| Ledger (hash chain + WORM checkpoints) | `packages/ledger` |
| Secret binding | `packages/secrets-bind` (env, file, HTTP vault, AWS Secrets Manager) |
| Mind hydration + agent shim | `packages/hydrate` + `runtimes/generic` |
| Metrics | `packages/telemetry` (OTLP) |
| Doorman | `packages/doorman` — idle without a bot token |
| Landing zones | Compose and AWS (ECS) binds; Azure/GCP slot notes |

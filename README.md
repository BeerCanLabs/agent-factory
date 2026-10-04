# BeerCanLabs Agent Factory

Turnkey hosting for autonomous agent fleets. **The factory is the console; the agent is the portable cartridge.**

If you are an AI asked to “build that” from this repo, read **[AGENTS.md](./AGENTS.md)** first.

Canonical architecture: [POSITION_PAPER.md](./POSITION_PAPER.md).

---

## What this is

A **harness**: wake from zero, bind secrets (names only), hydrate mind from object storage, intercept LLM/MCP egress, append-only ledger, MCP/HTTP console. Discord is an **optional mailbox** (gatekeeper-ingress). You do not need a Discord app to deploy the factory. You do not install Hermes or OpenClaw.

Landing zone is a **Draftsman interview**: pick a baseline pattern in `.draft/sdp.yaml`, then bind Azure, AWS, GCP, or Compose. See `landing-zones/PATTERNS.md`. `landing-zones/aws` is one bind (orchestrated-tasks × AWS), not the factory.

---

## Kernel vs Optional

| Always | Optional |
|---|---|
| Control plane REST + MCP | Discord (gatekeeper-ingress holds gatekeeper-egress when a cartridge has a `discord` surface **and** a bot token is bound) |
| gatekeeper-egress intercept + kill-switch | Garrison or any other UI |
| Secret binding, S3/volume hydrate, ledger | Prompt traces in mind (`FACTORY_TRACE_PROMPTS`) |
| Auth: JWKS-verified OIDC (Entra / Cloudflare / Google) + named service tokens, RBAC | |

---

## The Cast: Factory Services & First-Class Contracts

Agent Factory is architected around **11 canonical services ("The Cast of Characters")** defined in [`DESIGN_AUTHORITY.md` §6.15](DESIGN_AUTHORITY.md#615-factory-service-architecture-the-cast-of-characters--first-class-contracts). Every workspace package belongs to one of these 11 intentional services (SV1) or declared platform tooling.

### The 11 Cast Members

1. **Gatekeeper (Perimeter Security):**
   - **Role:** Owns inbound presence, wakes, webhooks, front-door authentication verification (A1, A2), and zero-trust outbound proxying (E1, E6) with credential injection (S1). Composed of `gatekeeper-ingress` and `gatekeeper-egress`.
   - **Contract:** Inbound webhook & presence protocol, token-authenticated egress proxy (`<ROUTE>_BASE_URL`), and run-token authorization. Relays wake refusals (such as budget caps) directly to callers.

2. **Keymaster (Credential Facilitation):**
   - **Role:** Owns OAuth connections, consent flows, token refreshes (K1–K4), write-only static secret onboarding (K5), and vault mapping.
   - **Contract:** Zero-knowledge credential evaluation, ephemeral leases, token rotation events, and write-only platform secrets onboarding without exposing plaintext credentials to agents.

3. **Tinman (Model Service / Inference Provider):**
   - **Role:** Provides a uniform OpenAI-compatible Chat Completions API (M1), translates calls across model providers (Bedrock, OpenAI, Anthropic, xAI), enforces model policy routing (M2), and counts tokens (E5).
   - **Contract:** Translates provider formats, normalizes token usage (`input`, `output`, `cacheRead`, `cacheWrite`), and reports usage to the Treasurer for pricing.

4. **Secretary (Hydration & State Store):**
   - **Role:** Enforces "The Safe" (§6.6); syncs local SQLite databases in `$MEMORY_DIR` with cloud object storage on wake and sleep.
   - **Contract:** Pre-flight pull and post-run push/flush hooks. Ensures cartridges never require cloud storage SDKs.

5. **Landlord (Compute Lifecycle & Turn Broker):**
   - **Role:** Manages serverless min=0 compute, wake-from-zero, warm-down windows, operational pause/kill-switches, turn coordination via `/mailbox` long-polling, and two-stage retirement (§6.4).
   - **Contract:** Run state machine lifecycle, pre-flight standing verification with the Treasurer before starting runs (`createRun`), and runtime container task supervision.

6. **Auditor (Immutable Ledger):**
   - **Role:** Owns the cryptographic append-only WORM audit trail of runs, spend, credential actions, and perimeter decisions (LG1, LG2).
   - **Contract:** Single-writer leased file ledger with SHA-256 hash chaining, WORM checkpointing (S3 Object Lock / GCS retention), and automated secret and prompt redaction.

7. **Treasurer (Spend Governance & FinOps):**
   - **Role:** Spend governance, real-time token pricing, and budget circuit-breakers (E5, M3). Resides in `packages/budget`.
   - **Contract:** Exposes `checkStanding({ limits, spend, pendingUsd? })` returning `{ inGoodStanding: true }` or `{ inGoodStanding: false, window }`. Gatekeeper-egress checks standing before every model call, and the Landlord checks before waking an agent.

8. **Bouncer (Governance & Approvals):**
   - **Role:** Intercepts and holds sensitive actions (writes in a person's name, sensitive tools) until explicit human sign-off is granted (E4, E9).
   - **Contract:** Role-based authorization and held action lifecycle (`Approval` records with tool argument visibility).

9. **Timekeeper (Scheduling & Timers):**
   - **Role:** Manages agent-scoped cron schedules and one-shot wakeup timers without persistent in-container daemon processes (§6.15).
   - **Contract:** Agent-scoped `ScheduleStore`, cron evaluation, and scheduled wake dispatch.

10. **Registrar (Admissions & Catalog):**
    - **Role:** Evaluates cartridge and skill manifests, runs mandatory test suites and secret scans, enforces commit pinning (L3–L4), approves reusable skills (SK1–SK5), and manages the versioned configuration store.
    - **Contract:** Validates `cartridge.yaml` and `skills.yaml` against canonical schemas; hashes and registers immutable configuration snapshots.

11. **Seer (Observability, Telemetry & Triage):**
    - **Role:** Emits live run progress event streams (e.g., `discord-progress`), exports headless operational metrics (`/metrics`), and routes crash diagnostics to alerting.
    - **Contract:** Headless OTel metric instruments, SSE progress event streaming, and triage diagnostic capture.

### Contracts as Designed: Architectural Invariants

- **First-Class Cross-Service Contracts (SV2):** Services communicate across package boundaries strictly through explicit, typed contracts wired directly into real call sites. Direct backdoor access to another service's private persistence, tables, or internal modules is strictly forbidden.
- **Entry-Point Locking & No Deep Imports (D1-C, D3):** Each service exports its typed contract only from its package root (`exports: { ".": ... }`). Subpath imports into package internals are rejected by machine checks.
- **The Cartridge vs. Factory Boundary ("The Donna Test"):** Never modify Factory kernel code to alter an agent's reasoning, memory, or conversational behavior. Cartridges (the employees) own business logic, prompts, persona, and cognitive reasoning loops; the Factory provides the utilities (compute, memory safe, model service, perimeter).
- **The Console vs. Factory Boundary (Headless Principle):** Web Consoles (Console, Garrison) are headless client overlays (§6.5). They own zero service logic, zero secrets, and zero persistence.

---

## Known Gaps (As Designed)

The architecture is opinionated and accepts certain limits by design:
- **Cloud Providers:** GCP and Azure are notes and examples only; full IaC is currently AWS and Docker Compose.
- **Compose Isolation:** Compose-host is root-equivalent; trust is assumed for the control plane.
- **Queues:** SQS is the only inbound queue provider supported.
- **Event Bus:** EventBridge delivery is at-least-once, meaning subscribers must handle idempotency.
- **Control Plane:** The control plane is a single writer/instance by design to serialize the ledger hash chain.

---

## Documentation & Layout

- **[Cartridge Developer Guide](docs/CARTRIDGE_DEVELOPER_GUIDE.md)** — Step-by-step guide to building, testing, and packaging an Agent Cartridge using the "New Hire" model.
- **[DESIGN_AUTHORITY.md](DESIGN_AUTHORITY.md)** — The Single Source of Truth (SSOT) for architectural intent, component contracts, and AI governance.
- **[POSITION_PAPER.md](POSITION_PAPER.md)** — The foundational manifesto: Console vs. Cartridge.
- **[AGENTS.md](AGENTS.md)** — Instructions for implementing AIs deploying the Factory.

```
docs/CARTRIDGE_DEVELOPER_GUIDE.md # Developer tutorial for building cartridges
DESIGN_AUTHORITY.md               # SSOT architecture & AI locking board
AGENTS.md                         # implementing-AI playbook
POSITION_PAPER.md                 # Core manifesto
packages/…                        # kernel (contract, control-plane, gatekeeper-egress, hydrate, etc.)
agents/                           # example cartridges (starter-python, echo-agent, etc.)
landing-zones/                    # PATTERNS.md + aws/azure/gcp/compose binds
.draft/sdp.yaml                   # three baseline patterns + interview slots
runtimes/generic/                 # agent shim + exec
```

---

## License

Apache-2.0 © BeerCanLabs

## Deployment Configuration

When deploying the Agent Factory to a cloud landing zone (e.g. AWS or GCP), configure standard environment variables:
- `AWS_ACCOUNT_ID`: Your 12-digit AWS Account ID (when targeting AWS).
- `AWS_REGION`: The AWS region (defaults to `us-east-1`).
- `FACTORY_ECR_REPO_URI`: ECR repository URI for dynamic agent container images.

See [`landing-zones/PATTERNS.md`](landing-zones/PATTERNS.md) and [`landing-zones/aws`](landing-zones/aws) for infrastructure provisioning details.


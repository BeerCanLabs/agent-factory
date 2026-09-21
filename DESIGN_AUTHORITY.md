# Agent Factory — Design Authority (SSOT)

> **CRITICAL INSTRUCTION FOR AI AGENTS (Claude, Grok, Gemini):**
> This document is the **single, immutable source of truth** for architectural intent, component contracts, and engineering standards across the Agent Factory and Cartridge ecosystem.
> 
> **Zero Code Modification Rule:** No AI agent may create, modify, or delete any codebase files without first documenting the intent, logging the gap, and acquiring an explicit task lock within this document.

---

## 1. Governance & Hierarchy of Authority

When discrepancies arise between repository documents, prompts, or discussions, the following strict order of precedence applies:

1. **`DESIGN_AUTHORITY.md`** (This Document) — The ultimate arbiter of engineering intent, contracts, and lifecycle.
2. **Machine-Enforced Schemas** (`packages/contract/src/schema.ts`, unit tests) — The concrete validator.
3. **`POSITION_PAPER.md`** — Strategic philosophy, north star, and commercial manifesto. In any technical conflict with this document, `DESIGN_AUTHORITY.md` prevails.
4. **AI Platform Instructions** (`CLAUDE.md`, `GEMINI.md`, Grok system prompts) — Operational guidelines for specific LLMs.

---

## 2. AI Operating Protocol (Mandatory Workflow)

Every AI session (Claude, Grok, or Gemini) **must** follow this strict state machine before and during any code edits.

```
       [User Declares Intent]
                 │
                 ▼
     [AI Updates Intent in DA]
                 │
                 ▼
  [AI Confirms Update with User]
                 │
                 ▼
    [AI Logs Conflict/Gap in DA]
                 │
                 ▼
    [AI Acquires Task Lock in DA]  ◄── (Other AIs blocked on these files)
                 │
                 ▼
      [AI Modifies & Tests Code]
                 │
                 ▼
 [AI Verifies, Closes Task, & Unlocks]
```

### The 6-Step Workflow:

1. **User Declares New Intent:**
   - The user describes a new feature, behavioral modification, or design correction.
2. **AI Updates Design Authority & Confirms:**
   - The AI updates the *Declared Architectural Intent* section of this document.
   - The AI explicitly confirms this text update with the user before touching code.
3. **AI Documents the Conflict or Gap:**
   - The AI inspects the codebase against the new intent and logs a specific item in the **Conflict & Gap Register** (Section 4).
4. **AI Acquires a Task Lock:**
   - In the **Active Task & Locking Board** (Section 5), the AI creates or transitions the task to `LOCKED`.
   - The AI records: `AI Model (Claude | Grok | Gemini)`, `Timestamp`, `Session ID / Reference`, and `Locked Scope (Target Files)`.
5. **AI Implements Code within Locked Scope Only:**
   - The AI edits only the files claimed in the lock.
   - If adjacent files require changes, the AI must first expand its lock in `DESIGN_AUTHORITY.md`.
6. **AI Closes Task and Releases Lock:**
   - After testing and verification, the AI sets task status to `COMPLETED`, adds resolution notes, and clears the active lock.

---

## 3. Lock Recovery Protocol (Handling Hung or Abandoned Sessions)

Because AI sessions can be terminated unexpectedly (token limits, session crashes, timeouts), a strict lock recovery protocol is required:

1. **Detecting a Stale Lock:**
   - An incoming AI session inspecting the board sees a task marked `LOCKED`.
2. **Verification of Work State:**
   - The incoming AI **must inspect the codebase and git status** for the files listed under `Locked Scope`.
   - Case A: *Work was completed but not marked closed.* The incoming AI runs tests, validates against intent, and marks the task `COMPLETED`.
   - Case B: *Work was partially done or never started.* The incoming AI evaluates whether the existing diff is sound or needs resetting.
3. **Formal Lock Transfer (Override):**
   - The incoming AI explicitly logs in the task history: `[TIMESTAMP] Lock taken over from <Previous AI> by <Current AI> due to inactivity/session end.`
   - The incoming AI updates the `Locked By` field to its own identity and proceeds.

---

## 4. Conflict & Gap Register (Current State vs. Target Intent)

The following gaps exist between current repository code, `SPEC.md`, and the canonical architecture:

| Gap ID | Component | Description of Conflict / Divergence | Severity |
| :--- | :--- | :--- | :--- |
| **GAP-001** | **Cartridge Manifest Sprawl** | `SPEC.md` and `packages/contract` require up to 8 separate files (`soul.md`, `surface.yaml`, `secrets.manifest.yaml`, `artifact.yaml`, `bench.yaml`, `skills.yaml`, `identity.yaml`, `memory.yaml`). Several contain only 1–2 lines. Standard practice calls for a single unified `cartridge.yaml` plus `soul.md`. | High |
| **GAP-002** | **Registry API vs Contract Mismatch** | `packages/control-plane/src/app.ts` (`POST /api/v1/registry/agents`) accepts a flat JSON body `{ repo, secrets, triggers }` and invokes AWS CodeBuild, bypassing `packages/contract` and `artifact.yaml` validation entirely. | Critical |
| **GAP-003** | **CaaS vs. PaaS Duality** | `artifact.yaml` expects a pre-built OCI image (`kind: oci, ref: oci://...`), whereas `app.ts` + `codebuild.ts` treats the Factory as a PaaS that builds from Git source on `POST /deploy`. The platform lacks a unified build-and-deploy contract. | Critical |
| **GAP-004** | **Bespoke Worker Invocation Contract** | The reference worker ([worker.mjs](file:///Users/dsackrider/repos/BeerCanLabs/agent-factory/agents/examples/echo-agent/worker.mjs)) polls `GET /api/v1/runs/:id/input` and posts `POST /api/v1/runs/:id/result`. This tightly couples agent logic to the Factory REST API, violating the "portable zero-logic cartridge" principle. Standard CloudEvents/HTTP POST or Stdin/Stdout should be supported. | High |
| **GAP-005** | **Polyglot & Shim Coupling** | The runtime shim (`packages/hydrate/src/shim.ts`) is a Node.js process. Any Python, Go, or Rust agent container is forced to install Node.js 22 runtime dependencies just to execute the shim. | High |
| **GAP-006** | **Position Paper Sidecar Contradiction** | `POSITION_PAPER.md` describes a localhost Envoy sidecar proxy. In reality, `packages/hydrate` sets environment variables pointing across the network to `packages/gateway`. There is no local sidecar proxy intercepting traffic. Documentation and runtime architecture must be aligned. | Medium |
| **GAP-007** | **Mandatory Bench Suite for Registration** | `packages/contract/src/schema.ts` makes `bench.yaml` a mandatory file (`REQUIRED_FILES`). Cartridges cannot pass contract validation without deterministic benchmark cases, impeding simple agent development. | Medium |
| **GAP-008** | **Missing Developer Documentation** | There is no end-to-end "How to Build a Cartridge" guide, SDK reference, or sample template repository for external developers. | High |
| **GAP-009** | **AWS Network Isolation Breach** | `landing-zones/aws/network.tf` routes agent subnets `0.0.0.0/0` to IGW (lines 51-54) and assigns public IPs via `FACTORY_ECS_ASSIGN_PUBLIC_IP: "true"` (ecs.tf line 74). Security group `agents_to_internet` allows all outbound. Agents can bypass the egress gateway entirely, breaking the core security perimeter promised by the position paper. | Critical |
| **GAP-010** | **GCP Runtime Dead Code** | `FACTORY_RUNTIME=cloudrun` is unhandled in `packages/control-plane/src/index.ts` (falls through to `memoryRuntime`). `gcp/cloudrun.ts` defines `registerAgentJob()` but it is never imported or called. No `runtime-cloudrun.ts` exists. GCP agents cannot wake from zero. | Critical |
| **GAP-011** | **GCP Ledger WORM Crash** | `packages/ledger/src/checkpoints.ts` (line 138) rejects `gcs://` URIs with an unhandled exception. GCP Terraform sets `FACTORY_LEDGER_WORM_URI=gcs://...`, causing the control plane to enter a crash loop on boot. | Critical |
| **GAP-012** | **GCP Mind Hydration Missing** | `packages/hydrate/src/index.ts` only supports `s3://` and local paths. `gcs://` mind URIs set by GCP Terraform are silently ignored. Agent memory is not persisted on GCP. | Critical |
| **GAP-013** | **GCP Secret Manager Missing** | `packages/secrets-bind/src/index.ts` does not implement a GCP Secret Manager provider. `FACTORY_SECRETS_GCP_PROJECT` is set by GCP Terraform but never read by the kernel. | High |
| **GAP-014** | **Hardcoded AWS Imports in Kernel** | `packages/control-plane/src/app.ts` lines 1-3 unconditionally import `aws/ecs.ts`, `aws/iam.ts`, `aws/codebuild.ts`. The `/deploy` handler invokes AWS services regardless of the configured provider, violating cloud-agnosticism in the kernel itself. | Critical |
| **GAP-015** | **Hardcoded AWS Account ID** | `packages/control-plane/src/aws/ecs.ts` line 23 and `aws/codebuild.ts` line 45 contain fallback to account `566332862296`, violating `GEMINI.md` rule prohibiting company-specific AWS account IDs in this repository. | High |
| **GAP-016** | **Training Function Not Operational** | KPF §7 defines the quality evaluation architecture (bench.yaml rubric + prompt traces + trainer cartridge evaluating traces in mind storage), but the evaluation loop is not closed: no differentiated benchmark run mode (`trace: true, model: "pinned"`), no reference trainer cartridge, no automated graduation gate enforcement via the policy engine. The ledger correctly records cost and quantity at the perimeter; quality evaluation is a cartridge concern and belongs in the training function, not the ledger. | Medium |
| **GAP-017** | **Approval Arguments Opaque** | `Approval` stores `argsSha256` but not the actual tool arguments. Human reviewers querying `GET /api/v1/approvals` cannot see what the tool is about to do without separate access to prompt traces. | Medium |
| **GAP-018** | **Cartridge Lifecycle CRUD Incomplete** | No `DELETE /api/v1/registry/agents/:id` or `PUT /api/v1/registry/agents/:id` exists. Agents cannot be updated or decommissioned via the control plane API. | High |
| **GAP-019** | **No API Pagination** | `GET /api/v1/runs` and `GET /api/v1/ledger` lack `limit`, `offset`, or `cursor` parameters. Unusable at scale for reporting dashboards. | Medium |
| **GAP-020** | **No Stdout Streaming Endpoint** | No endpoint to tail container stdout/stderr in real time. UIs must bypass the control plane and connect directly to provider-specific log services (CloudWatch, Cloud Logging, Docker engine), breaking the headless contract. | Medium |
| **GAP-021** | **Stale Docker Blueprint** | `blueprints/docker/docker-compose.yml` is outdated (missing gateway, networks, docker-proxy). Confuses users who find it instead of `landing-zones/compose`. Should be archived or removed. | Low |
| **GAP-022** | **Azure Landing Zone Empty** | `landing-zones/azure/` contains only a 12-line markdown stub. Zero Terraform, Bicep, runtime bindings, or SDK integrations exist. | High |
| **GAP-023** | **Container Images Assume AWS CLI** | All four Dockerfiles (`control-plane`, `gateway`, `doorman`, `runtimes/generic`) install `aws-cli` via `apk add` regardless of target provider. Dead weight on non-AWS deployments. | Medium |
| **GAP-024** | **No Metrics REST Endpoint** | OTel metrics (`factory.runs.active`, `factory.gateway.cost`, etc.) are recorded internally but no `/metrics` or `/api/v1/metrics` REST endpoint exists for dashboards without an external OTel collector. | Low |

---

## 5. Active Task & Locking Board

> **RULES FOR EDITING THIS BOARD:**
> - Set status to `LOCKED` when you begin work on a task.
> - Fill `Locked By` (`<AI Model> - <YYYY-MM-DD>`).
> - List every file you intend to touch in `Locked Scope`.
> - Do NOT touch files outside your `Locked Scope`.
> - Set status to `COMPLETED` when done and verified.

| Task ID | Related Gap | Title / Summary | Status | Locked By | Locked Scope (Files) | Target / Resolution |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TSK-001** | GAP-001 | Consolidate Cartridge Manifest into unified `cartridge.yaml` | `COMPLETED` | *None* (Released) | `packages/contract/*` | Implemented `cartridgeSchema` and unified manifest validator with full backward compatibility. |
| **TSK-002** | GAP-007 | Make `bench.yaml` optional in contract validation | `COMPLETED` | *None* (Released) | `packages/contract/*` | Moved `bench.yaml` to `OPTIONAL_FILES`; verified across test suites. |
| **TSK-003** | GAP-002, GAP-003 | Reconcile Registry Service with Cartridge Contract | `COMPLETED` | *None* (Released) | `packages/control-plane/src/catalog.ts`, `packages/control-plane/src/app.ts`, `packages/control-plane/src/catalog.test.ts` | Aligned `loadCatalog` and registry API with unified `cartridge.yaml` and prebuilt OCI image handling. |
| **TSK-004** | GAP-004 | Standardize Worker Invocation (Input Injection / Result Capture) | `COMPLETED` | *None* (Released) | `packages/hydrate/*`, `agents/examples/*` | Implemented input prefetch (env/file) and result bridging in factory-shim. |
| **TSK-005** | GAP-005 | Language-Agnostic Shim Architecture & Starter Templates | `COMPLETED` | *None* (Released) | `packages/hydrate/*`, `agents/examples/*` | Built decoupled starter-python reference cartridge with SQLite memory and Dockerfile. |
| **TSK-006** | GAP-006 | Align Positioning Paper & Architecture on Egress Routing | `COMPLETED` | *None* (Released) | `POSITION_PAPER.md`, `DESIGN_AUTHORITY.md` | Aligned positioning paper with actual centralized egress gateway and run token injection architecture. |
| **TSK-007** | GAP-008 | Author Comprehensive Cartridge Developer Guide | `COMPLETED` | *None* (Released) | `docs/CARTRIDGE_DEVELOPER_GUIDE.md`, `README.md` | Authored end-to-end guide based on New Hire model with code examples & case studies. |
| **TSK-008** | GAP-015 | Remove Hardcoded Deployment Configurations & AWS Account IDs | `COMPLETED` | *None* (Released) | `.envrc`, `.envrc.example`, `.gitignore`, `packages/control-plane/src/aws/ecs.ts`, `packages/control-plane/src/aws/codebuild.ts`, `README.md`, `DESIGN_AUTHORITY.md` | Removed .envrc from git tracking, added to .gitignore, provided generic .envrc.example, removed hardcoded account fallback from ecs.ts and codebuild.ts, standard AWS_ACCOUNT_ID required. |
| **TSK-009** | GAP-014 | Decouple Kernel Deploy Provider (Eliminate Hardcoded Cloud Imports) | `COMPLETED` | *None* (Released) | `packages/control-plane/src/runtime.ts`, `packages/control-plane/src/app.ts`, `packages/control-plane/src/index.ts`, `packages/control-plane/src/aws/deploy.ts`, `packages/control-plane/src/gcp/deploy.ts`, `DESIGN_AUTHORITY.md` | Defined DeployProvider interface, implemented awsDeployProvider and gcpDeployProvider, wired dynamically in index.ts, purged direct cloud imports from app.ts. |
| **TSK-010** | GAP-009 | Restore AWS Agent Network Isolation (Perimeter Enforcement) | `COMPLETED` | *None* (Released) | `landing-zones/aws/network.tf`, `landing-zones/aws/ecs.tf`, `DESIGN_AUTHORITY.md` | Removed IGW route from agent route table, removed agents_to_internet egress rule, set FACTORY_ECS_ASSIGN_PUBLIC_IP to false, restoring zero-trust perimeter. |
| **TSK-011** | GAP-011 | Support GCS WORM Ledger Checkpoints (Fix Boot Crash Loop) | `COMPLETED` | *None* (Released) | `packages/ledger/src/checkpoints.ts`, `packages/ledger/src/index.ts`, `packages/ledger/src/index.test.ts`, `DESIGN_AUTHORITY.md` | Implemented GcsCheckpointSink supporting gcs:// and gs:// URIs with CLI abstraction, exported from ledger package, verified with unit tests. |
| **TSK-012** | GAP-012 | Support GCS Mind Hydration & Synchronization | `COMPLETED` | *None* (Released) | `packages/hydrate/src/index.ts`, `packages/hydrate/src/index.test.ts`, `DESIGN_AUTHORITY.md` | Implemented gcs:// and gs:// sync support in pullMind and pushMind using gcloud storage rsync with SyncExecutor abstraction and unit tests. |
| **TSK-013** | GAP-013 | Implement GCP Secret Manager Provider in secrets-bind | `COMPLETED` | *None* (Released) | `packages/secrets-bind/src/index.ts`, `packages/secrets-bind/src/index.test.ts`, `DESIGN_AUTHORITY.md` | Implemented gcpSecretManagerProvider reading from FACTORY_SECRETS_GCP_PROJECT with CLI abstraction, wired in providersFromEnv, verified with unit tests. |
| **TSK-014** | GAP-019 | Add Pagination to /api/v1/runs and /api/v1/ledger | `COMPLETED` | *None* (Released) | `packages/control-plane/src/app.ts`, `packages/control-plane/src/index.test.ts`, `DESIGN_AUTHORITY.md` | Added limit and offset query parameters to /api/v1/runs and /api/v1/ledger endpoints with unit test coverage. |
| **TSK-015** | GAP-021 | Deprecate and Clean Stale Docker Blueprint | `COMPLETED` | *None* (Released) | `blueprints/docker/*`, `DESIGN_AUTHORITY.md` | Removed stale docker-compose.yml and .env.example, replaced with superseded README pointing to landing-zones/compose. |
| **TSK-016** | GAP-024 | Implement REST Metrics Endpoint (/api/v1/metrics) | `COMPLETED` | *None* (Released) | `packages/control-plane/src/app.ts`, `packages/control-plane/src/index.test.ts`, `DESIGN_AUTHORITY.md` | Added /api/v1/metrics and /metrics endpoints returning active runs, agents by state, ledger status, and spend with unit test coverage. |










---

## 6. Declared Architectural Intent (The Target State)

### 6.1 The "New Hire" Mental Model (Console vs. Cartridge)
An Agent Cartridge is modeled as a **Digital Employee** being onboarded into an enterprise:
1. **The Job Description & Instructions (`soul.md`):** Persona, responsibilities, tone, and strict behavioral boundaries.
2. **The Employment Contract & Access (`cartridge.yaml`):** Declared variable names for required secrets, trigger events, tool capabilities, and persistent memory prefix.
3. **The Toolbox (`skills` / MCP Tools):** External tools, APIs, or MCP servers placed at the agent's disposal.
4. **The Filing Cabinet / Memory (`/memory`):** Embedded file-based databases (SQLite, DuckDB, JSON files) stored in `$MEMORY_DIR` that the Factory Console automatically hydrates on boot and syncs to object storage on sleep. (External shared enterprise databases are accessed via declared connection secrets).
5. **The Performance Rubric & Scorecard (`bench.yaml`):** Deterministic evaluation test cases ("When Y happens, do X; when B happens, do A") used to benchmark accuracy, latency, and token cost across models.
   - **Policy Gate Rule:** `bench.yaml` is **optional by default** at registration and across all stages. Factory administrators can configure company policy gates to require benchmarking at specific lifecycle milestones (registration, deployment, run, or production tier promotion).

### 6.2 The Unified `cartridge.yaml` Specification (Target Contract)
```yaml
schemaVersion: "1.0"
id: my-agent
name: "My Agent"
role: "Customer Operations"
prompt: "./soul.md"

triggers:
  - type: http
    path: /wake
  - type: webhook
    path: /hooks/events
    secretRef: WEBHOOK_SIGNING_SECRET
  - type: cron
    schedule: "0 9 * * 1-5"
  - type: discord
    secretRef: DISCORD_BOT_TOKEN

secrets:
  requires:
    - name: SLACK_BOT_TOKEN
      description: "Slack bot OAuth token"
    - name: JIRA_API_KEY
      description: "API key for Jira issue management"

persistence:
  enabled: true
  prefix: "my-agent-state"

compute:
  kind: oci # or local, git
  ref: "ghcr.io/org/my-agent:latest"
  cpu: 256
  memory: 512
```

### 6.3 Invocation & Runtime Semantics
* **Zero Custom SDK Requirement:** The worker receives its invocation payload via standard input environment (`FACTORY_INPUT` / `/tmp/input.json`), or clean invocation handler, and outputs its result without needing bespoke REST polling loops.
* **Perimeter Defense:** The Cartridge never holds a public IP address or directly opens unauthenticated public ports. Ingress is completely governed by the Console (Doorman for Discord, Ingress Gateway for webhooks/APIs).
* **Network & Gateway Security:** Outbound provider API calls (`anthropic`, `openai`) route via environment injection (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`), authenticated with short-lived run tokens, metered, and governed with hard-kill circuit breakers by the Factory Egress Gateway.

---

## 7. Change Log & Audit Trail

| Date | AI Agent | Action Taken | Related Task / Gap |
| :--- | :--- | :--- | :--- |
| 2026-09-20 | Gemini | Initialized `DESIGN_AUTHORITY.md`, established AI Operating Protocol, documented existing architectural gaps GAP-001 through GAP-008, and created initial Task Board. | Baseline |
| 2026-09-20 | Gemini | Formalized the "New Hire" architectural model in Section 6, defined the unified `cartridge.yaml` schema, established secret variable name conventions, and codified policy-gated `bench.yaml` rules. | GAP-001, GAP-004, GAP-007 |
| 2026-09-20 | Gemini | Executed and completed TSK-001 and TSK-002: added `cartridgeSchema` to `packages/contract`, updated `validateCartridge` for unified manifests, moved `bench.yaml` to optional, and added 5 new unit tests. | TSK-001, TSK-002 |
| 2026-09-20 | Gemini | Executed and completed TSK-004 and TSK-005: implemented input prefetching and result file bridging in `packages/hydrate/src/shim.ts`, and authored the reference `starter-python` cartridge. | TSK-004, TSK-005 |
| 2026-09-20 | Gemini | Executed and completed TSK-007: authored comprehensive Cartridge Developer Guide (`docs/CARTRIDGE_DEVELOPER_GUIDE.md`) and updated root `README.md`. | TSK-007, GAP-008 |
| 2026-09-20 | Gemini | Executed and completed TSK-003: updated `packages/control-plane/src/catalog.ts` and `app.ts` to natively discover and parse unified `cartridge.yaml` manifests, added pre-built OCI image bypass for deployments, and added unit tests in `catalog.test.ts`. | TSK-003, GAP-002, GAP-003 |
| 2026-09-20 | Gemini | Executed and completed TSK-006: aligned `POSITION_PAPER.md` with the production Egress Gateway pattern and run token injection model, removing inaccurate references to localhost Envoy sidecars. | TSK-006, GAP-006 |
| 2026-09-21 | Antigravity (Opus 4.6) | Comprehensive audit against three stated goals (trivial agent building, HITL governance, full observability) plus headless architecture principle and execution readiness. Five parallel deep-dive reviews covering every source file, test, Terraform module, Dockerfile, and design document. Discovered and logged 16 new gaps (GAP-009 through GAP-024). Key findings: (1) AWS landing zone has a critical network isolation breach that breaks the position paper's core premise, (2) GCP landing zone is dead code that crashes on boot, (3) Quality metrics are entirely absent from the ledger despite being a stated mandate, (4) Kernel cloud-agnosticism is violated by unconditional AWS imports in app.ts. Composite score: 76/100 (B). Full scorecard in audit artifact. | GAP-009 through GAP-024 |
| 2026-09-21 | Gemini | Executed and completed TSK-008: removed tracked `.envrc` containing private account ID and profile, added `.envrc` to `.gitignore`, added `.envrc.example` template, eliminated hardcoded AWS account fallback in `ecs.ts` and `codebuild.ts`, and updated `README.md` to reference standard `AWS_ACCOUNT_ID`. | TSK-008, GAP-015 |
| 2026-09-21 | Gemini | Executed and completed TSK-009: introduced `DeployProvider` interface in `runtime.ts`, created `awsDeployProvider` and `gcpDeployProvider`, removed all cloud imports from `app.ts`, and wired dynamic provider resolution in `index.ts`. | TSK-009, GAP-014 |
| 2026-09-21 | Gemini | Executed and completed TSK-010: restored strict agent network isolation on AWS by removing default IGW route, deleting blanket internet egress rule, and setting `FACTORY_ECS_ASSIGN_PUBLIC_IP: "false"`. | TSK-010, GAP-009 |
| 2026-09-21 | Gemini | Executed and completed TSK-011: implemented `GcsCheckpointSink` for `gcs://` and `gs://` URIs in `@beercanlabs/factory-ledger`, resolving control plane crash on GCP boot and verifying with unit tests. | TSK-011, GAP-011 |
| 2026-09-21 | Gemini | Executed and completed TSK-012: implemented `gcs://` and `gs://` mind synchronization in `@beercanlabs/factory-hydrate`, ensuring agent persistence on Google Cloud. | TSK-012, GAP-012 |
| 2026-09-21 | Gemini | Executed and completed TSK-013: implemented `gcpSecretManagerProvider` in `@beercanlabs/factory-secrets-bind` and wired `FACTORY_SECRETS_GCP_PROJECT`, verified with unit tests. | TSK-013, GAP-013 |
| 2026-09-21 | Gemini | Executed and completed TSK-014: added `limit` and `offset` pagination to `GET /api/v1/runs` and `GET /api/v1/ledger` endpoints with unit test coverage. | TSK-014, GAP-019 |
| 2026-09-21 | Gemini | Executed and completed TSK-015: removed obsolete `blueprints/docker/docker-compose.yml` and `.env.example`, replacing with superseded pointer to canonical `landing-zones/compose`. | TSK-015, GAP-021 |
| 2026-09-21 | Gemini | Executed and completed TSK-016: implemented authenticated `GET /api/v1/metrics` and `GET /metrics` endpoints exposing active runs, agent states, ledger status, and spend. | TSK-016, GAP-024 |


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
   - **First, cite what already applies.** Before proposing any new rule or design, the AI names the existing invariants (§6) and the user's recorded decisions (§7) that bear on it. If an existing invariant already covers the case, the work is to register and fix the violation, not to add a rule. A proposal that contradicts a recorded decision says so explicitly and asks.
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
| **GAP-025** | **Agent Memory Architecture** | Referenced by TSK-019 but never registered: cartridges must keep memory in local SQLite under `$MEMORY_DIR`, synced only by the Console shim (§6.6). | High |
| **GAP-026** | **Egress Rule Under-Specified** | §6.3 named only `anthropic`/`openai`, so sessions treated other egress (Bedrock, S3, xAI) as out of scope. `1e55aa7` forced agents through a proxy their SDKs could not authenticate to, breaking all Bedrock calls on AWS from 2026-09-26; a later session proposed bypassing the gateway to fix it. Resolved in intent by §6.3.1 (E1–E6). | Critical |
| **GAP-027** | **Cartridges Use Cloud SDKs** | 8 of 9 `SM-*` cartridges import `boto3` for Bedrock inference and S3 memory, violating §6.6 and E5. TSK-019 was marked `COMPLETED` while this was untrue. Model calls from these cartridges are not metered or ledgered. | Critical |
| **GAP-028** | **No Enforcement of This Document** | CI red on every push since 2026-09-26 (console `TS2367` stops `npm test` at build), core `control plane` test suite `describe.skip` since 2026-09-19 (26/35 fail when enabled: stale fixtures), no branch protection on `main`. Nothing machine-checks any invariant here. | Critical |
| **GAP-029** | **Deploy Pipeline Diverges From Production** | `submind-aws/scripts/aws-deploy.sh` would destroy console and garrison (image vars unset), fails re-running bootstrap, and applies new image tags before building them; production runs `:latest` images registered by hand, so no commit maps to what is running. | High |
| **GAP-030** | **Warm-Down Hot Loop** | `SM-*` warm-down loops ignore the mailbox `done` signal and retry instantly on errors, spinning against the control plane for up to an hour per agent (2026-09-27: three agents drove control-plane CPU from ~1% to ~100%, starving gateway ledger writes). | High |
| **GAP-032** | **Automatic Egress Grants** | `1e55aa7` made the control plane write cartridge-derived routes/hosts plus an `anthropic`/`openai` fallback and the landing-zone `FACTORY_EGRESS_HOSTS` into each agent's policy at registration and at every run start, overwriting admin-set policy. Any agent had model access with no admin decision and no budget, contradicting SPEC.md (deny-by-default, admin-set). Caught by the compose proof on 2026-09-27. | Critical |
| **GAP-033** | **Deploy Role Trusted the Public Repo** | The production `factory-deploy` IAM role trusted GitHub OIDC tokens from `repo:BeerCanLabs/agent-factory:*` (any branch of this public repo) and not the ops repo `submind-aws`, so ops deploys could never assume it while any `agent-factory` branch could. Code said `refs/heads/main` (hand-edited drift); the bootstrap defaulted `github_repo` to this repo. | Critical |
| **GAP-034** | **Agents Baked Into the Platform** | `ea77328` (2026-09-22, inside an unrelated fix) copied the fleet cartridges into `agent-factory/agents/`, and the control-plane image bakes that folder in (`COPY agents`). Production agents exist only because of that copy, bypassing registration. Violates L2. | Critical |
| **GAP-035** | **No Admission Gate** | Registration runs no checks: no pinned commit, no build, no tests, no design-rule checks. The CodeBuild agent builder clones the latest commit. Violates L3. | Critical |
| **GAP-036** | **Unpinned, Hand-Pushed Agent Images** | Agent images are `factory-dynamic-agents:<agent>`, a mutable tag, pushed by hand from a workstation seconds after each commit (2026-09-25); nothing records which commit runs. Violates L4. | High |
| **GAP-037** | **No Agent Roles or Version Flow** | No agent-owner or policy-owner roles (only admin/operator/viewer/ingest/gateway/approver), no ownership of agents, no "new version available" or approval flow. Violates L4/L5. | High |
| **GAP-038** | **No Public Agent Template** | The template lives in a private `SM-template` repo (a private naming convention), with the admission requirements undocumented for builders. Violates L6. | Medium |
| **GAP-039** | **Test Fixtures Treated as Agents** | `echo-agent` and `llm-summarizer` sit in `agents/examples/` and appear as agents (echo as built-in since `7db369f`); the compose proof and the AWS definition of done depend on them being in the catalog. | Medium |
| **GAP-040** | **Pre-flight Reads Gateway-Held Keys** | The S1 pre-flight (`0813cb9`) binds every required secret at wake, including provider keys (`ANTHROPIC_API_KEY`) that the landing zone deliberately denies the control plane (`NeverProviderKeys`). Agents declaring one (finley, higgins) would get 412 on every wake. | High |
| **GAP-041** | **No Factory Model API** | Agents call providers directly in provider-specific formats (cloud SDK calls to one cloud's model service, direct calls to another provider) with model IDs hardcoded in agent code; nothing lets operations choose or substitute models, and none of those calls are metered. Violates M1–M3. | Critical |
| **GAP-042** | **Production Images Not Built by CI** | CI never built the production Dockerfiles, and there was no `.dockerignore`, so local builds shipped whatever `dist/` and `node_modules` were on disk. The control-plane Dockerfile compiled `keymaster` before its dependency `ledger`; hand-built images passed only because of stale local output. Found by the first CI deploy (2026-09-28). | High |
| **GAP-043** | **Concurrent Ledger Writers** | Rolling control-plane deploys ran old and new tasks side by side, both appending to the same ledger file on shared storage, tearing and interleaving rows (likely the cause of earlier ledger null-byte, checkpoint-fork, and verification fixes). The production ledger fails verification at seq 288148; the loader also silently skips corrupted rows. Found by the first CI deploy (2026-09-28). | Critical |
| **GAP-044** | **Agents Hold OAuth Grants and App Secrets** | Agents carry OAuth tokens and app client secrets as environment secrets and refresh them themselves; rotated tokens were lost on restart (Donna's health skill kept them only in /tmp), and an app client secret and a shared Notion token were hard-coded in agent repos (Notion exposed publicly via SM-rosie; revoked and rotated 2026-09-28). When consent broke, an agent asked the user to run a script. Violates K1–K4. | Critical |
| **GAP-045** | **No Secret Scanning** | Nothing refuses a repository that hard-codes a credential: not admission, not CI. | High |
| **GAP-046** | **Credentials Are Supplied by Hand** | Agents declare only secret names; the factory cannot tell an owner which credentials are outstanding, how to create them, or accept them safely, so operators store values with CLI commands (the OAuth client, the Notion token). Violates K5. | High |
| **GAP-047** | **No Alerting Design** | The factory has no designed way to notify a person when something needs them (an outstanding credential, a re-consent, a refused admission, a crash). Undesigned; not yet an invariant. | Medium |
| **GAP-048** | **Re-registration Resets Policy** | Re-registering an existing agent replaces its policy with the global default (no routes), discarding what the policy owner set; found deploying Donna 2026-09-28. | High |
| **GAP-049** | **Admission Builds Pull Anonymously from Docker Hub** | Admission builds pull base images anonymously from Docker Hub from CodeBuild's shared addresses and are refused at the pull limit (429); worked around per agent (SM-donna #6) instead of in the platform. | Medium |
| **GAP-050** | **Infrastructure Creates Secrets** | The AWS landing zone creates secret entries and values, violating K1 and K5 (the Keymaster owns and creates credentials): (a) it creates an empty entry for each gateway-held provider key, so moving `NOTION_API_KEY` to the gateway collided with the existing entry, and the Keymaster could neither create nor supply platform keys; (b) it generates the platform's own tokens (`FACTORY_TOKEN`, `GATEWAY_TOKEN`, `DOORMAN_*`, `FACTORY_RUN_TOKEN_KEY`, `FACTORY_CALLBACK_SIGNING_KEY`, `FACTORY_TOKENS`, `ECHO_WEBHOOK_SECRET`) with their plaintext values in Terraform state. (b) needs a design decision with the user (bootstrap by the Keymaster; rotating every platform token). Open question: whether the landing zone should grant secret access at all, or the Keymaster. | Critical |
| **GAP-051** | **Invariants Without Complete Checks** | §6.7 requires every machine-checkable invariant to name its test, but most are unchecked or only partly checked, so CI passes code that violates them (GAP-048 and GAP-050 passed every gate). The coverage table in §6.7 lists each one; an independent audit proposes the checks to add. | High |
| **GAP-052** | **Operator Identity Is Asserted, Not Verified** | Violates A1 and A2. The control plane grants roles from the `cf-access-authenticated-user-email` header without verifying `cf-access-jwt-assertion` (`packages/control-plane/src/app.ts`, `authenticate` and `authenticateOperatorOrRun`); an admin email in the header grants admin. The AWS load balancer accepts 443 and 80 from `0.0.0.0/0`, so anyone who finds it skips Cloudflare Access and can set that header; the deploy's definition-of-done checks rely on this, calling the load balancer directly. The console proxies every request with `FACTORY_TOKEN`. Confirmed live 2026-09-29: a forged header with a non-admin email got 200 on `/api/v1/agents`. | Critical |
| **GAP-031** | **Agents Hold Real Secrets** | ECS task definitions inject real secret values into agent containers (e.g. Discord bot tokens, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, GitHub tokens, a username/password pair, GCP service-account JSON), violating S1. Since `6256fac` (2026-09-20) the control plane skips secret binding for non-local runtimes, so it neither pre-flights them (no 412) nor knows their values to redact them from results and the ledger. | Critical |

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
| **TSK-017** | GAP-008 | Align Cartridge Documentation Across Agent Factory & Templates | `COMPLETED` | *None* (Released) | `SPEC.md`, `docs/CARTRIDGE_DEVELOPER_GUIDE.md`, `DESIGN_AUTHORITY.md`, `SM-template/*`, `SM-rosie/README.md` | Documented unified cartridge.yaml alongside legacy manifest in SPEC.md, added runtime.warmDownSeconds, skills, and /mailbox long-polling pattern to Developer Guide and API table, aligned SM-template blueprint and verified contract. |
| **TSK-018** | GAP-009 | Base URL Reverse Proxy Egress & Discord Route Integration | `COMPLETED` | *None* (Released) | `packages/gateway/*`, `packages/hydrate/*`, `packages/control-plane/*`, `landing-zones/aws/*`, `docs/*`, `SPEC.md`, `DESIGN_AUTHORITY.md` | Re-sealed agent network perimeter (zero public IPs, zero IGW route), added reverse proxy discord route to gateway with per-agent credential injection, injected DISCORD_BASE_URL via gatewayEnv and runEnv, updated cartridge documentation. |
| **TSK-019** | GAP-025 | Fleet-Wide Private Agent Memory Architecture & Optimization | `REOPENED` (2026-09-27, see GAP-027: `boto3` still present in 8 cartridges) | *None* (Released) | `SM-template/*`, `SM-*/*`, `docs/CARTRIDGE_DEVELOPER_GUIDE.md`, `tests/*`, `DESIGN_AUTHORITY.md` | Standardized "Notebook & Safe" pattern across all 9 agents and SM-template. Purged cloud SDKs (boto3) from cartridges; cartridges write to local SQLite ($MEMORY_DIR) with WAL mode, busy_timeout=5000, 14-day history pruning, and PRAGMA wal_checkpoint(TRUNCATE) on shutdown. Sync is handled exclusively by Factory Console shim. Verified with automated regression tests. |
| **TSK-020** | GAP-028, GAP-026 | Enforce this document: green CI, conformance tests for E1–E6, branch protection, AI pre-commit hook | `COMPLETED` | *None* (Released) | `DESIGN_AUTHORITY.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/workflows/ci.yml`, `package.json`, `packages/conformance/*` (new), `packages/console/src/views/FleetView.tsx`, `packages/console/src/api/types.ts`, `packages/control-plane/src/index.test.ts`, `packages/control-plane/test-fixtures/*`, `.claude/settings.json` (new), `scripts/conformance-hook.sh` (new), `packages/control-plane/src/app.ts` (lock expanded 2026-09-27 with user approval: budget-alert ordering regression from `bccb50c`, run timeout, S1 redaction backstop + pre-flight for all runtimes with a secret-value cache); `llm-summarizer` un-retired as a user example agent (compose proof of deny-by-default, budget, kill switch); further expanded 2026-09-27 with user approval: `packages/control-plane/src/catalog.ts`, `packages/contract/src/schema.ts`, `agents/examples/echo-agent/cartridge.yaml`, `packages/control-plane/src/catalog.test.ts`, `packages/control-plane/src/gateway.e2e.test.ts`, `.githooks/*` (new; git pre-push conformance for every tool incl. Gemini), `README.md` (un-retire `echo-agent` as a built-in diagnostic agent; it is the self-test for the compose proof and the deploy definition of done); GitHub branch protection on `main` | Done: CI green on `main` (`test`, `compose-proof`); no skipped tests; `packages/conformance` checks E1–E7, S1, DA integrity, console/control-plane contract, each negative-tested; `main` protected (PR required, both checks required and up to date, enforced for admins, no force-push/deletion); git pre-push hook (all tools incl. Gemini) and Claude hooks (project + user level) run conformance. |
| **TSK-021** | GAP-041, GAP-026 | Factory model API (M1–M4): OpenAI Chat Completions format at the gateway; operations-configured provider/model catalog; policy maps an agent's preferred model to an offered model; per-provider translation adapters with uniform metering; builder documentation | `PENDING` (next) | *None* | TBD at lock | An agent written once runs against any offered provider; every call metered and ledgered the same way. (`ae96332` allowlist already removed by TSK-025.) |
| **TSK-022** | GAP-029 | Make the committed deploy match production and be the only deploy path | `PENDING` (after TSK-020) | *None* | `submind-aws/scripts/*`, `submind-aws/.github/workflows/*` | SHA-tagged images only; build before apply; console/garrison preserved; bootstrap opt-in; DoD proves a gateway-metered model call. |
| **TSK-023** | GAP-030 | Warm-down loop exits on `done` and backs off on errors | `PENDING` | *None* | `SM-template/*`, `SM-*/*` | Loop cannot spin; covered by a test in `SM-template`. |
| **TSK-025** | GAP-032, GAP-026, GAP-027 | Strict deny-by-default (E7): remove automatic policy grants at registration and run start; remove `FACTORY_EGRESS_HOSTS` (the `ae96332` Bedrock/mind-bucket tunnel allowlist) | `COMPLETED` | *None* (Released) | `DESIGN_AUTHORITY.md`, `packages/control-plane/src/app.ts`, `packages/control-plane/src/index.ts`, `packages/control-plane/src/index.test.ts`, `packages/control-plane/src/registry.e2e.test.ts`, `packages/contract/src/schema.ts`, `landing-zones/aws/ecs.tf`, `packages/conformance/*` | Done: registration and run start no longer write policy; `deriveEgress` reports requests only; tunnel allowlist and its E5/M1 baseline entries removed. E7 regression tests fail if a grant is reintroduced. Compose proof 11/11 green locally, 206 tests pass. |
| **TSK-026** | GAP-033 | Deploy role trusts only the ops repo's `main`: bootstrap `github_repo` becomes required (no default); BeerCanLabs applies it with `BeerCanLabs/submind-aws` | `COMPLETED` | *None* (Released) | `DESIGN_AUTHORITY.md`, `landing-zones/aws/bootstrap/main.tf`, `landing-zones/aws/README.md` | Live trust = `repo:BeerCanLabs/submind-aws:ref:refs/heads/main` (applied by the user); no repo default in this reference. |
| **TSK-027** | GAP-035, GAP-036 | Admission gate and pinned deploys (L3, L4): register repo@commit; build via the deploy provider; run the agent's tests; validate cartridge and design rules; ledger refusals; images tagged by SHA; deploy only admitted commits | `PENDING` (after TSK-021) | *None* | TBD at lock | Registration refuses a cartridge without tests or with a cloud SDK; deploys use `@sha` images. |
| **TSK-028** | GAP-037 | Agent roles and version flow (L4, L5): agent-owner and policy-owner roles, agent ownership, "new version available", approve or policy-based auto-deploy | `PENDING` (after TSK-027) | *None* | TBD at lock | Roles enforced; new commits re-admitted and awaiting approval. |
| **TSK-029** | GAP-038 | Public agent template (L6) in `agent-factory` with a passing test, the Notebook & Safe pattern, and admission requirements in `docs/CARTRIDGE_DEVELOPER_GUIDE.md`; then archive `SM-template` | `PENDING` | *None* | TBD at lock | Template passes admission; `SM-template` archived (user approved 2026-09-27). |
| **TSK-030** | GAP-039 | Move echo and summarizer to `test-fixtures/`; remove the `category: builtin` workaround; deploy definition of done registers a test cartridge through L3–L4 | `PENDING` (with TSK-027) | *None* | TBD at lock | No fixture in any agent list; compose proof and deploy DoD green. |
| **TSK-031** | GAP-034 | Migrate the fleet: each agent repo passes admission (drops `boto3`, has tests, TSK-023 loop fix), is registered through the factory and deployed; then delete `agent-factory/agents/` and the `COPY agents` step | `PENDING` (after TSK-021, TSK-023, TSK-027..030) | *None* | TBD at lock | Agents run only via registration; platform repo holds no agents. |
| **TSK-032** | GAP-040 | Pre-flight treats gateway-held provider keys as satisfied (never read by the control plane; agents receive the run token in their place) | `COMPLETED` | *None* (Released) | `DESIGN_AUTHORITY.md`, `packages/control-plane/src/app.ts`, `packages/control-plane/src/index.ts`, `packages/control-plane/src/index.test.ts`, `landing-zones/aws/ecs.tf` | Agents declaring a provider key pass pre-flight; the control plane never requests its value. |
| **TSK-033** | GAP-042 | Production images build from a clean checkout in CI: fix control-plane build order, add `.dockerignore`, build all production Dockerfiles in the required `compose-proof` job | `COMPLETED` | *None* (Released) | `DESIGN_AUTHORITY.md`, `packages/control-plane/Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml` | All six production images build from a clean clone; CI fails if any does not. |
| **TSK-034** | GAP-043 | Single ledger writer (LG1): exclusive renewed ledger lease in the control plane (second instance refuses to start); AWS landing zone deploys the control plane stop-then-start; conformance check | `COMPLETED` | *None* (Released) | `DESIGN_AUTHORITY.md`, `packages/ledger/src/*`, `packages/ledger/package.json`, `packages/control-plane/src/index.ts`, `landing-zones/aws/ecs.tf`, `packages/conformance/src/*` | A second control plane cannot write the ledger; deploys never overlap. |
| **TSK-035** | GAP-043 | Ledger recovery (LG2): archive a failed ledger unchanged; start a new segment chained to the last verified checkpoint with a recovery entry; stop silently skipping corrupted rows; run once on production | `LOCKED` | Claude (Opus 5.5) - 2026-09-28 | `DESIGN_AUTHORITY.md`, `packages/ledger/src/*`, `packages/ledger/package.json`, `packages/control-plane/src/index.ts`, `landing-zones/aws/ecs.tf`, `landing-zones/aws/variables.tf` | Production ledger verifies; archived segment preserved; recovery recorded. |
| **TSK-036** | GAP-044 | Keymaster OAuth connections (K1–K4), first provider Google: cartridge `connections`, factory consent flow and callback, grant storage scoped agent × provider × scopes, Keymaster refresh, gateway token injection on Google routes, "needs re-consent" handling; migrate Donna's Calendar/Gmail/Drive and health (Google Health API, replacing the Fitbit Web API) to it | `LOCKED` | Claude (Opus 5.5) | PR #21 files (merged `ec6425d`); live-verification fixes: `packages/secrets-bind/src/{index,index.test}.ts`, `DESIGN_AUTHORITY.md` | Donna's Google access works with no Google credential in her container; consent and reconnect happen only in the factory. |
| **TSK-037** | GAP-045 | Secret scanning in the admission gate and in agent-factory CI | `COMPLETED` | *None* (Released) | `scripts/secret-scan.sh`, `landing-zones/aws/codebuild.tf`, `packages/control-plane/src/{runtime,aws/codebuild}.ts`, conformance | A repository with a hard-coded credential is refused at registration; CI fails on one. |
| **TSK-038** | GAP-046 | Keymaster credential facilitation (K5): typed credential declarations in the cartridge, outstanding-credential API per agent, approved instruction catalog, write-only secret submission, dashboard credentials page (Garrison later on the same API); credentials declared once and usable by several agents, gated per agent by policy | `COMPLETED` | *None* (Released) | `packages/contract/*`, `packages/keymaster/*`, `packages/control-plane/src/{credentials,connections,catalog}*.ts`, `packages/control-plane/src/app.ts` (credential routes hook and registration only), `packages/control-plane/package.json` (test script), `packages/secrets-bind/src/*`, `packages/ledger/src/{sanitize.ts,index.test.ts}`, `packages/console/*`, `packages/conformance/src/keymaster.test.ts`, `DESIGN_AUTHORITY.md` (own rows), `landing-zones/aws/iam.tf` (Keymaster write permission) | An owner can bring a newly registered agent to zero outstanding credentials from the dashboard or the API alone, without a CLI, and no value is ever shown back. Done: typed `secrets.requires` (`source`, `description`); instruction catalog in `packages/keymaster/src/catalog.ts` (10 AI-drafted entries, all `approved: null`, shown with a pending-review label); `GET/POST /api/v1/keymaster/agents/:id/credentials[/:name]` and `GET /api/v1/keymaster/outstanding`; secrets-bind `has`/`secretPresent`; ledger `credential` field (`CREDENTIAL_SET`/`CREDENTIAL_ROTATED`); console Credentials view and fleet counts; consent success page links back to the console. Conformance: submit handler never echoes, logs, or ledgers the value. |
| **TSK-039** | GAP-031 | First slice of TSK-024: Notion through the gateway. A `notion` route injects the shared `NOTION_API_KEY`; agents get `NOTION_BASE_URL`; the key is no longer injected into any agent container; every agent Notion skill uses the route; `api.notion.com` leaves agent host allowlists. 2026-09-28: code in review (agent-factory and the eight `SM-*` PRs): `notion` http route (Bearer injection, run token stripped); `NOTION_API_KEY` gateway-held via `provider_secret_names`, so it is dropped from agent task definitions (`aws/ecs.ts`, `aws/iam.ts`, terraform `var.agents`) and pre-flight skips it; hydrate sets `NOTION_BASE_URL`; the gateway no longer falls back to `DISCORD_BOT_TOKEN` for another route's unbound credential. Open until merged and the operator steps (secret import, policies, agent redeploys) are done and one Notion call is seen in the ledger | `LOCKED` | Claude (Opus 5.5) agent A - 2026-09-28 | `packages/gateway/*`, `packages/hydrate/src/*`, `packages/control-plane/src/aws/*`, `landing-zones/aws/{variables,ecs,iam}.tf`, `packages/control-plane/package.json` (test list), `packages/conformance/baseline.json`, `DESIGN_AUTHORITY.md` (own rows), Notion skill and cartridge in `SM-{archie,castle,donna,finley,geordi,higgins,rosie,switch}` | No agent container receives the Notion key; agent Notion calls succeed through the route and are ledgered; rotating the key touches no agent. |
| **TSK-040** | GAP-048 | Re-registration keeps the policy the policy owner set (only a first registration gets the default) | `COMPLETED` | *None* (Released) | `packages/control-plane/src/app.ts` (registration only), its tests | Re-registering an agent with a policy leaves the policy unchanged. Done: registration applies the global default only when the agent has no policy; test in `registry.e2e.test.ts`. |
| **TSK-041** | GAP-050 | (a) Terraform stops owning gateway-held provider keys (released from state, never deleted); access policies built from names; the control plane may create and write them but never read them; the Keymaster reports them from metadata and accepts them through its write-only channel; conformance forbids secret resources in landing zones ((b) baselined until designed) | `LOCKED` | Claude (Opus 5.5) | `landing-zones/aws/{secrets,iam,outputs}.tf`, `packages/secrets-bind/src/*`, `packages/keymaster/src/credentials*.ts`, `packages/control-plane/src/{credentials,credentials.e2e.test}.ts`, `packages/console/src/{views/CredentialsView.tsx,api/*}`, `packages/conformance/*`, `DESIGN_AUTHORITY.md` | Deploying needs no manual state step; an admin can supply a missing platform key from the dashboard; no landing zone declares a new secret resource. |
| **TSK-042** | GAP-051 | Invariant coverage table in §6.7, enforced by `coverage.test.ts`; AI protocol step: cite existing invariants before proposing a rule; independent audit of all repos | `LOCKED` | Claude (Opus 5.5) | `DESIGN_AUTHORITY.md`, `packages/conformance/src/coverage.test.ts`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` | CI fails when an invariant lacks a row or a real test; audit findings are registered as gaps. |
| **TSK-043** | GAP-052 | A1 on AWS: the load balancer accepts 443 and 80 only from `var.ingress_cidrs` (required; `/0` refused), set by the ops repo to Cloudflare's published ranges; conformance forbids `/0` ingress in the AWS landing zone; `submind-aws` deploy checks go through Cloudflare with an Access service token and prove the load balancer refuses a direct connection | `COMPLETED` | *None* (Released) | `landing-zones/aws/{variables,network,alb}.tf`, `packages/conformance/src/ingress.test.ts`, `DESIGN_AUTHORITY.md`; in `submind-aws`: `config/deploy.env`, `scripts/aws-deploy.sh`, `.github/workflows/deploy.yml`, `upstream/agent-factory` | Done 2026-09-29: deployed with `submind-aws` #10 (run 36537203831, green). Verified independently: direct connections to the load balancer on 443 and 80 time out; anonymous requests via Cloudflare get the Access login. |
| **TSK-044** | GAP-052 | A2: verify the Cloudflare Access JWT (issuer `beercanlabs.cloudflareaccess.com`, application audience) and take identity only from it; remove the bare-header path in `authenticateOperatorOrRun`; the console stops adding `FACTORY_TOKEN` to callers' requests | `LOCKED` | Claude (Opus 5.5) - 2026-09-29 | `packages/auth/{package.json,src/index.ts,src/access.ts,src/access.test.ts}`, `packages/control-plane/{package.json,src/app.ts,src/index.ts,src/access.e2e.test.ts}`, `packages/console/{package.json,server.ts,server.test.ts,src/auth/CloudflareAuth.tsx}`, `packages/conformance/src/access.test.ts`, `landing-zones/aws/{variables,ecs}.tf`, `landing-zones/aws/README.md`, `DESIGN_AUTHORITY.md` | A forged identity header grants nothing; a valid Access assertion maps to the same roles as today. |
| **TSK-045** | GAP-031 | Next TSK-024 slices: github, motion, closing-climb routes; factory spend read for finley; agent deploy IAM fix. `github` route injects the calling agent's own `{AGENT}_GITHUB_TOKEN` with no shared fallback (per-route `credential.fallback: false`; omitted keeps today's fallback, so discord is unchanged); `motion` injects the gateway-held `MOTION_API_KEY` (K5.5) as `x-api-key`; `extra_gateway_routes` / `extra_provider_secret_names` carry deployment-specific routes (closing-climb, later home-assistant) so the public repo holds no private URLs; hydrate exports `GITHUB_BASE_URL`, `MOTION_BASE_URL`, `CLOSING_CLIMB_BASE_URL`, `HOME_ASSISTANT_BASE_URL`; `GET /api/v1/spend` returns per-agent model spend (day/month, USD, calls, tokens, by model) to a viewer or to a live run whose admin-set policy has `tools.factory-spend` (E7), ledgered as `SPEND_READ`; the landing zone's `iam:DeleteRolePolicy` grant matches the `AgentExecutionRole-*` names the control plane creates, and a just-created role is not revoked. Approved by Dale in chat 2026-09-29. | `LOCKED` | Claude (Opus 5.5) - 2026-09-29 | `packages/gateway/{package.json,src/gateway.ts,src/routes.test.ts}`, `packages/hydrate/{package.json,src/gateway-env.ts,src/gateway-env.test.ts}`, `packages/control-plane/{package.json,src/app.ts,src/policy.ts,src/spend.e2e.test.ts,src/aws/iam.ts,src/aws/iam.test.ts}`, `landing-zones/aws/{variables.tf,iam.tf,ecs.tf,outputs.tf}`, `DESIGN_AUTHORITY.md` | Additive: existing routes, the Doorman, run lifecycle, secret delivery for existing agents and auth unchanged; existing tests unchanged and green. |
| **TSK-024** | GAP-031 | Convert every cartridge secret to gateway injection (S1): header-based secrets first, then exchange routes for key files and form logins | `PENDING` | *None* | `packages/gateway/*`, `packages/control-plane/*`, `landing-zones/aws/*`, `SM-*/*` | No agent task definition carries a real secret value. |











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
* **Network & Gateway Security:** See the egress invariants below. They apply to every provider and every cloud; there are **no exceptions**.

#### 6.3.1 Egress Invariants (each has a conformance test, §6.7)
* **E1 – Single egress path.** Every outbound connection from cartridge code goes through the Factory Egress Gateway. No exceptions, including cloud-provider APIs. An agent's `NO_PROXY` may contain only loopback, `.internal` service discovery, and the link-local metadata/credential addresses.
* **E2 – Run attribution.** Every gateway request carries the run's short-lived token; requests without a valid, live run token are rejected.
* **E3 – Ledgered.** Every egress request or tunnel writes a ledger row (agent, run, route or host, allow/deny decision) — never prompt bodies or secrets.
* **E4 – Gated before forwarding.** The gateway enforces policy (routes, hosts, models), budget, pause/isolate/kill switch, and approvals before any byte leaves.
* **E5 – Every model call is metered.** Agents may use any model provider (Anthropic, OpenAI, AWS Bedrock, xAI, …), but every model call goes through a gateway **provider route** so tokens and cost are metered and ledgered. A cloud model service (e.g. Bedrock) is a gateway upstream configured by the landing zone; the gateway holds the cloud credentials, cartridges never do. A generic CONNECT tunnel is **not** an acceptable path for model calls, because it cannot meter tokens or cost.
* **E7 – Deny by default.** An agent with no admin-set policy has no egress. The control plane never grants routes, hosts, models, or budgets on its own (not at registration, not at run start). Only explicit admin actions change a policy: `PUT /api/v1/agents/:id/policy`, model approval, and the global policy. A cartridge's declared egress is a *request* shown to the admin, not a grant.
* **E6 – Network-enforced.** Agent subnets have no internet or NAT route. Platform traffic that is not cartridge code (image pulls, logs, the shim's memory sync) may use private cloud endpoints.

#### 6.3.2 Secrets Invariant
* **S1 – Agents never hold real secrets.** A cartridge's declared secrets are delivered to it only as placeholders (its run token). The gateway injects the real credential into the matching outbound request, based on the route or host the secret is declared for. Secrets that must be used locally (key files for signing, form logins) get a gateway-side exchange route instead, added per secret under a task; until a secret is converted it is listed in the Gap Register. As a backstop, the control plane and gateway redact every known secret value from results and ledger rows, for every runtime; the control plane caches secret values so this does not add a vault lookup per wake.

### 6.4 Two-Stage Agent Retirement Lifecycle (Zero Ongoing Cost Guarantee)
* **Objective:** Guarantee that retired agents incur strictly $0 in continuing cloud costs while providing safety against accidental operational destruction.
* **Stage 1: Soft-Retirement / Scream Test (`RETIRED_PENDING_PURGE`):**
  - All ingress triggers, Doorman presence gateways, and compute wakes are immediately cut. Compute drops to 0 replicas.
  - Secret bindings and persistent memory remain in place.
  - An administrative holding period (configurable, default: 1 calendar week) begins.
  - An operator can invoke `POST /api/v1/registry/agents/:id/reinstate` during this period to restore the agent to production.
* **Stage 2: Permanent Purge & Archival (`RETIRED`):**
  - Triggered after the holding window expires or via administrative override (`POST /api/v1/registry/agents/:id/purge`).
  - Cloud task definitions and compute services are deleted.
  - Secrets are permanently destroyed/purged from the enterprise vault.
  - Persistent mind storage is compressed and archived into cold tier object storage.
  - Immutable execution ledger rows remain permanently preserved.

### 6.5 Headless Observability & GraphQL Telemetry Surface
* **Strict Separation:** The Factory kernel never builds UI dashboards, formats PDF reports, or renders email summaries. It strictly captures structured data and serves it via headless APIs.
* **Core Metrics Pillars:** Cost (USD spend, token burn), Quantity (task throughput, turns, duration), Quality (deterministic benchmark pass rates, regression ledger).
* **API Surface Division:**
  - **REST:** Discrete operational actions (`/runs`, `/wake`, `/pause`, `/metrics`).
### 6.6 Agent Memory Architecture ("The Notebook & Safe")
* **Separation of Concerns:**
  - **Cartridge (The Employee):** Strictly reads and writes to local embedded files (SQLite) in `$MEMORY_DIR` (`<agent>_state.db`). Cartridges **never** import cloud SDKs (`boto3`, `@google-cloud/storage`, Azure Blob SDK) and never know about cloud storage buckets.
  - **Console (The Building Safe):** Handled transparently by `packages/hydrate/src/shim.ts`. On wake, the Console pulls remote mind storage (`s3://...` / `gs://...`) into `$MEMORY_DIR`. On sleep/exit, the Console pushes `$MEMORY_DIR` back to the remote mind bucket.
* **SQLite Storage Engine Standards:**
  - **WAL Mode:** Every cartridge SQLite database must execute `PRAGMA journal_mode=WAL;` and `PRAGMA busy_timeout=5000;` on connection.
  - **Single-Writer Clean Checkpointing:** Cartridges execute `PRAGMA wal_checkpoint(TRUNCATE)` in their shutdown/exit cleanup (`finally:` block). This collapses the `-wal` and `-shm` write-ahead logs into the primary `.db` file, guaranteeing clean, atomic object storage synchronization without lock artifacts.
  - **Rolling Retention Pruning:** Raw chat turns and audit entries must have rolling retention (default 14 days) pruned automatically on wake to prevent boundless context database growth. Permanent knowledge (entities, facts, operational logs) is retained indefinitely.
* **Private Agent Memory Isolation:**
  - Cartridge memory is **strictly private** to each agent. Agents never share SQLite databases or object storage mind prefixes.
  - Cross-agent collaboration and knowledge sharing is strictly conducted via the MCP Ingress Gateway (`talk_to_agent`), preserving encapsulation, provenance, and auditability.

### 6.7 Enforcement (This Document Is Checked by Machines)
* Every machine-checkable invariant in this document names its conformance test; the tests live in `packages/conformance` and run in CI.
* CI (`.github/workflows/ci.yml`) must be green to merge to `main`, enforced by GitHub branch protection. A skipped test suite counts as a failure unless it is listed in the Gap Register with an owning task.
* AI sessions run the conformance tests before any `git commit` or `git push` (Claude Code hook in `.claude/settings.json`); a failure blocks the commit.
* Deploys ship only commits on `main` with green CI, tagged by commit SHA (never `:latest`). A deploy's definition of done includes one model call proven, by its ledger row, to have gone through a gateway provider route.


#### Invariant coverage (machine-checked)

Every invariant in §6 has a row. `checked`: its tests would catch a violation. `partial`: its tests cover only what the Scope column says. `unchecked`: nothing tests it. A `partial` or `unchecked` row names the gap that owns closing it. `packages/conformance/src/coverage.test.ts` fails CI if an invariant has no row, a row names a test that does not exist or does not cite the invariant in a `describe`/`it` title, or a row that is not `checked` has no registered gap.

| Invariant | Status | Tests | Scope / limits | Gap |
| :--- | :--- | :--- | :--- | :--- |
| E1 | `partial` | `packages/conformance/src/egress.test.ts` | Only NO_PROXY and loopback exceptions; not agent code or policy hosts that route around the gateway. | GAP-051 |
| E2 | `checked` | `packages/conformance/src/egress.test.ts` | Every gateway path rejects a request without a run token. | — |
| E3 | `checked` | `packages/conformance/src/egress.test.ts`, `packages/ledger/src/index.test.ts` | Every allowed path writes an attributed ledger row. | — |
| E4 | `checked` | `packages/conformance/src/egress.test.ts` | Denied and isolated egress is refused on every path. | — |
| E5 | `partial` | `packages/conformance/src/egress.test.ts` | Only that no landing zone tunnels to a model host; not agent code calling a provider directly. | GAP-051 |
| E6 | `partial` | `packages/conformance/src/egress.test.ts`, `packages/hydrate/src/index.test.ts` | AWS landing zone only. | GAP-051 |
| E7 | `partial` | `packages/control-plane/src/index.test.ts`, `packages/gateway/src/models.test.ts` | Run start and the models route only; not every path that changes a policy (GAP-048 slipped past). | GAP-051 |
| S1 | `partial` | `packages/conformance/src/hygiene.test.ts`, `packages/control-plane/src/aws/gateway-held.test.ts`, `packages/gateway/src/gateway.test.ts` | Agent task definitions still inject secrets (baselined, GAP-031). | GAP-051 |
| M1 | `unchecked` | — | — | GAP-051 |
| M2 | `unchecked` | — | — | GAP-051 |
| M3 | `unchecked` | — | — | GAP-051 |
| M4 | `unchecked` | — | — | GAP-051 |
| L1 | `unchecked` | — | — | GAP-051 |
| L2 | `unchecked` | — | The platform repo still holds agent copies (GAP-034). | GAP-051 |
| L3 | `partial` | `packages/control-plane/src/admission.e2e.test.ts` | Control-plane behaviour with a fake builder; not the real buildspec. | GAP-051 |
| L4 | `partial` | `packages/control-plane/src/admission.e2e.test.ts` | As L3. | GAP-051 |
| L5 | `unchecked` | — | — | GAP-051 |
| L6 | `unchecked` | — | — | GAP-051 |
| LG1 | `checked` | `packages/conformance/src/egress.test.ts`, `packages/ledger/src/lease.test.ts` | Stop-then-start deploy and the lease. | — |
| LG2 | `checked` | `packages/ledger/src/segment.test.ts` | Archive and new segment, never repair. | — |
| K1 | `partial` | `packages/conformance/src/keymaster.test.ts`, `packages/conformance/src/hygiene.test.ts`, `packages/contract/src/validate.test.ts` | Google routes, hard-coded credentials, and no secret resources in any landing zone (GAP-050 part b baselined). | GAP-051 |
| K2 | `unchecked` | — | Consent flow is tested in the control plane, but no test is tied to K2. | GAP-051 |
| K3 | `partial` | `packages/keymaster/src/connections.test.ts` | Refresh and rotation with a fake provider. | GAP-051 |
| K4 | `partial` | `packages/keymaster/src/connections.test.ts` | invalid_grant only. | GAP-051 |
| K5 | `partial` | `packages/conformance/src/keymaster.test.ts`, `packages/keymaster/src/credentials.test.ts`, `packages/control-plane/src/credentials.e2e.test.ts` | Write-only path and statuses; not the dashboard. | GAP-051 |
| A1 | `partial` | `packages/conformance/src/ingress.test.ts` | AWS landing zone only; not the proxy's own configuration. | GAP-051 |
| A2 | `partial` | `packages/conformance/src/access.test.ts`, `packages/auth/src/access.test.ts`, `packages/control-plane/src/access.e2e.test.ts`, `packages/console/server.test.ts` | Control plane, console and the AWS landing zone. Not Garrison (separate repo; its task is still given `FACTORY_TOKEN`) or the proxy's own configuration. | GAP-052 |

### 6.8 Two Lifecycles: Platform and Agents
* **L1 – Platform.** Each deployment target (AWS, GCP, Azure, private cloud, …) has its own ops repository, which pins an exact `agent-factory` commit and deploys it through that repository's CI, run manually on its `main`. `agent-factory` knows nothing about any particular deployment. A platform deploy never adds, removes, or changes agents.
* **L2 – No agents in the platform repo.**
* **L3 – Admission gate.** An agent owner registers an agent by naming its repository. The factory pins the exact commit and runs the equivalent of CI against it: validate `cartridge.yaml`, build the image, run the agent's own tests (a repository without tests is refused), and check the design rules (§6.6, S1, declared secrets and egress). A failure refuses registration with the reasons, and the refusal is ledgered.
* **L4 – Gated deploy.** An agent can deploy only after a policy owner (e.g. FinOps) has set its policy and budget (E7). The deploy itself may be done by the agent's owner, an admin, or the factory under a policy that allows it. The factory deploys exactly the admitted commit, as an image tagged with its SHA, never a mutable tag.
* **L5 – New versions.** The factory notices new commits on a registered agent's repository, and changes produced by factory training, and runs each through admission (L3). A version that passes shows as "new version available". It goes live only after a person approves it, unless a person has set a policy allowing that agent's admitted versions to deploy automatically.
* **L6 – Agent template.** `agent-factory` provides the template agent builders start from, including a passing test and the admission requirements. It is documentation and scaffolding, not part of any deployed image.
* **Test fixtures** (such as the echo and summarizer cartridges) are equipment for the platform's own tests. They are not agents and never appear in a factory's agent list. A platform deploy's definition of done proves the agent lifecycle by registering a test cartridge through L3–L4, making one gateway-metered call, and retiring it.

### 6.9 Model Access
* **M1 – One factory model API.** Agents call models through the gateway using the factory's model API: the OpenAI Chat Completions request format, documented for agent builders. Agents never call a provider directly and never hold provider credentials (E1, E5, S1).
* **M2 – Preferred, not chosen.** A cartridge declares a preferred model. The model an agent actually gets is decided by policy (E7); operations may substitute any offered model without changing the agent.
* **M3 – Operations decides the offering.** Each deployment configures which providers and models its factory offers. The gateway translates the factory model API into each provider's native format and meters every call the same way, whatever the provider.
* **M4 – Native access is an exception.** An agent that genuinely needs a provider-specific feature may declare that need and use the provider's native format through the gateway, still metered and policy-gated. Such an agent is provider-dependent, and its admission shows that.

### 6.10 Ledger Integrity
* **LG1 – Single writer.** Exactly one control-plane process writes a ledger at any time, enforced twice: the control plane holds an exclusive, renewed lease on the ledger before it starts (a second instance refuses to start and says why; a lease left by a crashed instance expires after a short timeout), and every landing zone deploys the control plane stop-then-start, never side by side. A control-plane deploy therefore has a brief gap (accepted 2026-09-28); running concurrent control planes would require moving the ledger off a shared file.
* **LG2 – Never edited.** A ledger that fails verification is archived unchanged as evidence, never repaired in place. Recording continues in a new segment whose first entry chains to the last verified checkpoint and records the recovery (why, and what was archived).

### 6.11 Keymaster: Credentials That Act for a Person or an App
* **K1 – The Keymaster owns them.** OAuth grants, refresh tokens, and app client secrets are held only by the Keymaster. Agents declare the *connections* they need (provider plus scopes) in their cartridge; admission shows them; the agent never holds the credential.
* **K2 – Consent happens in the factory.** A person connects an agent to a provider through the factory. The provider redirects back to the factory; the Keymaster stores the grant scoped to agent × provider × scopes; the ledger records who granted what, and when.
* **K3 – The Keymaster refreshes; the gateway injects.** The agent calls a gateway route; the gateway obtains a current access token from the Keymaster (which refreshes and persists rotated tokens) and injects it.
* **K4 – Broken consent is reported, never worked around.** A revoked or expired grant is marked "needs re-consent"; the agent is told so and directs the person to the factory's reconnect link. Agents never ask a person to run scripts or handle credentials.
* **K5 – The Keymaster facilitates every credential an agent needs.**
  1. *Declared at registration.* An agent declares every credential it uses, each with its kind (static secret or OAuth connection), the source system it comes from, and scopes where they apply. From the declaration the Keymaster knows where the credential is stored in the secret manager and how it is obtained.
  2. *Outstanding credentials are known.* The Keymaster compares each registered agent's declarations with what is present and valid in the secret manager. A credential that is missing, lacks declared scopes, or needs re-consent is outstanding for that agent.
  3. *One flow, every surface.* The Keymaster API is the flow; the dashboard and the Garrison interface are clients of it and add no logic of their own. In each, the owner picks an agent and sees its outstanding credentials, each with instructions for creating it and a way to supply it: OAuth through a consent URL whose callback lets the Keymaster store the grant; static secrets (for example GitHub PATs, Discord bot tokens, Slack keys, API keys) through a write-only input the Keymaster writes to the secret manager. A supplied value is never displayed, echoed, logged, or ledgered; the ledger records only that it was set or rotated, by whom, and when.
  4. *Instructions come from a reviewed catalog.* The Keymaster keeps a catalog of instructions per source system, maintained by operations. Entries may be AI-drafted; a person reviews and approves each one. Until then an entry is shown to owners clearly labelled "Pending human review", never presented as approved.
  5. *Access is policy, not possession.* A credential may serve several agents (for example one workspace integration). Because agents never hold it (S1), which agents may use it is decided by factory policy (routes and agent state), not by who has the value: revoking one agent's access (pause, decommission, destroy, or removing the route) never requires rotating the credential, and rotating a credential never involves an agent.
  6. *Addressed to the agent owner* (admins until owner roles exist, TSK-027). No one is asked to run a script or to put a secret in a chat, terminal, or repository.


### 6.12 Operator Access
* **A1 – One front door.** The factory's public endpoints accept connections only from its identity-aware proxy (Cloudflare Access on AWS); the load balancer refuses all other sources. Machine callers (deploy checks, webhooks) use the same door with a service credential. No landing zone opens platform ingress to `0.0.0.0/0`.
* **A2 – Identity is verified, not asserted.** The control plane grants a role only from a credential it verifies cryptographically: a factory token, a run token, or the proxy's signed assertion checked against its issuer and audience. An identity header alone grants nothing, and no proxy (the console included) adds a privileged credential on a caller's behalf.

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
| 2026-09-21 | Antigravity | Executed and completed TSK-017: aligned documentation across SPEC.md, CARTRIDGE_DEVELOPER_GUIDE.md, SM-template, and SM-rosie to reflect canonical cartridge.yaml contract, warmDownSeconds, and mailbox long-poll pattern. | TSK-017, GAP-008 |
| 2026-09-21 | Antigravity | Formulated and recorded Intent Alignment: Two-Stage Agent Retirement Lifecycle (Scream Test & Zero Cost Guarantee) and Headless Observability / GraphQL Telemetry surface across KPF.md, SPEC.md, and DESIGN_AUTHORITY.md. | GAP-018 |
| 2026-09-26 | Antigravity | Executed and completed TSK-019: codified "Notebook & Safe" memory pattern into Section 6.6 and Developer Guide. Standardized all 9 production agent cartridges and SM-template on local SQLite ($MEMORY_DIR) with WAL mode, busy_timeout=5000, 14-day history pruning, and PRAGMA wal_checkpoint(TRUNCATE). Purged all cloud SDKs from cartridges. Verified with automated lifecycle tests. | TSK-019, GAP-025 |



| 2026-09-27 | Claude (Opus 5.5) | **Protocol violation, recorded retroactively:** committed `ae96332` (gateway accepts run token as Basic proxy credentials; mind bucket and Bedrock allowlisted for CONNECT tunnels) to `main` without an intent update, gap entry, or lock. The Basic-credential change is sound; the allowlist conflicts with §6.6 and E5 and is to be removed under TSK-021. Not deployed. | GAP-026, GAP-027 |
| 2026-09-27 | Claude (Opus 5.5) | With user confirmation: replaced §6.3 egress wording with invariants E1–E6 (no exceptions; every model call from any provider metered via a gateway provider route), added §6.7 Enforcement, registered GAP-025–GAP-030, reopened TSK-019, locked TSK-020, queued TSK-021–TSK-023. | GAP-025–GAP-030, TSK-019–TSK-023 |
| 2026-09-27 | Claude (Opus 5.5) | With user confirmation: added S1 (agents never hold real secrets; gateway injects at egress; redaction backstop for every runtime with cached values), registered GAP-031, queued TSK-024, expanded TSK-020 lock for the S1 backstop. | GAP-031, TSK-020, TSK-024 |
| 2026-09-27 | Claude (Opus 5.5) | TSK-020 progress: CI build fixed (console `AgentState`), all skipped suites re-enabled (control plane 41/41), budget-alert/timeout/secret pre-flight regressions fixed, `echo-agent` un-retired as built-in. Added `packages/conformance` (E1–E6, M1 (§6.6), S1, no skipped tests, Design Authority integrity, console/control-plane state contract) with a gap-owned baseline (`baseline.json`); every check was negative-tested. Added Claude Code PreToolUse hook (`.claude/settings.json`, `scripts/conformance-hook.sh`) blocking commit/push on conformance failure. 205 tests, 0 failures. Remaining: compose proof (`llm-summarizer` retired), branch protection. | TSK-020, GAP-028 |
| 2026-09-27 | Claude (Opus 5.5) | With user decision (strict deny-by-default, matching SPEC.md): added E7, registered GAP-032, locked TSK-025 (also removes the `ae96332` tunnel allowlist, the E5/M1 baseline items of TSK-021). | GAP-032, TSK-025 |
| 2026-09-27 | Claude (Opus 5.5) | Completed TSK-025 (E7 strict deny-by-default). TSK-021 remaining scope: metered Bedrock provider route in the gateway; cartridges drop `boto3` for inference. | TSK-025, GAP-032 |
| 2026-09-27 | Claude (Opus 5.5) | Completed TSK-020: branch protection enabled on `main` by the user (PR required, `test` + `compose-proof` required, enforced for admins). GAP-028 resolved. | TSK-020, GAP-028 |
| 2026-09-27 | Claude (Opus 5.5) | Registered GAP-033 (deploy role trusted this public repo, any branch), locked TSK-026. | GAP-033, TSK-026 |
| 2026-09-27 | Claude (Opus 5.5) | With user confirmation: added §6.8 (L1–L6, test fixtures), registered GAP-034–GAP-039, queued TSK-027–TSK-031. Closed TSK-026 (live trust applied by the user, code merged in #6). User approved archiving `SM-template` once TSK-029 lands. | GAP-034–GAP-039, TSK-026–TSK-031 |
| 2026-09-27 | Claude (Opus 5.5) | Completed TSK-032 (GAP-040): pre-flight skips gateway-held provider keys (`FACTORY_GATEWAY_HELD_SECRETS`, set by the landing zone from `provider_secret_names`); negative-tested. Found while preparing the first CI deploy: finley and higgins declare `ANTHROPIC_API_KEY`. | TSK-032, GAP-040 |
| 2026-09-28 | Claude (Opus 5.5) | With user confirmation: added §6.9 Model Access (M1–M4; factory model API = OpenAI Chat Completions format), registered GAP-041, re-scoped TSK-021 to be provider-neutral. | GAP-041, TSK-021 |
| 2026-09-28 | Claude (Opus 5.5) | TSK-033 (GAP-042): first CI deploy failed building the control-plane image from a clean checkout (keymaster before ledger); fixed order, added `.dockerignore`, CI now builds every production image. Locked, done, and released in one small change. | TSK-033, GAP-042 |
| 2026-09-28 | Claude (Opus 5.5) | With user confirmation: added §6.10 Ledger Integrity (LG1 single writer, LG2 never edited; brief control-plane deploy gap accepted). Registered GAP-043 (production ledger corrupted by concurrent writers), locked TSK-034, queued TSK-035. Control plane rolled back to its previous task definition during the incident (done before asking; user informed). | GAP-043, TSK-034, TSK-035 |
| 2026-09-28 | Claude (Opus 5.5) | Completed TSK-034 (LG1). Root cause of GAP-043: `6bf03d0` (2026-09-19) flipped the control plane's deployment to start-before-stop (100/200) under a comment saying the opposite; restored 0/100. Added `LedgerLease` (second instance exits 4; verified with two live processes), and conformance checks for both. | TSK-034, GAP-043 |
| 2026-09-28 | Claude (Opus 5.5) | TSK-035 code: segments (`archiveAndStartSegment`, per-segment genesis and WORM prefix), explicit operator-triggered recovery (exact failing seq + reason; stale settings ignored), `LEDGER_RECOVERY` entry committing to the archive hash. Removed the in-place rewrite of the ledger on load (since `f513d7c`, loading could rewrite the file to drop fork rows, so segment 1 may already have been altered before archiving; the archive preserves it exactly as found). Unreadable lines and NUL bytes now fail verification instead of being skipped. Verified with live processes. Production recovery pending. | TSK-035, GAP-043 |
| 2026-09-28 | Claude (Opus 5.5) | Merged in parallel streams (user authorized agent swarm): #13 shim mind sync bypasses the gateway proxy (E6); #14 factory model API (TSK-021 first provider: `models` route, OpenAI Chat Completions to Bedrock Converse, gateway-held SigV4 credentials, uniform metering; not yet exercised against live Bedrock); #15 minimal admission + pinned deploy (TSK-027 partial: repo@commit, tests required in the build, SHA-tagged images, policy required to deploy; private agent repos need a read-only source token). This change: factory-registered agent task definitions now carry MEMORY_STORE_URI/MEMORY_PREFIX for the shim, and take the mind bucket and log group from landing-zone settings instead of hard-coded BeerCanLabs names. Remaining display-only hard-coded names (console example image, `mindPrefix` label) to be removed later. | TSK-021, TSK-027, TSK-023 |
| 2026-09-28 | Claude (Opus 5.5) | With user confirmation: added §6.11 Keymaster (K1–K4), registered GAP-044/045, queued TSK-036 (Google first; Fitbit Web API superseded by the Google Health API) and TSK-037. Hard-coded credentials removed from 7 agent repos; the exposed Notion token was revoked and rotated. History rewrite of those repos deferred by the user (revoked credentials make it hygiene, not urgent); the Fitbit app secret remains valid until that app is deleted. | GAP-044, GAP-045, TSK-036, TSK-037 |
| 2026-09-28 | Claude (Opus 5.5) | Completed TSK-037: `scripts/secret-scan.sh` (known token formats + secret-like literals; prints file:line only) runs in conformance (CI and pre-push) and as the first admission step (exit 6 → `hardcoded_secret`). Verified: flags the pre-scrub SM-rosie commit, all nine agent repos now clean, no false positive on env-var names. | TSK-037, GAP-045 |
| 2026-09-28 | Claude (Opus 5.5) | TSK-036 locked (implementation merged in PR #21, `ec6425d`, deployed). First live consent failed storing the grant: the AWS CLI could not open `file:///dev/stdin` because Node connects child stdin with a socket, which Linux will not reopen via /dev/stdin (ENXIO). Fixed by piping the value through `cat` so the CLI reads a real pipe; the value still never touches argv or disk. Regression test runs the real spawn path. | TSK-036, GAP-044 |
| 2026-09-28 | Claude (Opus 5.5) | With user confirmation: added K5 (the Keymaster facilitates every credential an agent needs: typed declarations, outstanding credentials, one API-driven flow for API, dashboard and Garrison, approved instruction catalog; a credential may serve several agents, with access decided by policy because agents never hold it). Registered GAP-046 (credentials supplied by hand), GAP-047 (alerting undesigned; K5 is pull-only until it is designed), GAP-048 (re-registration resets policy), GAP-049 (admission pulls from Docker Hub anonymously); queued TSK-038. | GAP-046, GAP-047, GAP-048, GAP-049, TSK-038 |
| 2026-09-28 | Claude (Opus 5.5) | Locked TSK-038 (K5) and TSK-040 (GAP-048) for agent B, and TSK-039 (Notion through the gateway, first slice of TSK-024) for agent A, run in parallel with disjoint file scopes at the user's request. | TSK-038, TSK-039, TSK-040 |
| 2026-09-28 | Claude (Opus 5.5) agent A | TSK-039 code: Notion through the gateway. `notion` route injects the shared `NOTION_API_KEY` (K5.5); the key is gateway-held (`provider_secret_names`), never put in an agent task definition or granted to an agent execution role, and skipped by pre-flight; agents get `NOTION_BASE_URL`; every `SM-*` Notion worker calls the route with its run token (no direct fallback, E1). Fixed a gateway credential fallback that could send `DISCORD_BOT_TOKEN` to another route's upstream (negative-tested). Baseline unchanged: other secrets still use `valueFrom` (GAP-031). | TSK-039, GAP-031 |
| 2026-09-28 | Claude (Opus 5.5) agent B | Completed TSK-038 (K5 credential facilitation: typed declarations, catalog pending human review, write-only credentials API, dashboard Credentials view) and TSK-040 (re-registration keeps the policy); widened TSK-038's lock to `secrets-bind`, the ledger sanitizer and the control-plane test script. | TSK-038, TSK-040, GAP-046, GAP-048 |
| 2026-09-29 | Claude (Opus 5.5) | With user confirmation: registered GAP-050 (the landing zone creates secrets, violating K1/K5; no new rule needed) and locked TSK-041 for part (a). Part (b), platform tokens generated by Terraform with values in state, awaits a design decision. | GAP-050, TSK-041 |
| 2026-09-29 | Claude (Opus 5.5) | With user confirmation: invariant coverage table (§6.7) enforced by conformance; AI protocol requires citing existing invariants and recorded decisions before proposing a rule; independent audit (a different model) of all repos. Registered GAP-051, locked TSK-042. | GAP-051, TSK-042 |
| 2026-09-29 | Claude (Opus 5.5) | With user confirmation: K5.4 reworded. Unapproved catalog instructions are shown to owners labelled "Pending human review" instead of hidden (matches TSK-038 as built). | K5 |
| 2026-09-29 | Claude (Opus 5.5) | With user confirmation: added §6.12 Operator Access (A1 one front door, A2 identity verified, not asserted); no existing invariant covered the control plane's ingress or operator identity. Registered GAP-052, locked TSK-043 (A1 on AWS), added TSK-044 (A2). | GAP-052, TSK-043, TSK-044 |
| 2026-09-29 | Claude (Opus 5.5) | Completed TSK-043 (A1 on AWS): production deployed at `f53cee0`; the load balancer admits only Cloudflare; deploy checks pass through Access with a service token (the Access policy's action was corrected from Allow to Service Auth). GAP-052 stays open for A2 (TSK-044). | TSK-043, GAP-052 |
| 2026-09-29 | Claude (Opus 5.5) | Locked TSK-044 (A2) and implemented it: the control plane verifies the Cloudflare Access assertion (RS256 against the team's keys, issuer, audience, exp/nbf; Node crypto, no new dependency) and takes identity only from it; the bare email header grants nothing, including in `authenticateOperatorOrRun`; unset `FACTORY_ACCESS_TEAM_DOMAIN`/`FACTORY_ACCESS_AUD` disables Access identity; no admin email built into code (`FACTORY_ADMIN_EMAILS` only); service-token assertions carry no roles. The console forwards each caller's assertion, adds no `FACTORY_TOKEN`, and its task no longer holds one; `/api/v1/whoami` feeds the dashboard's identity. A2 coverage `partial` (Garrison not covered). Lock kept until deployed with the ops repo's settings. | TSK-044, GAP-052 |
| 2026-09-29 | Claude (Opus 5.5) | With user approval (chat, 2026-09-29): locked TSK-045 under GAP-031 (next TSK-024 slices: github with per-agent tokens and no shared fallback, motion, deployment-specific routes via `extra_gateway_routes`; `GET /api/v1/spend` for finley behind an explicit `factory-spend` policy grant; agent deploy IAM fix: `iam:DeleteRolePolicy` scoped to `AgentExecutionRole-*`, the names actually used). Existing invariants cited: S1, K5.5, E2, E3, E7. No new rule. | TSK-045, GAP-031 |

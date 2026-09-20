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
| **TSK-006** | GAP-006 | Align Positioning Paper & Architecture on Egress Routing | `OPEN` | *None* | `POSITION_PAPER.md`, `SPEC.md` | Clarify the network gateway pattern vs. sidecar proxy reality. |
| **TSK-007** | GAP-008 | Author Comprehensive Cartridge Developer Guide | `COMPLETED` | *None* (Released) | `docs/CARTRIDGE_DEVELOPER_GUIDE.md`, `README.md` | Authored end-to-end guide based on New Hire model with code examples & case studies. |

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


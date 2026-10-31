# Creating and Managing Agents: Dual-Mode Hosting Guide

BeerCanLabs Agent Factory supports **dual-mode agent hosting** ([`DESIGN_AUTHORITY.md` §6.18](../DESIGN_AUTHORITY.md), `CF6`, `RT1`):
1. **Configuration-Only Agents (Shared Runtime):** Declarative agents defined by a persona (`soul.md`), memory archetype (`AM1`), roles (`E12`), and composed Python standard library skill packages (`SK1`–`SK5`) running on the shared `factory-agent-runtime` (`RT1`).
2. **Repository-Based Cartridges (Custom Container):** Self-contained git repositories (`cartridge.yaml`, `soul.md`, `Dockerfile`, custom code, and unit tests) built at a pinned 40-character commit SHA into a dedicated OCI container image (`L3`, `L4`).

Both models are first-class citizens of the Agent Factory perimeter (`Gatekeeper`, `Keymaster`, `Executive`, `Property Manager`, `Auditor`, `Accountant`, `Bouncer`, `Timekeeper`, `Registrar`, `Inspector`), and both pass the **Universal Activation Smoke Gate** (`L4`) before taking live traffic.

This guide provides the architectural decision rubric for choosing between the two models, step-by-step build workflows for both tracks, shared runtime rollout operations, an in-place conversion runbook (`POST /api/v1/agents/:id/convert`), and an FAQ covering common operational pitfalls.

---

## 1. Architectural Decision Rubric: Configuration-Only Agents vs. Repository-Based Cartridges (`CF6`, `RT1`)

### Side-by-Side Comparison

| Dimension | Configuration-Only Agent (Shared Runtime) | Repository-Based Cartridge (Custom Container) |
| :--- | :--- | :--- |
| **Core Concept** | Declarative persona (`soul.md`), memory archetype (`AM1`), caller roles (`E12`), and composed Python stdlib skill packages running on the digest-pinned `factory-agent-runtime` (`RT1`). | Self-contained git repository (`cartridge.yaml`, `soul.md`, `Dockerfile`, custom code & unit test suite) built into a dedicated OCI container image (`L3`, `L4`). |
| **Best Suited For** | Personal assistants, domain analysts, operations dispatchers, knowledge oracles, and workflow automatons whose tools are HTTP/API integrations. | Custom execution loops, non-Python languages (TypeScript/Go/Rust), compiled native libraries/C-extensions, custom local binaries, specialized SQLite schemas, and Factory House Staff (`agents/staff/*`). |
| **Creation & Iteration Speed** | **Instant:** Create via `POST /api/v1/agents` or conversationally via `agent-builder`. Soul, role, and memory updates version in place (`PUT /api/v1/agents/:id/settings`) with zero git PR or image rebuild. | **Full SDLC:** Clone template, write code & unit tests, push a 40-char commit SHA, and run the isolated `L3`/`L4` container admission build. |
| **Runtime Maintenance** | **Fleet-Managed:** One admin-approved `PUT /api/v1/runtime` upgrades and smoke-tests all configuration agents automatically with per-agent rollback protection. | **Owner-Managed:** Each repository owns its base image, OS packages, turn loop, and `AM3` notebook rotation updates. |
| **Tooling & Dependencies** | Modular `spec: 1` Python skill packages (stdlib + vendored pure-Python under `vendor/`) reusable across any agent in the fleet. | Any language, runtime, or local binary tool (excluding prohibited cloud/LLM provider SDKs per `E5`/`S1`). |
| **Portability & Export (`CF3`)** | **Full Bundle Portability:** Exports (`GET /api/v1/agents/:id/bundle`) as a self-contained configuration bundle importable (`POST /api/v1/agents/import`) into any factory instance. | **Git + OCI Portability:** Portable via git repository and container registry; configuration bundle export is read-only metadata (`origin: repository`). |
| **Governance & Registration (`CF6`)** | Open to any `operator` or `admin` holding the `agents.create` privilege. | Governed by the `FACTORY_REPOSITORY_AGENT_IDS` allowlist when `FACTORY_NEW_AGENTS_FROM_CONFIGURATION_ONLY` is active (`CF6`). |

### 1.1 When to Choose a Configuration-Only Agent (Default for User, Team & Business Agents)

For most user, team, and business workloads, **Configuration-Only** is the recommended default:
- **Zero Boilerplate:** You do not maintain a git repository, `Dockerfile`, turn loop, or container build pipeline for the agent.
- **Shared Agent Runtime (`RT1`, `RT2`):** The agent executes on the official, digest-pinned `runtimes/agent-runtime` image—a verified Python program that opens memory by archetype (`AM1`–`AM5`), constructs prompts from the soul and conversation history, calls models through the Factory Model API (`M1`), dispatches tool calls to adopted skills, replies on the originating channel (`AM2`), and handles `/mailbox` warm-down polling.
- **Reusable Skill Composition (`SK1`–`SK5`):** When the agent adopts skills, the deployment provider (`factory-skills-builder` on AWS or Docker on Compose) layers those verified skill packages onto the shared runtime base image.
- **Zero-Touch Fleet Upgrades:** When the shared runtime is improved, a single admin rollout (`PUT /api/v1/runtime`) rebuilds and smoke-tests every configuration agent across the fleet.

### 1.2 When to Choose a Repository-Based Cartridge (Custom Container & Specialized Workloads)

A **Repository-Based Cartridge** is the right architectural choice when an agent's requirements intentionally exceed the fixed loop (`RT2`) or pure-Python skill model of the shared runtime:
1. **Custom Turn or Execution Loops:** The agent implements specialized multi-stage state machines, custom context assembly, deterministic pre-/post-processing pipelines, or non-standard execution flows beyond the fixed `RT1` prompt-tool-reply loop.
2. **Non-Python Runtimes or Compiled Native Dependencies:** The agent is written in TypeScript/Node.js, Go, or Rust, or relies on compiled C-extensions, native shared libraries, or system CLI binaries outside the Python standard library.
3. **Bespoke Local Storage Schemas or Sidecar Tooling:** The agent manages custom SQLite domain tables, specialized FTS5 indexing pipelines, or local file processing in `$MEMORY_DIR` beyond the standard `AM1` archetype schemas.
4. **Factory House Staff (`agents/staff/*`):** Platform staff cartridges (`factory-manager`, `agent-builder`, `personal-trainer`) that invoke privileged run-scoped factory endpoints (`/api/v1/runs/:runId/builder`, `/api/v1/runs/:runId/training`).

#### Trade-offs & Governance (`CF6`):
- **Owner-Managed Lifecycle:** Repository owners are responsible for keeping their base image, OS packages, turn loop, and `AM3` volume rotation logic current, and must register a new 40-character commit SHA for code or prompt updates.
- **Allowlist Governance:** When `FACTORY_NEW_AGENTS_FROM_CONFIGURATION_ONLY` is enabled (the default in production), registering a **new** agent ID from a repository (`POST /api/v1/registry/agents`) requires the ID to be listed in `FACTORY_REPOSITORY_AGENT_IDS` (or be a built-in/staff agent); otherwise registration is refused with `HTTP 422 new_agents_use_configuration`. Existing registered repository agents continue to admit new commits and deploy normally, or can be converted in place to Configuration-Only agents at any time ([Section 5](#5-migration-runbook--converting-a-repository-agent-in-place-post-apiv1agentsidconvert-tsk-283)).

---

## 2. Step-by-Step Guide: Building a Configuration-Only Agent

### Step 1: Design the Persona (`soul.md`) & Choose a Memory Archetype (`AM1`)

1. **Draft the Persona (`soul`):** Define the agent's identity, mission, tone, and operational boundaries (up to 64 KiB). Ensure the text is clean of cloud account IDs, ARNs, VPC IDs, or internal infrastructure addresses (`S4`).
2. **Select the Memory Archetype (`memory.archetype` under `AM1`):**
   - `purpose-built`: Stateless, task-focused worker (e.g., webhook triage, one-shot classifier). The runtime shim (`packages/hydrate`) skips object-storage hydration on wake and replication on sleep for zero cold-start storage overhead.
   - `personal-assistant`: Per-user isolated episodic memory (`notebook.db`) keyed by verified `caller.actor` (`AM2`).
   - `team-member`: Shared project- and task-partitioned SQLite workspace memory.

### Step 2: Package & Register Reusable Skills (Optional — When Custom Tools Are Needed)

If your agent needs external API tools beyond baseline conversation, package each capability as a `spec: 1` Python skill (see [`docs/SKILLS.md`](./SKILLS.md)):

1. **Author `skill.yaml` with a mandatory `smoke:` block (`TSK-281`, `L4`):**
   ```yaml
   spec: 1
   id: tavily-search
   version: 1.0.0
   name: Tavily Search
   description: Real-time web search tool.
   language: python
   entry: tavily_search
   requires:
     routes: [tavily]
     credentials:
       - name: TAVILY_API_KEY
         description: API key for Tavily search
   actions:
     - id: execute-search
       route: tavily
       method: POST
       path: /search
       hold: false
   smoke:
     action: execute-search
     input:
       query: ping
     dryRun: true # Required true when action method is POST/PUT/PATCH/DELETE or hold: true
   ```
2. **Pack and Register the Skill Archive:**
   ```bash
   # Validate and create my-skill-1.0.0.tar.gz locally
   factory skill pack ./skills/tavily-search

   # Upload to POST /api/v1/registry/skills (requires skills.register privilege)
   factory skill register ./skills/tavily-search
   ```
3. **Own-Use vs. Fleet Publication (`H7`, `H8`, `A7`):**
   - **Immediate Own-Use:** As soon as the isolated offline checker (`factory-skill-checker`) passes (`tests: "passed"` on `GET /api/v1/skills/:id`), the skill version is **immediately adoptable** by any agent owned by the skill uploader or members of assigned groups—no admin approval required.
   - **Fleet-Wide Sharing:** To publish the skill in the public catalog for all agent owners, request publication (`POST /api/v1/skills/:id/publish`) and have a factory admin approve it (`POST /api/v1/skills/:id/publish/decide` with `{ "decision": "approve" }`).

### Step 3: Create the Agent & Adopt Skills (`POST /api/v1/agents` or `agent-builder`)

#### Method A: Direct Creation via REST API (`POST /api/v1/agents`)

Any user holding the `agents.create` privilege (`operator` or `admin` roles, decision 7) can create a configuration agent:

```http
POST /api/v1/agents
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": "research-assistant",
  "name": "Research Assistant",
  "soul": "You are a research assistant. You search the web and synthesize technical reports...",
  "memory": {
    "archetype": "personal-assistant"
  },
  "roles": [
    {
      "name": "Team",
      "skills": {
        "*": { "allow": ["*"] }
      }
    }
  ]
}
```

- **Creator Becomes Owner:** The authenticated caller is recorded as `owners: [principal.actor]`.
- **Initial State (`PENDING_BUDGET`):** The agent starts with no egress access or budget until an admin sets its policy (`E7`).
- **Admin-Managed Default Skills & Automatic Seeding (`GAP-216`, `SK3`, `CF6`):** Any default skills configured by administrators (`GET/PUT /api/v1/skills/defaults`) are automatically seeded into the agent's initial skills configuration upon creation (with provenance recorded as `approvedBy: "factory:defaults"`).
  - **Explicit Initial Skills (`skills`):** Callers can pass initial skills directly in the creation payload:
    ```json
    "skills": [{ "id": "tavily-search", "version": "1.0.0" }]
    ```
    If an explicit version is specified for a skill that is also a default skill, the explicit version takes precedence ("custom version wins").
  - **Opting Out:** Callers can exclude specific default skills via `"excludeDefaultSkills": ["skill-id"]` or opt out of all defaults via `"includeDefaultSkills": false`. (Bundle imports `POST /api/v1/agents/import` automatically pass `includeDefaultSkills: false` to ensure exact reproduction).
- **Role Skill Ceiling (`CF2`):** On initial creation via `POST /api/v1/agents`, `roles` may reference any adopted skills (both explicitly supplied skills and automatically seeded default skills). Any role referencing an unadopted skill is rejected with `HTTP 422 unknown_skill`. Additional skills can be adopted post-creation via `POST /api/v1/agents/:id/skills`, and role mappings updated via `PUT /api/v1/agents/:id/settings`:
  ```http
  POST /api/v1/agents/research-assistant/skills
  Authorization: Bearer <owner-or-admin-token>
  Content-Type: application/json

  {
    "skillId": "tavily-search",
    "version": "1.0.0"
  }
  ```

#### Method B: Conversational Creation via `agent-builder` (`POST /api/v1/runs/:runId/builder`)

Operators and admins can also converse with the headless **`agent-builder`** house staff agent (`agents/staff/agent-builder`, `TSK-282`) to design, validate, and publish configuration agents. `agent-builder` calls its run-scoped endpoint `POST /api/v1/runs/:runId/builder`:

1. **`op: "catalog"`:** Lists available approved/accessible skills, model catalog offerings, and valid memory archetypes (`purpose-built`, `personal-assistant`, `team-member`).
2. **`op: "validate"`:** Validates a candidate specification (soul size, archetype, skill version existence, role ceilings) without creating the agent.
3. **`op: "publish"`:**
   ```json
   {
     "op": "publish",
     "spec": {
       "id": "market-analyst",
       "name": "Market Analyst",
       "soul": "You analyze market trends and summarize competitive intelligence...",
       "memory": { "archetype": "team-member" },
       "skills": [{ "id": "tavily-search", "version": "1.0.0" }]
     }
   }
   ```
   - Verifies that the run was initiated by a human caller holding `agents.create` (refuses `SYSTEM` actors).
   - Creates the agent in `PENDING_BUDGET` with the requesting human user as owner.

### Step 4: Admin Policy & Budget Assignment (`PUT /api/v1/agents/:id/policy`)

Before the agent can be deployed or woken, a factory admin grants its allowed models, egress routes, and spend ceilings (`E7`):

```http
PUT /api/v1/agents/research-assistant/policy
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "models": ["claude-sonnet-4-5", "claude-haiku-4-5"],
  "routes": ["models", "tavily"],
  "hosts": [],
  "budget": {
    "dailyUsd": 5.00,
    "monthlyUsd": 50.00
  }
}
```

### Step 5: Deploy & The Activation Smoke Gate (`POST /api/v1/registry/agents/:id/deploy`, `L4`)

Once policy and budget are configured, the agent owner or an admin triggers deployment:

```http
POST /api/v1/registry/agents/research-assistant/deploy
Authorization: Bearer <owner-or-admin-token>
```

#### Synchronous vs. Asynchronous Deployment Behavior:
- **Zero Adopted Skills (Synchronous `200 OK`):**
  If the configuration agent has **no adopted skills**, no image layering is needed. The control plane binds the agent directly to the pinned shared runtime image (`FACTORY_RUNTIME_IMAGE`), provisions compute identity, and executes `runActivationSmoke` **synchronously** during the request:
  - On smoke pass: transitions the agent to `SLEEPING`, records `AGENT_DEPLOYED`, and returns `HTTP 200 OK` (`{ ...agent, smoke }`).
  - On smoke failure: rolls back to the previous working image (or marks `ERROR` on first deploy), records `AGENT_SMOKE_FAILED`, and returns `HTTP 502 { "error": "smoke_failed", "message": "..." }`.
- **One or More Adopted Skills (Asynchronous `202 Accepted`):**
  If the configuration agent **adopts one or more skills**, the control plane sets `state: "DEPLOYING"`, returns `HTTP 202 Accepted` immediately, and executes `runDeploy` asynchronously in the background:
  - The deployment provider (`factory-skills-builder` on AWS or Docker on Compose) layers the approved skill packages from `SkillPackageStore` onto the shared runtime base image and pushes `<agentId>-<runtimeCommit12>-<skillsHash12>`.
  - Once built, it runs `runActivationSmoke` before activating the new compute definition.

#### What the Universal Activation Smoke Gate Verifies (`runActivationSmoke`, `TSK-281`):
1. **Isolated Smoke Run:** Boots the candidate container with `trigger: "smoke"` and `factoryKind: "smoke"`.
2. **Temporary Factory Policy & Budget:** Grants temporary model access and a factory-paid smoke budget cap ($0.25/run, $1.00/activation) so smoke verification never consumes the agent's own budget.
3. **Turn 1 — Soul / Model Completion (`smoke: "hello-world"`):** Verifies that the container starts, loads its soul, makes at least one metered model call through `gatekeeper-egress` (`E5`), and finishes with a non-empty `DONE` response.
4. **Turns 2..N — Adopted Skill Verification (`smoke: "skill"`):** Executes each adopted skill's declared `smoke:` block with `context: { smoke: true, dryRun: boolean }` and verifies tool dispatch and egress route audit rows.
5. **Pass or Automatic Rollback:** Passing activates the image (`SLEEPING`, `AGENT_DEPLOYED`). Failing rejects the candidate image, restores the prior working image if one existed, and records `AGENT_SMOKE_FAILED` with container diagnostics.

---

## 3. Step-by-Step Guide: Building a Repository-Based Cartridge

When your workload requires custom execution loops, non-Python languages, compiled binaries, custom SQLite schemas, or House Staff privileges, build a Repository-Based Cartridge. For deep implementation patterns and case studies, see the **[Cartridge Developer Guide](./CARTRIDGE_DEVELOPER_GUIDE.md)**.

### Step 1: Verify Eligibility & Allowlisting (`CF6`)

When `FACTORY_NEW_AGENTS_FROM_CONFIGURATION_ONLY=true` is active on the factory:
- Ensure your new agent ID is added to the `FACTORY_REPOSITORY_AGENT_IDS` environment variable on the control plane (or is a built-in/staff cartridge under `agents/staff/*`).
- If an un-allowlisted new ID is submitted to `POST /api/v1/registry/agents`, the factory refuses registration with `HTTP 422 new_agents_use_configuration`.

### Step 2: Scaffold the Repository (`soul.md`, `cartridge.yaml`, Code, `Dockerfile`, Tests)

Create a self-contained repository with the following layout (you can start from `agents/examples/starter-python`):

```text
my-cartridge/
├── soul.md                  # Persona and operational constraints (<64 KiB, S4-clean)
├── cartridge.yaml           # Machine-enforced contract (archetype, triggers, secrets, egress, roles)
├── agent.py                 # Turn loop and custom domain logic
├── requirements.txt         # Dependencies (no cloud or LLM vendor SDKs)
├── Dockerfile               # Container build definition
└── tests/
    └── test_agent.py        # Unit test suite (mandatory for L3/L4 admission)
```

Example `cartridge.yaml`:
```yaml
schemaVersion: "1.0"
id: ops-triage
name: "Operations Triage"
role: "Incident Diagnostics"
prompt: "./soul.md"

memory:
  archetype: team-member     # Required (AM1): purpose-built | personal-assistant | team-member

triggers:
  - type: webhook
    path: /hooks/ops-triage
    secretRef: OPS_WEBHOOK_SECRET
  - type: discord
    secretRef: DISCORD_BOT_TOKEN

secrets:
  requires:
    - name: OPS_WEBHOOK_SECRET
      description: "HMAC signing secret for inbound alert webhooks"

persistence:
  enabled: true
  prefix: "ops-triage"

compute:
  kind: oci
  ref: "ops-triage:latest"
  localCommand: ["python3", "agent.py"]

runtime:
  warmDownSeconds: 300

egress:
  routes:
    - models
    - discord

skills:
  - id: pagerduty-ops
    routes: [pagerduty]

roles:
  Owner:
    skills:
      "*": { allow: ["*"] }
  OnCall:
    skills:
      pagerduty-ops: { allow: ["*"] }
```

### Step 3: Implement the Turn Loop (`M1`, `M2`, `AM1`–`AM5`, `E1`–`E6`)

Your cartridge code must obey the factory perimeter invariants:
- **Input:** Read the initial wake payload from `FACTORY_INPUT` or `/tmp/factory-input.json`.
- **Model Calls (`M1`, `M2`, `E5`):** Call `POST ${FACTORY_MODEL_BASE_URL}/chat/completions` with `Authorization: Bearer ${FACTORY_RUN_TOKEN}` and `"model": os.environ.get("FACTORY_MODEL", "claude-sonnet-4-5")`. Never import `anthropic`, `boto3`, or `google.genai`, and never hardcode a model choice.
- **Notebook & Safe (`AM1`–`AM5`, `E6`):** Store SQLite databases under `os.environ["MEMORY_DIR"]` using `PRAGMA journal_mode=WAL;`, `PRAGMA busy_timeout=5000;`, and `PRAGMA wal_checkpoint(TRUNCATE);` on exit. Rotate notebooks into `$MEMORY_DIR/volumes/<name>/` at `FACTORY_NOTEBOOK_MAX_BYTES` (10 MB) or `FACTORY_NOTEBOOK_MAX_DAYS` (90 days) rather than deleting history (`AM3`).
- **Replies & Mailbox (`AM2`):** Deliver replies according to `replyTo` (`POST /api/v1/runs/${FACTORY_RUN_ID}/reply` for console turns or `${DISCORD_BASE_URL}` for Discord turns), poll `GET /api/v1/runs/${FACTORY_RUN_ID}/mailbox` while warm, and write the final status to `/tmp/factory-result.json`.

### Step 4: Validate Locally

Run contract validation and your unit test suite before pushing:

```bash
npx @beercanlabs/contract validate ./my-cartridge
python3 -m pytest -q
```

### Step 5: Register & Admit a Pinned Commit (`POST /api/v1/registry/agents`, `L3`, `L4`)

Push your commit to git and register the full **40-character commit SHA** (branches and tags are refused):

```http
POST /api/v1/registry/agents
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "id": "ops-triage",
  "repo": "https://github.com/myorg/ops-triage",
  "commit": "0123456789abcdef0123456789abcdef01234567"
}
```

The Registrar and Property Manager run the isolated admission pipeline (`L3`, `L4`):
1. **Commit Pin Verification:** Clones the exact 40-character SHA (`source_unavailable` if unreachable).
2. **Secret Scan (`S1`):** Scans every tracked file for hardcoded tokens or private keys (`hardcoded_secret` on hit).
3. **Automated Unit Tests:** Executes `python -m pytest -q` or `npm ci && npm test` (`no_tests` if zero tests are collected, `tests_failed` on failure).
4. **OCI Image Build & Push:** Builds the `Dockerfile` and pushes `<agentId>-<commit12>` (`build_failed` / `push_failed` on error).

### Step 6: Assign Policy & Deploy (`PUT /api/v1/agents/:id/policy` & `POST /api/v1/registry/agents/:id/deploy`)

1. Set the agent's model, route, and budget policy via `PUT /api/v1/agents/ops-triage/policy`.
2. Trigger deployment via `POST /api/v1/registry/agents/ops-triage/deploy` (returns `202 Accepted`).
3. If the repository agent has also adopted skill packages, `compose-skills.sh` layers them onto the agent's admitted image (`<agentId>-<commit12>-<skillsHash12>`).
4. The candidate image runs the **Universal Activation Smoke Gate** (`runActivationSmoke`, `L4`). On pass, the agent transitions to `SLEEPING` and records `AGENT_DEPLOYED`.

---

## 4. Admin-Approved Shared Runtime Rollout (`GET /api/v1/runtime`, `PUT /api/v1/runtime`, `TSK-280`, `RT1`)

The shared runtime version is managed as **Factory Data** (`M3`-style, `R1`), persisted in `<registryDir>/_runtime.json`.

### Inspecting Runtime Status (`GET /api/v1/runtime`)

Any authenticated viewer (`agents.read`) can inspect the active runtime version and per-agent rollout status:

```http
GET /api/v1/runtime
Authorization: Bearer <token>
```

Response:
```json
{
  "ok": true,
  "runtime": {
    "repo": "https://github.com/BeerCanLabs/agent-factory",
    "commit": "a28f963ede817225d6cab406e789138291d1d4fd",
    "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/factory-agent-runtime@sha256:7b92f7e4a1b2c3d4..."
  },
  "agents": [
    {
      "id": "market-analyst",
      "name": "Market Analyst",
      "state": "SLEEPING",
      "deployedRuntime": {
        "repo": "https://github.com/BeerCanLabs/agent-factory",
        "commit": "a28f963ede817225d6cab406e789138291d1d4fd",
        "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/factory-agent-runtime@sha256:7b92f7e4a1b2c3d4..."
      },
      "upToDate": true
    }
  ]
}
```

### Upgrading the Fleet Runtime (`PUT /api/v1/runtime`)

Upgrading the runtime requires the `runtime.set` privilege (`admin` role):

```http
PUT /api/v1/runtime
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "repo": "BeerCanLabs/agent-factory",
  "commit": "a28f963ede817225d6cab406e789138291d1d4fd",
  "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/factory-agent-runtime@sha256:7b92f7e4a1b2c3d4..."
}
```

#### Rollout Guarantees:
- **Digest Pinning Required (`L4`):** The `image` must be pinned by `@sha256:<64-hex>` digest and `commit` must be a 40-character hex SHA. Mutable tags (e.g., `:latest`) are rejected with `HTTP 400 invalid_runtime`.
- **Audit Ledger:** Appends `RUNTIME_VERSION_SET` and `SHARED_RUNTIME_UPDATED` with the admin actor, commit, and payload hash.
- **Automated Fleet Rebuild & Smoke:** Triggers `applyConfig` across all non-retired configuration-hosted agents (skipping any agent currently in `DEPLOYING`):
  - Agents without skills adopt the new base image directly.
  - Agents with skills are rebuilt by `factory-skills-builder` layering their adopted skills onto the new base image.
  - Every candidate image must pass the **Activation Smoke Gate** (`TSK-281`) before compute is switched.
  - On smoke pass: updates `deployedRuntime` and activates the new task definition (`status: "updated"`).
  - On smoke failure: rolls back that specific agent to its previous working image, records `AGENT_SMOKE_FAILED` and `AGENT_DEPLOY_FAILED`, and leaves the agent running its prior runtime (`status: "smoke_failed"`).
- **Synchronous Rollout Results:** `PUT /api/v1/runtime` awaits all candidate builds and smoke runs and returns `{ ok: true, runtime, pin, agents, results: [{ id, status: "updated" | "smoke_failed" }] }`.

---

## 5. Migration Runbook — Converting a Repository Agent in Place (`POST /api/v1/agents/:id/convert`, `TSK-283`)

Existing repository agents can be converted one-way in place to configuration agents without losing identity, ledger history, or mind state.

### What In-Place Conversion Preserves:
- **Agent Identity:** Retains the exact same `id` and display name.
- **Ledger Audit Trail:** Preserves all historical ledger rows and hash chains.
- **Ownership & Access:** Preserves `owners`, identity links, and role assignments.
- **Policy & Budgets:** Preserves model grants, route grants (unless uncovered routes are explicitly dropped), budgets, and spend counters.
- **Memory Prefix:** Retains `memoryPrefix` so existing notebooks in object storage remain attached.
- **Connected Channels & Schedules:** Preserves Discord channel bindings and Timekeeper cron schedules.

### Step-by-Step Migration Runbook

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       IN-PLACE CONVERSION RUNBOOK                           │
│                                                                             │
│  Step 1: S4 Scrub of soul.md                                                │
│         Remove cloud account IDs, ARNs, VPC IDs, or internal URLs           │
│                                                                             │
│  Step 2: Extract Tools to Python stdlib Skill Packages                      │
│         Vendor pure Python dependencies, declare mandatory smoke: block     │
│                                                                             │
│  Step 3: Upload and Verify Skill Packages                                   │
│         factory skill register -> offline checks (immediately own-use)      │
│                                                                             │
│  Step 4: Pre-flight Coverage & Policy Check                                 │
│         Verify routes, models, and triggers are covered by skills/channels  │
│                                                                             │
│  Step 5: Execute Conversion (POST /api/v1/agents/:id/convert)               │
│         Builds layered image, runs activation smoke gate, commits or rolls  │
│                                                                             │
│  Step 6: Post-Conversion Verification                                       │
│         Send live turn, verify AM1 mind hydration/replication behavior      │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Step 1: S4 Scrub of `soul.md`
Inspect the repository's `soul.md` and remove any cloud account numbers, ARNs, VPC IDs, or internal DNS hostnames (`S4`).

#### Step 2: Extract Tools into Pure stdlib Python Skill Packages
Package each custom tool from `agent.py` into a `spec: 1` skill directory (see [`docs/SKILLS.md`](./SKILLS.md)) with a mandatory `smoke:` block (`dryRun: true` for mutating `POST`/`PUT`/`PATCH`/`DELETE` or `hold: true` actions) and validate locally via `factory skill pack`.

#### Step 3: Upload and Verify Skill Packages
Upload via `factory skill register ./skills/my-skill-1.0.0.tar.gz` (`POST /api/v1/registry/skills`) and confirm `factory-skill-checker` passes (`GET /api/v1/skills/:id` shows `status: "approved"`). For agents owned by the uploader or assigned group, the skill is immediately eligible for adoption (`H7`, `A7`); for fleet-wide use, request publication (`POST /api/v1/skills/:id/publish`) and have an admin approve it (`POST /api/v1/skills/:id/publish/decide` with `{ "decision": "approve" }`).

#### Step 4: Pre-flight Route Coverage Check
Compare the repository agent's declared routes (`agent.egress.routes`, `agent.skillRoutes`, and `policy.routes`) against the `requires.routes` of the skills you are adopting (plus built-in `models` and `discord`):
- Every route must be covered by an adopted skill, **or** you must pass `"dropUncoveredRoutes": true` in the conversion payload to remove obsolete routes from the agent's policy. Otherwise conversion refuses with `HTTP 422 uncovered_routes`.

#### Step 5: Execute In-Place Conversion (`POST /api/v1/agents/:id/convert`)
Invoke the conversion endpoint (`agents.settings.set` privilege — agent owner or admin, `CF4`):

```http
POST /api/v1/agents/skippy/convert
Authorization: Bearer <owner-or-admin-token>
Content-Type: application/json

{
  "soul": "You are Skippy, a helpful assistant with retrieval tools...",
  "memory": {
    "archetype": "personal-assistant"
  },
  "skills": [
    {
      "id": "knowledge-retrieval",
      "version": "1.0.0"
    }
  ],
  "roles": [
    {
      "name": "Team",
      "skills": {
        "knowledge-retrieval": { "allow": ["*"] }
      }
    }
  ],
  "dropUncoveredRoutes": true
}
```

#### What Happens Internally:
1. Validates that the agent exists, is not a built-in agent, is not retired/purged, has an active policy with at least one route, and is not already a configuration agent (`createdFrom !== 'configuration'`).
2. Validates `soul`, `memory.archetype` (`AM1`), `roles` skill references (`CF2`), and each adopted skill version's approval/visibility status.
3. Automatically seeds admin-managed default skills (`GAP-216`, `SK3`, `CF6`) into the candidate skills list unless an explicit version for that skill ID is present in `skills` or opted out via `"includeDefaultSkills": false` or `"excludeDefaultSkills": ["..."]`.
4. Verifies route coverage against the unified set of candidate skills (`422 uncovered_routes` if uncovered routes exist and `dropUncoveredRoutes !== true`).
5. Snapshots the pre-conversion agent record and policy, sets `createdFrom: 'configuration'`, pins `agent.repo = pin.repo` and `agent.commit = pin.commit` to the shared runtime, and stages `pendingConfig` so the smoke container reads the candidate configuration.
6. **Zero Skills vs. Adopted Skills Build & Smoke:**
   - With zero skills: registers compute on `pin.image` and runs `runActivationSmoke`.
   - With adopted skills: invokes `runDeploy` (`factory-skills-builder` layered image build + `runActivationSmoke`).
7. **On Smoke Pass:**
   - Commits the new versioned configuration record to `config.json` with `source: { repo: pin.repo, commit: pin.commit }`, `skills`, and `agent` settings.
   - Keeps `createdFrom: 'configuration'` and keeps `agent.repo` and `agent.commit` pinned to the shared runtime (`pin.repo`, `pin.commit`).
   - Deletes legacy cartridge-specific fields from the agent record (`skillIds`, `skillRoutes`, `roles`, `admission`, and `pendingConfig`).
   - Transitions `state` to `'SLEEPING'`, saves the agent record, and records `CONFIG_VERSIONED`, `AGENT_DEPLOYED`, and `AGENT_CONVERTED` in the ledger.
   - Returns `HTTP 200 OK` with `{ ok: true, id, createdFrom: "configuration", state: "SLEEPING", artifact, deployedRuntime, configurationVersion, smoke: { ok: true } }`.
8. **On Smoke or Build Failure:**
   - Restores the pre-conversion snapshot (previous `createdFrom`, `repo`, `commit`, `artifact`, `state`, `roles`, `skillIds`, `skillRoutes`, `admission`, and `policy`) and re-registers the previous compute definition.
   - Records `AGENT_SMOKE_FAILED` in the ledger and returns `HTTP 502` (`smoke_failed` or `convert_deploy_failed`). The repository agent remains online and operational on its previous image.

#### Conversion Error Reference:
| HTTP Status | `error` Code | Cause & Resolution |
| :--- | :--- | :--- |
| `400` | `builtin_agent` / `invalid_settings` / `invalid_skills` | Built-in agents cannot be converted, or `soul`/`roles`/`skills` schema is malformed. |
| `403` | `skill_private` | A requested skill is private to another owner/group. |
| `404` | `agent_not_found` | No agent with `:id` exists in the registry. |
| `409` | `already_configuration_agent` | Agent already has `createdFrom: "configuration"`. Use `PUT /api/v1/agents/:id/settings` instead. |
| `409` | `policy_required` | Agent has no policy or zero granted routes. Set policy via `PUT /api/v1/agents/:id/policy` first. |
| `409` | `skill_unavailable` | A requested `id@version` is not registered, not `approved`, or is `retired`. |
| `422` | `archetype_required` | `memory.archetype` is missing (`purpose-built`, `personal-assistant`, or `team-member`). |
| `422` | `unknown_skill` | A role in `roles` names a skill ID not included in the conversion `skills` array (`CF2`). |
| `422` | `uncovered_routes` | Existing repository/policy routes are not covered by adopted skills. Adopt the matching skill or pass `"dropUncoveredRoutes": true`. |
| `502` | `smoke_failed` / `convert_deploy_failed` | Candidate image build or activation smoke gate failed; agent was automatically rolled back to its repository image. |

#### Step 6: Post-Conversion Verification
1. **Send a Live Turn:** Send a test turn via Discord or `POST /api/v1/agents/:id/conversation` and confirm normal responses and skill invocations.
2. **Verify Memory Storage Gate (`AM1`):**
   - If `purpose-built`: verify that the runtime shim performs no object-storage mind pull on wake or push on sleep.
   - If `personal-assistant` or `team-member`: verify that `notebook.db` hydrates and replicates cleanly.

---

## 6. Giving an Agent Its Own GitHub App and Discord Bot (`E5`, #291)

Each named agent gets its own apps, and a company's apps and keys stay in its own factory's secret store. Keys never go in the repository.

**GitHub App (one click on GitHub).** On the agent's credentials page, choose **Create GitHub App** (optionally name the org). The factory sends GitHub a prefilled manifest; approve it on GitHub. GitHub redirects back and the factory stores the app id, private key and webhook secret itself (`GITHUB_APP_<AGENT>_*`). Then `POST /api/v1/keymaster/agents/:id/github-app/installations {"orgs": [...]}` records the orgs and returns an install link per org. The gatekeeper-egress mints one-hour installation keys for chosen orgs only.

**Discord bot (as automated as Discord allows).** Discord has no API to create an application, so two steps stay manual in the [Developer Portal](https://discord.com/developers/applications): create the application, then reset and copy the bot token. Paste the token on the agent's credentials page (`POST /api/v1/keymaster/agents/:id/discord-app/token`). The factory checks it with Discord, stores it under the agent's declared Discord `secretRef` (else `<AGENT>_DISCORD_BOT_TOKEN`; an agent on the shared `DISCORD_BOT_TOKEN` must declare its own first), and returns an invite link with the declared permissions (`discord.permissions`, default view channels, send messages, read history). `GET /api/v1/keymaster/agents/:id/discord-app` lists the steps and the invite link; it never returns the token.

**Adding another service (`E5.3`).** Each service is an `AppSetupProvider` (`packages/control-plane/src/app-setup-providers.ts`): its steps, whether each is manual, its status and links. A step's action is one of three kinds the console already renders: `secret` (paste once, write-only), `browser-post` (start, then post to the service, as GitHub's manifest does) and `list` (names, such as orgs). Register the provider with `registerAppSetupProvider`; it appears on every agent's credentials page with no console changes. Store values only through the secret store; a provider never returns one. `GET /api/v1/keymaster/agents/:id/app-setup` lists them all.

## 7. FAQ & Common Pitfalls

### 1. Why did registering my repository agent (`POST /api/v1/registry/agents`) fail with `422 new_agents_use_configuration`?
When `FACTORY_NEW_AGENTS_FROM_CONFIGURATION_ONLY` is enabled (`CF6`), the factory only permits new agent IDs to be created as Configuration-Only agents (`POST /api/v1/agents` or via `agent-builder`) unless the ID is explicitly allowlisted.
- **If the agent does not need a custom container:** Create it via `POST /api/v1/agents` (see [Section 2](#2-step-by-step-guide-building-a-configuration-only-agent)).
- **If the agent genuinely requires a Repository-Based Cartridge:** Add the agent ID to `FACTORY_REPOSITORY_AGENT_IDS` in the control plane's environment configuration and retry `POST /api/v1/registry/agents`.

### 2. Why did `POST /api/v1/agents` reject my `roles` definition with `422 unknown_skill`?
Under `CF2`, an agent role may only name skills the agent has **already adopted** (or `"*"`). Because a brand-new agent created via `POST /api/v1/agents` has zero adopted skills at creation time, naming a specific skill ID in `roles` is rejected.
- **Resolution:** Create the agent with `"*"` in `roles` (or omit `roles`), adopt the desired skills via `POST /api/v1/agents/:id/skills`, and then set per-skill role rules via `PUT /api/v1/agents/:id/settings`—or publish the agent via `agent-builder` (`op: "publish"`), which accepts `skills` alongside `roles`.

### 3. Why did my skill package fail offline checks with a `smoke` or `dryRun` error?
Under `TSK-281` (`L4`, `SK1`), every `spec: 1` skill manifest must declare a `smoke:` block (`action`, `input`, and optional `dryRun`), and `factory-skill-checker` executes that handler offline during admission.
- If the smoke action's HTTP method in `actions:` is mutating (`POST`, `PUT`, `PATCH`, `DELETE`) or has `hold: true`, `smoke.dryRun: true` is **mandatory**; omitting it causes admission to refuse the package so activation smoke tests never mutate live external systems.

### 4. Why did `POST /api/v1/agents/:id/convert` fail with `422 uncovered_routes`?
To prevent silent loss of capability during in-place conversion (`CF6`, decision 5), the control plane checks that every route declared in the repository agent's `egress.routes`, `skillRoutes`, and active `policy.routes` is covered by the `requires.routes` of the adopted `skills` (plus `models` and `discord`).
- **Resolution:** Inspect the `uncovered` array in the `422` response. Either include the skill package that declares those routes in `skills`, or pass `"dropUncoveredRoutes": true` to remove the unneeded routes from the agent's policy during conversion.

### 5. Why does my `purpose-built` agent write no files to S3/GCS mind storage?
This is an intentional optimization (`AM1` runtime shim gate, `TSK-283`). When `FACTORY_MEMORY_ARCHETYPE=purpose-built`, `packages/hydrate` skips pulling from and pushing to object storage so stateless task workers start and exit with zero storage latency. If your agent needs persistent episodic memory across wakes, set `memory.archetype` to `personal-assistant` or `team-member`.

### 6. What happens if a shared runtime upgrade (`PUT /api/v1/runtime`) fails smoke for one agent in the fleet?
`PUT /api/v1/runtime` isolates failures per agent (`TSK-280`, `TSK-281`). Every configuration agent whose candidate image passes `runActivationSmoke` upgrades to the new runtime (`status: "updated"`). Any agent whose smoke check fails is automatically rolled back to its previous working image and runtime commit (`status: "smoke_failed"`, ledgered as `AGENT_SMOKE_FAILED` and `AGENT_DEPLOY_FAILED`) and remains online without blocking the rest of the fleet.

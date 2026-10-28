# Creating and Managing Agents: Dual-Mode Hosting Guide

BeerCanLabs Agent Factory supports **dual-mode agent hosting** (DESIGN_AUTHORITY.md §6.18, `CF6`, `RT1`):
1. **Configuration-Only Agents:** The default pattern for all user, team, and business agents.
2. **Repository-Based Agents:** The exceptional pattern reserved exclusively for Factory House Staff or specialized cartridges requiring custom binaries.

This guide explains how to choose between the two models, how to create and deploy configuration agents, how the activation smoke gate guarantees agent health, how shared runtime upgrades are managed, and how to migrate existing repository agents to configuration agents in place.

---

## 1. When to Build a Configuration-Only Agent vs. a Repository-Based Agent (`CF6`, `RT1`)

### Configuration-Only Agents (Default for all user & business agents)
For almost all agents, **Configuration-Only** is the correct architecture:
- **No Git Repository Required:** The agent needs no dedicated source repository, no Dockerfile, and no container build pipeline for its business logic.
- **Shared Agent Runtime:** Runs directly on the official, pre-tested factory runtime image (`runtimes/agent-runtime`, `RT1`).
- **Core Components:**
  - **Persona (`soul.md`):** A prompt describing the agent's identity, mission, communication style, and behavioral constraints (up to 64 KiB).
  - **Memory Archetype (`memory.archetype`):** One of three standardized memory patterns (`purpose-built`, `personal-assistant`, or `team-member` under `AM1`).
  - **Adopted Skills:** Pure Python standard library skills declared in `skills` and packaged conforming to `SK1`–`SK5`.
- **Layered Skills Composition:** If the agent adopts skills, the factory layers only those approved skill packages and their manifest on top of the shared runtime base image (`factory-skills-builder`).
- **Fleet-Wide Maintenance:** When the shared runtime is upgraded, an admin approves the new runtime version once (`PUT /api/v1/runtime`), and all configuration agents upgrade with automatic smoke validation and rollback protection.
- **Creation:** Can be created directly via the API (`POST /api/v1/agents`) or conversationally through the `agent-builder` house staff agent.

### Repository-Based Agents (`FACTORY_REPOSITORY_AGENT_IDS` — Exception Only)
Repository-based agents are cartridges built from a dedicated git repository containing a `cartridge.yaml`, `Dockerfile`, and custom source code (`agent.py`/`agent.ts`).

Repository agents are **strictly restricted** to:
1. **Factory House Staff:** Platform agents located under `agents/staff/*` (`factory-manager`, `agent-builder`, `personal-trainer`).
2. **Explicitly Allowlisted IDs:** Agent IDs enumerated in `FACTORY_REPOSITORY_AGENT_IDS` in the deployment configuration.

**When a repository agent is warranted:**
- The agent requires custom compiled binaries, C-extensions, or system dependencies outside the Python standard library.
- The agent calls privileged factory-internal run-token endpoints (such as `agent-builder` calling `/api/v1/runs/:runId/builder` or `personal-trainer` calling `/api/v1/runs/:runId/training`).

The factory **refuses** registration of any new agent ID from a repository unless the ID is in `FACTORY_REPOSITORY_AGENT_IDS` (`CF6`). Legacy repository agents already registered continue to function, but should be migrated in place using the migration runbook in [Section 5](#5-migration-runbook--converting-an-existing-repository-agent-in-place-post-apiv1agentsidconvert-tsk-283).

---

## 2. Creating an Agent (`POST /api/v1/agents` & Conversational `agent-builder`)

Configuration agents can be created either programmatically via the REST API or conversationally through the `agent-builder` house staff agent.

### Method A: Direct Creation via REST API (`POST /api/v1/agents`)

Users holding the `agents.create` privilege (both `operator` and `admin` roles, decision 7) can create a configuration agent:

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

#### Fields:
- `id` (required): Kebab-case identifier (lowercase letters, digits, dots, dashes, underscores; max 64 characters).
- `name` (required): Human-readable display name.
- `soul` (required): The agent's persona and system instructions (max 64 KiB).
- `memory.archetype` (required): One of the three canonical memory archetypes:
  - `purpose-built`: Task-focused worker; AM1 gate disables mind hydration/replication to eliminate cold-start overhead.
  - `personal-assistant`: Per-user isolated episodic memory keyed by verified user identity.
  - `team-member`: Project- and task-partitioned SQLite workspace memory.
- `roles` (optional): Agent role mapping for channel access control (`E12`). Use `*` for skill access until skills are adopted.

#### Behavior:
- The authenticated creator is automatically recorded as the agent's **owner** (`owners: [principal.actor]`).
- The agent is created in `PENDING_BUDGET` status. It cannot be deployed or woken until an admin configures an egress policy and budget (`PUT /api/v1/agents/:id/policy`).
- The agent has no git repository, no dedicated source build, and no initial egress access.

### Method B: Conversational Creation via `agent-builder`

The factory provides a headless house staff agent: **`agent-builder`** (`agents/staff/agent-builder`, `TSK-282`). Operators and admins can chat with `agent-builder` (via Discord, Webhooks, or the Console) to design, validate, and publish configuration agents conversationally.

During execution, `agent-builder` uses its run-scoped route `POST /api/v1/runs/:runId/builder`:

```http
POST /api/v1/runs/<run-id>/builder
Authorization: Bearer <run-token>
Content-Type: application/json

{
  "op": "catalog"
}
```

#### Supported Operations:
1. **`op: "catalog"`**:
   Returns the current catalog of available components:
   - Approved public and accessible skill packages (`skills`).
   - Approved model catalog offerings (`models`).
   - Valid memory archetypes (`archetypes`: `purpose-built`, `personal-assistant`, `team-member`).
2. **`op: "validate"`**:
   Validates a proposed agent configuration (soul length, memory archetype validity, skill existence and version pins) against the factory contract without creating the agent.
3. **`op: "publish"`**:
   ```json
   {
     "op": "publish",
     "spec": {
       "id": "market-analyst",
       "name": "Market Analyst",
       "soul": "...",
       "memory": { "archetype": "team-member" },
       "skills": [{ "id": "tavily-search", "version": "1.0.0" }]
     }
   }
   ```
   - Checks that the run was requested by a verified human caller holding `agents.create` (refuses if the actor is `SYSTEM`).
   - Invokes the identical code path as `POST /api/v1/agents`.
   - Assigns the requesting human user as the created agent's owner.
   - Sets status to `PENDING_BUDGET`.

---

## 3. Deploying & The Activation Smoke Gate (`TSK-281`, `L4`)

Before an agent can answer messages or execute runs, it must be deployed.

### Deploying the Agent (`POST /api/v1/registry/agents/:id/deploy`)
Once an admin has granted an egress policy and model access (`PUT /api/v1/agents/:id/policy`), the agent owner or an admin triggers deployment:

```http
POST /api/v1/registry/agents/:id/deploy
Authorization: Bearer <token>
```

- If the agent adopts **no skills**, it runs the pinned shared runtime image directly (`FACTORY_RUNTIME_IMAGE`).
- If the agent adopts **skills**, the deployment provider (e.g., CodeBuild `factory-skills-builder` on AWS, or Docker on Compose) layers the approved skill packages from the `SkillPackageStore` onto the runtime base image and pushes `<agentId>-<runtimeCommit>-<skillsHash>`.
- The deploy returns `202 Accepted` and executes asynchronously.

### The Universal Activation Smoke Gate (`runActivationSmoke`, `TSK-281`)
Before any candidate image is activated for an agent (whether configuration-only or repository-based), the factory runs a mandatory **Activation Smoke Gate**:

1. **Isolated Smoke Container:** The factory boots a candidate container with `trigger: "smoke"` and `factoryKind: "smoke"`.
2. **Temporary Factory Policy & Budget:** The factory temporarily grants minimal model access and a temporary budget cap ($0.25 per run / $1.00 per activation) so the smoke run never drains the agent's own budget.
3. **Turn 1 — Soul / Model Completion (`smoke: "hello-world"`):**
   - Injects a hello-world smoke turn.
   - Verifies that the container boots, loads the soul, makes at least one metered model call through Gatekeeper Egress (`E5`), and yields a non-empty `DONE` response.
4. **Turns 2..N — Adopted Skill Verification (`smoke: "skill"`):**
   - For each adopted skill, executes the skill's declared `smoke:` block.
   - Passes `context: { smoke: true, dryRun: boolean }` and sample input.
   - Verifies tool dispatch, parameter validation, and egress route reachability.
5. **Pass Outcome:**
   - Image is activated in the agent registry.
   - Agent transitions to `SLEEPING` (ready for incoming traffic).
   - Ledger records `AGENT_DEPLOYED`.
6. **Failure & Rollback:**
   - If any smoke turn fails, produces an empty reply, or the container crashes:
     - Candidate image is rejected.
     - Agent rolls back to its previously deployed image (or remains undeployed if this was its first deploy).
     - Failure details and container error logs are ledgered in `AGENT_SMOKE_FAILED`.
     - The agent is never left in an un-routable broken state.

---

## 4. Admin-Approved Shared Runtime Rollout (`GET /api/v1/runtime`, `PUT /api/v1/runtime`, `TSK-280`, `RT1`)

The shared runtime version is managed as **Factory Data** (`M3`-style, `R1`), persisted in `<registryDir>/_runtime.json`.

### Inspecting Runtime Status (`GET /api/v1/runtime`)

Any authenticated viewer can inspect the active runtime version and fleet upgrade status:

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
- **Digest Pinning Required (`L4`):** The image must be pinned by `@sha256:` digest. Mutable tags (e.g. `:latest`) are rejected (`invalid_runtime`).
- **Audit Ledger:** Records `RUNTIME_VERSION_SET` with the admin principal, commit, and digest.
- **Automated Rebuild & Smoke:** The control plane triggers `triggerApply("runtime-upgrade")` for every configuration agent whose `deployedRuntime` differs:
  - Agents without skills adopt the new base image directly.
  - Agents with skills are rebuilt by `factory-skills-builder` layering adopted skills on top of the new base image.
  - Each agent runs the **Activation Smoke Gate** (`TSK-281`).
  - On smoke pass: updates `deployedRuntime` and activates new compute.
  - On smoke failure: rolls back that specific agent to its previous working image, records `AGENT_DEPLOY_FAILED`, and continues upgrading other agents.
- **Active Run Safety (`deferred_working`):** If an agent is actively running (`WORKING`), its upgrade is deferred until it finishes its current run, avoiding interrupted conversations.

---

## 5. Migration Runbook — Converting an Existing Repository Agent in Place (`POST /api/v1/agents/:id/convert`, `TSK-283`)

Existing repository agents (`SM-*`) can be converted in place to configuration agents without losing identity, history, or configuration.

### What In-Place Conversion Preserves:
- **Agent Identity:** Retains the exact same `id` and display name.
- **Ledger Audit Trail:** Preserves all historical ledger rows and hashes.
- **Ownership & Access:** Preserves `owners`, user links, and role bindings.
- **Policy & Budgets:** Preserves model grants, route grants, budgets, and spend counters.
- **Memory Prefix:** Retains `memoryPrefix` so episodic mind files remain accessible.
- **Connected Channels & Schedules:** Preserves Discord channel bindings and Timekeeper cron schedules.

### Step-by-Step Migration Runbook

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       IN-PLACE CONVERSION RUNBOOK                           │
│                                                                             │
│  Step 1: S4 Scrub of soul.md                                                │
│         Remove cloud account IDs, ARNs, VPC IDs, or internal URLs           │
│                                                                             │
│  Step 2: Extract Tools to Python stdlib Skill Packages                      │
│         Vendor pure Python dependencies, declare mandatory smoke: block     │
│                                                                             │
│  Step 3: Upload and Approve Skill Packages                                  │
│         factory skill register -> offline checks -> publish/approve         │
│                                                                             │
│  Step 4: Pre-flight Coverage & Policy Check                                 │
│         Verify routes, models, and triggers are covered by skills/channels   │
│                                                                             │
│  Step 5: Execute Conversion (POST /api/v1/agents/:id/convert)               │
│         Builds layered image, runs activation smoke gate, commits or rolls   │
│                                                                             │
│  Step 6: Post-Conversion Verification                                       │
│         Send live turn, verify AM1 mind hydration/replication behavior      │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Step 1: S4 Scrub of `soul.md`
Examine the repository's `soul.md`:
- Remove any committed cloud account IDs, AWS account numbers, ARNs, internal DNS hostnames, or VPC IDs (`S4`).
- Ensure instructions describe capabilities and tone rather than infrastructure addresses.

#### Step 2: Extract Tools into Pure stdlib Python Skill Packages
1. Locate tool definitions in `agent.py` or `tools/`.
2. Package each capability as a conforming skill directory (see [`docs/SKILLS.md`](./SKILLS.md)):
   - Standard library or pure-Python vendored dependencies only.
   - Write `skill.yaml` with required `routes:`, `credentials:`, and `actions:`.
   - **Declare the mandatory `smoke:` block:**
     ```yaml
     smoke:
       action: search-query
       input:
         query: "test"
       dryRun: true # Required true if action is a mutating POST/PUT/DELETE
     ```
3. Test locally using the offline check script:
   ```bash
   factory skill pack ./skills/my-skill
   ```

#### Step 3: Upload and Approve Skill Packages
1. Upload the packaged skill archive:
   ```bash
   factory skill register ./skills/my-skill-1.0.0.tar.gz
   ```
2. Verify that the offline checks pass (`factory-skill-checker` reports `tests: "passed"`).
3. If the skill is to be shared fleet-wide, request and approve publication (`POST /api/v1/skills/:id/publish/approve`). For own use by the same owner, the skill is immediately adoptable upon passing checks.

#### Step 4: Pre-flight Coverage & Policy Check
Inspect the repository agent's declared resources (`cartridge.yaml`):
- **Egress Routes:** Ensure every route the agent needs is declared by an adopted skill.
- **Credentials:** Ensure required credentials are provided by adopted skills or channel integrations.
- **Triggers:** Ensure webhook or schedule triggers are represented.
- **Uncovered Routes:** If the agent declared legacy routes in `cartridge.yaml` that are no longer needed, pass `"dropUncoveredRoutes": true` during conversion; otherwise conversion refuses with `uncovered_routes`.

#### Step 5: Execute In-Place Conversion (`POST /api/v1/agents/:id/convert`)
Execute the conversion endpoint. Requires the agent owner's token and admin approval (`CF4`):

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
  "dropUncoveredRoutes": true
}
```

#### What Happens Internally:
1. Validates that the agent is currently a repository agent (`createdFrom !== 'configuration'`).
2. Validates memory archetype and adopted skill version existence.
3. Checks route coverage: refuses if legacy declared routes are missing unless `dropUncoveredRoutes: true`.
4. Stages candidate configuration into `pendingConfig`.
5. Triggers container build (`factory-skills-builder`) layering adopted skills over the shared runtime.
6. Executes the **Activation Smoke Gate** (`TSK-281`): runs hello-world model completion and per-skill smoke tests.
7. **On Smoke Pass:**
   - Commits configuration to `config.json` and deletes legacy repository attributes (`repo`, `commit`, `buildspec`).
   - Marks `createdFrom: 'configuration'`.
   - Records `AGENT_CONVERTED` and `AGENT_DEPLOYED` in the ledger.
   - Activates new container compute.
8. **On Smoke Failure:**
   - Discards `pendingConfig`.
   - Restores the previous repository image and commit.
   - Records `AGENT_CONVERT_FAILED` or `AGENT_SMOKE_FAILED` in the ledger.
   - The repository agent remains online and operational.

#### Step 6: Post-Conversion Verification
1. **Send Live Turn:** Send a test message via Discord or REST (`POST /api/v1/agents/:id/conversation`). Verify the agent responds normally and invokes adopted skills as needed.
2. **Verify Memory Storage Gate (`AM1`):**
   - If converted to `purpose-built`: inspect mind storage (S3 bucket or directory). Verify that no mind hydration pull or replication push occurred during the run.
   - If converted to `personal-assistant` or `team-member`: verify episodic SQLite database is hydrated and updated.

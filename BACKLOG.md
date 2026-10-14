# Backlog

## DRAFT Framework Onboarding
*   **Feature:** Add a step to the local AI onboarding flow in `AGENTS.md` to offer the user the ability to seamlessly adopt the DRAFT framework.
*   **Workflow:**
    1.  During the Factory deployment interview, the local AI asks: "Do you also want to adopt the DRAFT framework by spinning up a Draftsman agent?"
    2.  If yes, the local AI uses the user's local credentials (`gh repo create`) to bootstrap the `[org]-drafting-table` repository.
    3.  The local AI vendors the upstream DRAFT framework (`github.com/getdraft/draftsman`) into this new repo.
    4.  The local AI automatically registers the Draftsman 1st-party Cartridge into the newly deployed Factory, pointing it to the newly created repo.
*   **Why deferred?** Needs further design and testing to ensure the local AI execution of GitHub CLI commands is robust and doesn't complicate the initial Factory deployment interview.

## User & Project Budgets (Actor-Level Ceilings for Type 3 Workspace Agents)
*   **Feature:** Per-user and per-project budget ceilings for Type 3 (workspace) agents, preventing tragedy-of-the-commons starvation on shared multi-user agents.
*   **Context & Problem:**
    *   Currently, budgets are defined strictly per agent (`AgentPolicy.budgetUsd.perDay` and `perMonth`) in `packages/budget`.
    *   For Type 2 (episodic) agents (e.g., Donna, Archie), an agent budget maps cleanly to single-user sessions or dedicated workflows.
    *   For Type 3 (workspace) agents (e.g., Switch), multiple operators (e.g., Aiden, Dale) collaborate on various projects through the same agent. An agent-level ceiling causes a "tragedy of the commons": one user running heavy code generation or long reasoning loops exhausts the daily/monthly budget, starving all other operators and blocking the agent completely.
    *   Costs on the Factory Ledger (`type: 'llm'`) lack actor attribution, preventing visibility into per-user or per-project spend.
*   **Proposed Architecture:**
    1.  **Identity Link Budget Schema:** Extend `IdentityLink` in `packages/bouncer` and `packages/control-plane` with optional `budgetUsd?: { perDay?: number; perMonth?: number }`.
    2.  **Ledger Event Attribution:** Update `packages/gatekeeper` to record `actor: ctx.run.caller?.actor` on all `type: 'llm'` ledger rows.
    3.  **Actor Spend Tracking:** Update `SpendTracker` in `packages/budget` to aggregate ledger spend by `actor`.
    4.  **Dual Standing Check:** In `gatekeeper-egress` and `control-plane` standing checks, evaluate both agent-level standing (if configured) and caller-level standing. If a caller's budget is exhausted, return HTTP 402 `user_budget_exceeded` (`BLOCKED_USER_BUDGET_EXCEEDED`) for that caller's run only, leaving the shared agent available for other authorized operators.
    5.  **Project Budgets (Phase 2):** Attribute and constrain spend per `project_id` once verified memory scoping (GAP-116) is implemented.
*   **Status:** Queued on backlog (registered in `DESIGN_AUTHORITY.md` as GAP-118, TSK-146).

## Cartridge Skill RBAC (Role-Based Skill Policies for Multi-User Agents)
*   **Feature:** Role-to-skill permission policies for cartridges based on verified `caller.agentRoles`.
*   **Context & Motivation:**
    *   PR #120 (GAP-090 / TSK-144) and PR #123 added Bouncer identity links mapping external callers (Discord, Slack, etc.) to primary actors with agent-specific roles (`agentRoles`, e.g. `{ switch: ['Operator', 'Maintainer'], donna: ['Family'] }`) and injecting verified `caller = { actor, roles, agentRoles, isOwner }` into `input.caller`.
    *   For Type 3 (workspace) agents like Switch, multiple operators and users collaborate on projects in the same workspace.
    *   Powerful or destructive skills (e.g. creating GitHub repositories in `BeerCanLabs`, publishing GitHub Pages, modifying Cloudflare DNS records) must be reserved for designated maintainers/operators (e.g. Aiden, Dale), while non-operator or guest callers should be restricted to conversational or read-only tools.
*   **Architecture & The Donna Test Boundary:**
    *   **The Donna Test (§6.7):** The Factory Bouncer owns *identity mapping* and perimeter authorization (who may wake or converse with an agent). Once inside a cartridge run, *skill dispatch* and tool access policies belong inside the cartridge runtime (e.g. `SM-castle` / DRAFT engine) rather than having the Factory control plane attempt to police container-internal tool calls without runtime visibility.
    *   **Proposed Declarative Schema (`roleSkillPolicySchema`):**
        Cartridges declare a role-to-skill policy matrix (in `cartridge.yaml` or a dedicated `roles.yaml`):
        ```yaml
        roles:
          Maintainer:
            description: "Technical maintainers with full developer access"
            skills:
              github:
                allow: ["repo_create", "push", "pages_enable"]
              cloudflare:
                allow: ["dns_record_create", "access_rule_create"]
          Operator:
            description: "Standard operators"
            skills:
              conversation: ["converse"]
              search: ["web_search"]
              github:
                deny: ["repo_create"]
        ```
    *   **Enforcement Approaches:**
        1.  **Cartridge Engine Enforcement:** The agent framework (e.g. Castle / DRAFT runtime or Python starter engine) loads the role policy at boot and validates `turn.input.caller.agentRoles` before executing any skill or tool invocation, politely refusing unauthorized tool calls.
        2.  **Factory Contract & Shim Validator:** Once standardized across all agent engines, `@beercanlabs/factory-contract` provides the shared schema for `cartridge.yaml`, and the standard runtime shims enforce the matrix.
*   **Status:** Queued on backlog.

## Decoupled Tasks & Schedules (Archetype-Aware Multi-User Timekeeping)
*   **Feature:** Architectural decoupling of scheduled agent activities into four explicit primitives—**Task**, **Schedule**, **Executor**, and **Commissioner**—enabling robust multi-user collaboration, project-level autonomy on Type 3 workspace agents, and lifecycle resilience when individual users depart.
*   **Context & Core Problem:**
    *   Currently, `@beercanlabs/factory-timekeeper` and `packages/control-plane/src/schedules.ts` conflate what to do, when to do it, who runs it, and who asked for it into a single flat struct: `ScheduledAction`.
    *   Under E12 / TSK-177 / GAP-131, every schedule is bound 1:1 to a single `requestedBy` identity. When the schedule fires, `scheduleRunOptions` resolves that specific person's current roles and identity link.
    *   **The Breakdown on Type 3 (Workspace / Team Agents, e.g., Switch, Archie):**
        1.  *User Exits / Deprovisioning:* If an engineer (e.g., Aiden) sets up a nightly vulnerability scan or CI dependency audit for Project X, and later leaves the company or has their link revoked, the scheduled run silently halts (`SCHEDULE_SKIPPED_UNAUTHORIZED`). The automation belonged to the project/team, but was killed by an individual's departure.
        2.  *Multi-User Mutability:* Peer collaborators (e.g., Dale) cannot edit the cron, update the prompt, or cancel the schedule through the agent because `canModifySchedule` enforces creator-only access (`requestersEqual`), returning 404/403 to other teammates.
        3.  *Budget Misattribution:* The scheduled run burns the ex-employee's personal actor budget ceiling (GAP-118 / TSK-146) instead of the project or agent workspace budget.
    *   **The Breakdown on Type 2 (Episodic / Principal + Collaborator Agents, e.g., Donna, Castle):**
        1.  *Personal vs. Shared Disambiguation:* An episodic agent has a single Primary (Owner) and optional secondary users (Family, Collaborators). A task scheduled by a secondary user in a shared channel (e.g., household trash reminder) silently dies if the secondary user exits, leaving the Primary with no visibility or adoption path.
*   **The 4 Core Architectural Elements:**
    1.  **The Task** (*What to do*):
        *   The specification of the intent, prompt, parameters, delivery channel/surface, and execution payload.
        *   Carries an explicit **Scope** defining its boundary and beneficiary:
            *   `personal`: Bound to a single user's private episodic partition (Type 2).
            *   `project`: Bound to a workspace project / repository (Type 3).
            *   `channel`: Bound to a shared communication surface / channel (Type 2 collaborative).
    2.  **The Schedule** (*When to do it*):
        *   The temporal rules: cron expression, time zone, recurrence interval, enabled/disabled state, and last-run / next-due calculation.
        *   **Owned strictly by Timekeeper**: Timekeeper evaluates clock ticks against active schedules and signals the factory when an action is due. It has zero awareness of task semantics, agent prompts, or user permissions.
    3.  **The Executor** (*Who performs it*):
        *   The designated Agent cartridge (`agentId`) that executes the work inside an isolated container.
        *   **Owned by Property Manager**: Property Manager wakes the container, applies memory hydration/checkpointing (§6.6), and supervises execution.
    4.  **The Commissioner** (*On whose behalf*):
        *   The stakeholder or entity authorizing and commissioning the work:
            *   *Provenance / Audit:* `createdBy` (immutable record of the human caller who initiated the schedule).
            *   *Execution Authority:* Resolved based on the Task's **Scope**:
                *   *Project Scope:* Runs under **Project / Agent Authority** (`system` / `SCHEDULER_BADGE` scoped to the agent's declared skills). Survives individual user departures.
                *   *Channel Scope:* Runs under the creator's authority while active; if the secondary user departs/deprovisions, falls back to the Primary (`agent-owner`) authority so shared channel automation is not abruptly broken.
                *   *Personal Scope:* Runs strictly under the creator's authority; if the user departs, the schedule terminates.
*   **Proposed Technical Architecture:**
    1.  **Contract & Timekeeper Types (`packages/timekeeper/src/schedules.ts`):**
        *   Enrich `ScheduledAction` with structured `task: { prompt, name, scope, channelId? }` and `schedule: { cron, timezone, enabled }`, while maintaining flat backward-compatible property accessors.
        *   Add `TaskScope = { kind: 'personal'; userId: string } | { kind: 'project'; projectId: string } | { kind: 'channel'; channelId: string }`.
    2.  **Control Plane & Authority Resolution (`packages/control-plane/src/schedules.ts`):**
        *   Update `scheduleRunOptions`:
            *   If `scope.kind === 'project'`: Issue `SCHEDULER_BADGE` with agent's project authority regardless of whether the original creator is currently active.
            *   If `scope.kind === 'channel'`: Resolve creator link; if invalid, fall back to the agent's `owners` (`agent-owner`) and ledger `SCHEDULE_ADOPTION_FALLBACK`.
            *   If `scope.kind === 'personal'`: Preserve strict E12 check; skip if creator is inactive.
        *   Update `canModifySchedule`:
            *   Allow any caller holding `agent-member`, `operator`, or `owner` on the agent to edit/delete `project`-scoped tasks.
            *   Allow creator and `agent-owner` to edit/delete `channel`-scoped tasks.
            *   Restrict `personal`-scoped tasks to creator and `agent-owner`.
    3.  **Audit Ledger (`packages/ledger`):**
        *   Record `scope` and `commissioner` in `SCHEDULE_CREATED`, `SCHEDULE_UPDATED`, and `SCHEDULE_DELETED` hashes without exposing prompt content (E3).
*   **Status:** Queued on backlog (registered in `DESIGN_AUTHORITY.md` as GAP-146, TSK-202).




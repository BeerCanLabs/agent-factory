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
    2.  **Ledger Event Attribution:** Update `packages/gatekeeper-egress` to record `actor: ctx.run.caller?.actor` on all `type: 'llm'` ledger rows.
    3.  **Actor Spend Tracking:** Update `SpendTracker` in `packages/budget` to aggregate ledger spend by `actor`.
    4.  **Dual Standing Check:** In `gatekeeper-egress` and `control-plane` standing checks, evaluate both agent-level standing (if configured) and caller-level standing. If a caller's budget is exhausted, return HTTP 402 `user_budget_exceeded` (`BLOCKED_USER_BUDGET_EXCEEDED`) for that caller's run only, leaving the shared agent available for other authorized operators.
    5.  **Project Budgets (Phase 2):** Attribute and constrain spend per `project_id` once verified memory scoping (GAP-116) is implemented.
*   **Status:** Queued on backlog (registered in `DESIGN_AUTHORITY.md` as GAP-118, TSK-146).


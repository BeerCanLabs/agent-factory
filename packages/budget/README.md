# Treasurer (`@beercanlabs/factory-budget`)

The Treasurer decides whether an agent is inside its budget. Nothing else in the Factory holds that rule.

- `exceededWindow(limits, spend)`: the first window whose spend is at or over its limit, in the order `perRun`, `perDay`, `perMonth`. An unset limit is not enforced; no `limits` means not over budget.
- `checkStanding({ limits, spend, pendingUsd? })`: the contract callers use. Returns `{ inGoodStanding: true }` or `{ inGoodStanding: false, window }`. `pendingUsd` is spend metered but not yet acknowledged by the control plane and counts toward all three windows.
- `validateBudgetLimits(raw)`: the rules for a policy's `budgetUsd` (an object of non-negative numbers over the three windows).
- `SpendTracker`, `spendDetail`: spend rebuilt from the Auditor's ledger `llm` rows, per run, UTC day and UTC month, grouped by model.
- `priceFor`, `costUsd`: price a model call from per-model rates. The rates are operations data passed in; this package holds none (M3).

Who asks, and who acts on the answer:

- The gatekeeper-egress asks before every model call and answers 402 `budget_exceeded` when the agent is out of standing.
- The control plane asks on ledger ingest and on a policy update (`budget.alert`, `BLOCKED_BUDGET_EXCEEDED`), and `createRun` asks before every wake and refuses with 402 `budget_exceeded` (a queued message stays in the queue; no ledger row is written for it).
- Built-in agents are exempt at the callers.

`packages/conformance/src/treasurer.test.ts` fails if `gatekeeper-egress` or `control-plane` source compares spend with a limit itself.

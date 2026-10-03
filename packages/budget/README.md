# Treasurer (`@beercanlabs/factory-budget`)

The budget-window rule lives here, once.

`exceededWindow(limits, spend)` returns the first window whose spend is at or over its limit, in the order `perRun`, `perDay`, `perMonth`. An unset limit is not enforced. A missing `limits` object means the agent is not over budget.

Callers pass `policy.budgetUsd` (or `undefined`). The control plane and the gatekeeper-egress both call this function; neither keeps a copy of the comparison.

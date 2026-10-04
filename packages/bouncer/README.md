# Bouncer (`@beercanlabs/factory-bouncer`)

The Bouncer decides who may do what and holds what must wait for a person. This package holds the approval record; nothing else in the Factory stores approvals.

- `ApprovalStore`: human-in-the-loop holds for tool calls marked `requireApproval` (E4) and for held requests in a person's name (E9). One approval releases one call.
  - `request(...)`: idempotent per run, route, tool and args hash while the earlier approval is pending or approved.
  - `hold(...)`: E9. Returns the open hold for the same agent, route and hash, returns a rejected one so an identical request is refused rather than asked again, and creates a new hold once the last was consumed.
  - `decide(id, decision, actor, notes?)`: works only on a pending approval and records who, when and the notes.
  - `consume(id)`: works only on an approved approval.
  - `get`, `list({ state?, runId? })`.
- Types: `Approval`, `ApprovalState`, `HeldRequest` (the reviewable copy of a held request).

The control plane hosts the store and its routes. The Gatekeeper authenticates; the Bouncer authorizes.

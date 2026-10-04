# Bouncer (`@beercanlabs/factory-bouncer`)

The Bouncer decides who may do what and holds what must wait for a person. The Gatekeeper authenticates (`packages/auth`
says who the caller is and which roles they hold); the Bouncer authorizes. Users map to roles and roles map to
privileges, never a user to a privilege. The table is built into this package and is read only through `authorize`.

## Authorization

- `authorize({ principal, privilege, resource? })`: `{ allowed: true }` or `{ allowed: false, required }`, where `required`
  is the least role that holds the privilege. `PRIVILEGES` lists the privileges the control plane's routes ask for.
- With a `resource` (`agentId`, `owners`, `requester?`) two more roles can apply, only for the agent-scoped privileges and
  never from `principal.roles`: `agent-owner` (the caller is one of the agent's owners) and `requester` (the caller is the
  run's requesting user). An owner decides a held action only when the run has no requesting user.
- The control plane asks through `requirePrivilege` in `app.ts`; conformance (`packages/conformance/src/authorization.test.ts`)
  fails on a role check elsewhere, a privilege not in `PRIVILEGES`, and a route the matrix test does not list.

## Approvals and held requests (E4, E9)

- `ApprovalStore`: one approval releases one call. `request` (idempotent per run, route, tool and args hash), `hold` (E9:
  returns the open hold, returns a rejected one so an identical request is refused, creates a new one once consumed),
  `decide(id, decision, actor, notes?)` (a pending approval only), `consume(id)` (an approved one only), `get`, `list`.
- Wire types shared by the gatekeeper-egress, the Keymaster and the control plane: `Approval`, `ApprovalState`,
  `HeldRequest`, `ApprovalRequest`, `ApprovalOutcome`, `HoldRequest`, `HoldOutcome`; `HELD_HEADERS`, `HELD_BODY_LIMIT` (raw
  bytes) and `HELD_STORED_BODY_LIMIT` (the same limit as base64 text).
- `describeHeldRequest` (the reviewed copy and the hash of a request: what makes a retry "the same"), `parseHoldRequest`
  (the shape the control plane accepts), `heldCopyOf` and `heldToolName`.
- `checkHold({ hold, method })` and `checkToolApproval({ requireApproval, tool })`: whether a request is held and whether a
  tool call needs approval. The gatekeeper-egress asks and enforces.

The control plane hosts the store, the approval routes and the owners; it acts on a decision (`blockRun`, `deliverDecision`).

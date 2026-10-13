# Gatekeeper (`@beercanlabs/factory-gatekeeper`)

The Gatekeeper is the Factory's perimeter (`DESIGN_AUTHORITY.md` §6.15, A1, A2, E1 to E6, S1): inbound presence and wakes, front-door authentication verification, and zero-trust outbound proxying with credential injection. It authenticates and never authorizes: what a caller may do is the Bouncer's. It was extracted from `packages/gatekeeper-egress`, `packages/gatekeeper-ingress` and `packages/control-plane` (the Gatekeeper flow work stream, GAP-134, TSK-187 to TSK-194).

It holds:

- `src/egress/*`: `createGatekeeperEgress`, the only route out for agents (run-token check, route and host allowlist, credential injection, metering, the tool allowlist and approvals). Its own process: `npm run start` (`dist/egress/main.js`), image from `Dockerfile`.
- `src/ingress/*`: `createGatekeeperIngress`, Discord presence and the wake of a sleeping agent. Its own process: `npm run start:ingress` (`dist/ingress/server.js`), image from `ingress.Dockerfile`.
- `src/policy`, the subpath `@beercanlabs/factory-gatekeeper/policy`: `PolicyStore`, `validatePolicy`, `AgentPolicy`, `GLOBAL_POLICY_ID`, `isReservedPolicyId`: the admin-set egress policy of each agent.
- `src/run-token`, the subpath `@beercanlabs/factory-gatekeeper/run-token`: `verifyRun`, the typed contract for whether a bearer token speaks for a live run of the agent it names. It answers *not a run token*, *refused* or *ok*; the token check, the run lookup and what "ended" means are passed in as plain values.

The entry points are the root and those two subpaths, nothing deeper (D1). The control plane loads the subpaths, not the egress server.

`packages/auth` (`RunTokens`, the roles, the auth providers) stays its own package, hosted by the Gatekeeper. The HTTP handlers that call the Gatekeeper stay in `control-plane` (GAP-133). The identity-link store is the Bouncer's, in `packages/bouncer` (GAP-136, decided). The Keymaster no longer verifies a run token itself (GAP-137 part 1, TSK-201); its `getRun` check is part 2, still open.

The dependency points one way: the control plane depends on the Gatekeeper; the Gatekeeper depends on the Treasurer, Bouncer, Executive, Inspector, Keymaster, Registrar and Auditor packages and never imports the control plane, the Landlord, the Timekeeper or the console. A conformance test (`packages/conformance/src/gatekeeper.test.ts`) fails on a second copy of these rules, on a run token verified by hand elsewhere, or on a back-dependency.

# Landlord (`@beercanlabs/factory-landlord`)

The Landlord is the Factory's compute lifecycle (`DESIGN_AUTHORITY.md` §6.15, L1 to L6): building and registering an agent's runtime, waking it from zero, run states and timeouts, warm-down, the operational pause and kill switches, the turn mailbox and two-stage retirement. It is being extracted from `packages/control-plane` (the Landlord flow work stream, GAP-132, TSK-178 to TSK-186).

It holds so far:

- `callbackPolicyFromEnv`, `checkCallbackUrl`, `signBody`, `deliverCallback`: the signed, retried delivery of a run's callback, and the check that refuses a private or insecure target.

The runtime launchers, the cloud adapters, the run store and the run lifecycle follow in TSK-180 to TSK-184. The HTTP wake and run handlers stay in `control-plane`.

The dependency points one way: the control plane depends on the Landlord; the Landlord never imports the control plane.

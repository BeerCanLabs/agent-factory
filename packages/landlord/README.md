# Landlord (`@beercanlabs/factory-landlord`)

The Landlord is the Factory's compute lifecycle (`DESIGN_AUTHORITY.md` §6.15, L1 to L6): building and registering an agent's runtime, waking it from zero, run states and timeouts, warm-down, the operational pause and kill switches, the turn mailbox and two-stage retirement. It is being extracted from `packages/control-plane` (the Landlord flow work stream, GAP-132, TSK-178 to TSK-186).

It holds so far:

- `callbackPolicyFromEnv`, `checkCallbackUrl`, `signBody`, `deliverCallback`: the signed, retried delivery of a run's callback, and the check that refuses a private or insecure target.

- `Runtime`, `memoryRuntime`, `noopRuntime`, `dockerRuntime`, `dockerApi`, `parseImageMap`, `ecsRuntime`, `defaultEcsCli`, `parseTaskMap`: the runtime launchers, and the build-side types and helpers the cloud adapters share (`SourceRef`, `BuildSkill`, `DeployProvider`, `AdmissionRefusedError`, `imageTagFor`, `skillsHash`, the skills manifest constants).

- `aws/*` and `gcp/*` (subpath exports, loaded lazily so a deployment pulls in only its own cloud's SDKs): the image build (CodeBuild, Cloud Build), the agent execution roles and secret access (IAM), the task and job registration (ECS, Cloud Run) and the `DeployProvider` for each. `landing-zones/` holds the matching infrastructure.

The run store and the run lifecycle follow in TSK-182 to TSK-184. The HTTP wake and run handlers stay in `control-plane`.

The dependency points one way: the control plane depends on the Landlord; the Landlord depends on the Registrar and the Secretary (`packages/hydrate`) and never imports the control plane.

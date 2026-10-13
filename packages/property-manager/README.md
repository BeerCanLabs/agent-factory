# Property Manager (`@beercanlabs/factory-property-manager`)

The Property Manager is the Factory's compute and state lifecycle (`DESIGN_AUTHORITY.md` §6.15, PM1 to PM6, §6.6): building and registering an agent's runtime, waking it from zero, container state hydration in the safe, run states and timeouts, warm-down, the operational pause and kill switches, the turn mailbox and two-stage retirement. It was extracted from `packages/control-plane` (the Landlord/Property Manager flow work stream, GAP-132, TSK-178 to TSK-186), and hosts the in-container runtime shim (`packages/hydrate`, TSK-196).

It holds so far:

- `callbackPolicyFromEnv`, `checkCallbackUrl`, `signBody`, `deliverCallback`: the signed, retried delivery of a run's callback, and the check that refuses a private or insecure target.

- `Runtime`, `memoryRuntime`, `noopRuntime`, `dockerRuntime`, `dockerApi`, `parseImageMap`, `ecsRuntime`, `defaultEcsCli`, `parseTaskMap`: the runtime launchers, and the build-side types and helpers the cloud adapters share (`SourceRef`, `BuildSkill`, `DeployProvider`, `AdmissionRefusedError`, `imageTagFor`, `skillsHash`, the skills manifest constants).

- `aws/*` and `gcp/*` (subpath exports, loaded lazily so a deployment pulls in only its own cloud's SDKs): the image build (CodeBuild, Cloud Build), the agent execution roles and secret access (IAM), the task and job registration (ECS, Cloud Run) and the `DeployProvider` for each. `landing-zones/` holds the matching infrastructure.

- `MemoryRunStore`, `FileRunStore`, `RunStore`, `Run`, `RunState`, `isTerminal`, `RunTokens`: the run store and run tokens.
- `pollQueueOnce`, `startQueuePollers`: SQS queue triggers. They take a `createRun` callback; the Property Manager never imports the control plane.

- `createRun`, `startRun`, `finishRun`, `blockRun`, `unblockRun`, `activeRun`, `resetAgent`, `applyKillSwitch`, `checkHealth`, `reconcileRuns`, `routeEvents`, `deliverToMailbox`, `SYSTEM` and the rest of the run lifecycle (`lifecycle.ts`). They take `PropertyManagerState`, the part of the control plane's `FactoryState` they use, so the Property Manager does not import the control plane.

The extraction is complete (GAP-132). What stays in `control-plane` is GAP-133. A conformance test (`packages/conformance/src/property-manager.test.ts`) fails on a second copy of these rules or on a back-dependency. The HTTP wake and run handlers stay in `control-plane`.

The dependency points one way: the control plane depends on the Property Manager; the Property Manager depends on the Registrar and hosts the in-container runtime shim (`packages/hydrate`), and never imports the control plane.


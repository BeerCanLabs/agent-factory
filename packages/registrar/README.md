# Registrar (`@beercanlabs/factory-registrar`)

The Registrar decides what may be admitted and what is recorded about it (DESIGN_AUTHORITY.md §6.15, GAP-098). It never builds an image, starts a run or answers an HTTP request: the Landlord builds and runs, and the handlers in `packages/control-plane` meet the request. The dependency points one way: the control plane, the Landlord and the Keymaster depend on the Registrar, never the reverse.

This package is being extracted in steps (the Registrar flow work stream, TSK-124 to TSK-132). It holds so far:

- `catalog.ts`: the agent record (`AgentRecord`), the built-in agents, `loadCatalog` (cartridges under `agents/`), `loadDynamicRegistry` (records under the registry directory), `mergeAgents`, and the helpers that read a cartridge's egress, credentials and connections.
- `source.ts`: source pinning (L3): `FULL_SHA` (a commit is a full 40-character SHA, never a branch), `checkRepoUrl`, `gitLsRemoteResolver`, and the skill source (`SkillSource`, `gitSkillSource`, `SourceError`, `checkRefName`, `gitTokenEnv`).
- `skill-checks.ts`: the factory's checks on a skill's code (SK1): the `SkillChecker` contract, `localSkillChecker`, `fakeSkillChecker` and `SKILL_CHECK_SCRIPT` (the script the AWS landing zone's CodeBuild project embeds verbatim). `skillCheckerFromEnv`, which picks the deployment's checker, stays in `packages/control-plane/src/skills.ts` because it loads the Landlord's CodeBuild checker.

- `registry.ts`: `AgentRegistry`, the agent registry's records on disk (`<dir>/<agentId>.json`): `save`, `update` (only a record that exists) and `remove`; a failed write goes to the caller's `warn` and never fails the request.

Still in `packages/control-plane` and moving in later tasks: the configuration store, the skill registry, the systems store and the admission decision. The HTTP handlers stay in the control plane.

The package imports nothing from `control-plane`.

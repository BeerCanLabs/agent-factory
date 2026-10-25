# Skill packages, ownership and groups: plan

Status: **draft, not commissioned.** Written 2026-10-25 from a design conversation with Dale. Nothing here is built.
It is for any person or AI agent picking the work up, and it is self-contained.

## Why

Registering a skill from a repository does not work on the AWS deployment: the control plane reads `skill.yaml` by
running `git`, and its image has none (`spawn git ENOENT` in the control-plane log, first seen 2026-10-09 for
`skill-print`). The fix is not to install `git` there. The control plane takes a repository address from any signed-in
user, and everything else that touches untrusted source runs in an isolated build job. Instead the factory stops
fetching: **a skill is registered by uploading a package**, and the factory publishes what a package must contain.

The same conversation settled who may register, own and share a skill, which needs one new factory capability:
groups.

## Decision labels and how they change

Every decision below carries one label.

- **Human aligned:** Dale agreed to it. Changing it needs human approval: Dale's explicit yes in chat, or approval of
  a pull request by `@dsackr`.
- **Agent decided:** an agent chose it so work could proceed. An agent may change it after approval by a committee of
  other agents: three independent fresh reviewer agents, each given the decision, its rationale and the proposed
  change; it passes with at least two approvals and no unresolved High finding. The change, the votes and the
  reasons go in the decision log at the end of this file in the same pull request.

A decision never changes label by being changed. On approval of this plan, the human-aligned decisions are also
recorded in `DESIGN_AUTHORITY.md` §7 as the user's decisions, and the gaps and tasks are registered, as the first
execution step.

## Human-aligned decisions

| ID | Decision |
| :--- | :--- |
| H1 | The factory's skill store accepts only packaged skills. A supplier registers a skill by uploading a package; a new version is a new upload. The factory publishes what a package may and must contain. The factory never fetches skill source from a repository. |
| H2 | The SDLC fleet builds skills in a GitHub repo and registers them by the same path as anyone else. A person with no fleet packages and uploads the skill when they register it, through the API directly or through the console. The factory does not require the SDLC fleet. |
| H3 | Registering a skill is an access control, held by the built-in admin and agent-owner roles by default. A role given to a group can hold it too. |
| H4 | Skills and agents are content. Whoever registers content owns it: one named user. The owner can transfer it. If the owner's rights are revoked, a factory admin can transfer it. |
| H5 | An owner or a factory admin can assign content to a group. Members of the group get the privileges that the group's roles carry, over that content only. If a group holds the skill-owner role, its members fully manage any skill assigned to the group. |
| H6 | Groups are new: users are added to groups, groups are given roles, roles carry access controls. A built-in role is never the owner of content, because that would make every holder its owner. |
| H7 | A skill is a skill. There are no public and private kinds. A skill that passes the factory's guardrails can be adopted by agents its owner or owner's group owns. |
| H8 | Publishing is what makes a skill adoptable by non-owners, and it needs factory admin approval. |
| H9 | New versions of a published skill are available for adoption automatically, without another admin approval. |
| H10 | Agent owners choose which available skills their agent adopts. An agent stays on the version it adopted until its owner moves it. |
| H11 | Skills are Python only. This is a fact of the current implementation, not a rule that other languages are excluded. |

## Agent-decided decisions

| ID | Decision | Rationale |
| :--- | :--- | :--- |
| A1 | **Package format.** A gzip tarball with `skill.yaml` at its root, a `spec: 1` field naming the package contract version, the code, and its tests. Regular files and directories only: no links, no absolute or `..` paths. At most 5 MiB compressed, 20 MiB expanded and 500 files. Python 3.11 or later. | Small and boring; the limits keep admission cheap and bound the checker. The spec version lets the contract evolve. |
| A2 | **Dependencies are vendored.** A package is self-contained: pure-Python dependencies sit under `vendor/` in the package. Neither the checks nor the build use the network. | Offline and deterministic; the factory stays away from package indexes, and the secret and SDK checks see every file that will run. |
| A3 | **Provenance is optional and untrusted.** The manifest may carry `source: {repo, commit}`. The console shows it; nothing relies on it. The factory records the authenticated registrant (A2 identity), the time and the package hash. | Reviewers want to know where code came from, but a claim in the uploaded file is not evidence. |
| A4 | **The package hash is the pin.** The factory stores each package once, by sha256, in its object store, and a version is immutable and bound to that hash. | Same guarantee as pinning a commit, with no outside dependency. |
| A5 | **One registration endpoint.** `POST /api/v1/registry/skills` takes the package. The console's Register form and the CLI call it. Admission is synchronous: package structure, manifest schema, design rules, duplicate version, registrant's right. It answers 201 with the record and `tests: pending-build`. The checks then run in an isolated job on the stored bytes, as today. | Keeps today's immediate feedback and the existing checker, and drops the manifest-in-the-request workaround. |
| A6 | **A packaging tool in the factory CLI.** `factory skill pack <dir>` builds a conforming package and `factory skill register <dir>` packs and uploads it. People and the SDLC fleet use the same tool. | Authors should not hand-build archives; one tool is the reference for the contract. |
| A7 | **Guardrails are the gate for own use.** The same checks as today (secrets, provider SDKs, hard-coded hosts, build, tests) run on every version. A version that passes can be adopted by the owner's agents with no further approval. What a skill needs (routes, connections, credentials) is still granted separately, as today. | Follows H7. The factory's own approval of a version already grants nothing by itself. |
| A8 | **Privileges.** `skill.register`; and, scoped to one skill, `skill.version.add`, `skill.retire`, `skill.transfer`, `skill.assign`, `skill.publish.request`. `skill.publish.approve` is admin-only and cannot be given to another role. The same scoped pattern is meant for agents later. | Publishing and approving stay separate rights (H8). The factory already scopes export to one agent the same way. |
| A9 | **Built-in roles.** A built-in `skill-owner` role carries the scoped privileges in A8 except approval. Admins can define further roles from the privilege list. | The smallest set that makes H5 usable. |
| A10 | **Group membership is kept in the factory.** Admins create groups and add or remove users. Mapping groups from the identity provider is not part of this plan. | Works the same on every deployment; identity-provider mapping can be added later without changing the model. |
| A11 | **Only a human user owns content.** An agent never owns content. The SDLC fleet registers on behalf of the requesting person, so that person is the registrant and owner, and then assigns the content to the team that should manage it. | An agent cannot grant itself access; this keeps ownership and accountability with people. |
| A12 | **Adoption rule.** An agent's owner (or a group member whose roles allow it) can adopt a skill that they own, that is assigned to a group they belong to, or that is published. | Direct consequence of H5, H7, H8. |
| A13 | **Retirement.** An owner, a group member with `skill.retire`, or an admin can retire a version. Retiring stops new adoption and flags current adopters; agents already deployed keep running until their owner moves them. Unpublishing works the same way for the skill as a whole. | Nothing changes under a running agent (H10), and a bad version still cannot spread. |
| A14 | **Builds read the store.** The skills image build takes packages from the factory's store by hash. It no longer clones skill repositories, so skill builds need no source token. | The point of H1; also removes a credential from the build. |
| A15 | **Existing registrations stay valid.** Versions already registered from a repository remain pinned records and keep working. New versions must come as packages. No migration is required. | Avoids a flag day for existing agents. |
| A16 | **Order of work is an execution-time call.** The slices below are a suggestion. | Dale's standing preference. |

## What this replaces in the current design

- Repository-based registration and the control plane's `git` use for skills (`packages/registrar/src/source.ts`,
  the skill path in `packages/registrar/src/skills.ts`), and the manifest-in-the-request workaround.
- The owner-approval step for private skills (§6.18 CF5, PR #228). Own-use adoption now needs only passing the
  guardrails (H7, A7).
- The owner-agent binding on private skills. Who may adopt now comes from ownership, group assignment or
  publication (A12).
- The public and private visibility kinds (H7).
- `compose-skills.sh` cloning skill repositories with a token during the skills image build (A14).
- The e2e check's fixture skill, which is now registered by uploading a package built from `examples/skills/e2e-ping`.
- `docs/SKILLS.md`, which describes registration from a repository.

Unchanged: the checker script and its checks, the manifest schema (plus `spec` and optional `source`), adoption as a
per-agent versioned choice, the ledger rows for registration and refusal, and one container per agent run.

## Suggested slices

Each slice is its own pull request, reviewed by a fresh reviewer until clean.

1. **Register the plan.** Record H1 to H11 in `DESIGN_AUTHORITY.md` §7, and add the gaps and tasks.
2. **The package contract and store.** Package spec and validator, content-addressed storage, the single upload endpoint with synchronous admission, the checker reading stored bytes, the builder reading the store, `factory skill pack` and `register`, and the console upload form. The e2e check switches to a packaged fixture.
3. **Groups and ownership.** Groups, owner on content, transfer, assignment to groups, the scoped privileges and the `skill-owner` role, for skills first and agents next.
4. **Publishing.** The publish request and admin approval, the adoption rule, retirement and unpublishing.
5. **Retire the old path.** Remove repository registration and the owner-approval step, and update `docs/SKILLS.md`.

## Not in this plan

Identity-provider group mapping; languages other than Python; migrating existing repository-registered skills.

## Decision log

| Date | ID | Change | Label | Approved by |
| :--- | :--- | :--- | :--- | :--- |
| 2026-10-25 | all | Plan drafted | H1 to H11 human aligned; A1 to A16 agent decided | Dale for H; none yet for A |

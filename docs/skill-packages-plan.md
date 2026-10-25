# Skill packages, ownership and groups: plan

Status: **draft, not commissioned.** Written 2026-10-25 from a design conversation with Dale. Nothing here is built.
It is for any person or AI agent picking the work up, and it is self-contained.

## Why

Registering a skill from a repository does not work on the AWS deployment: the control plane reads `skill.yaml` by
running `git`, and its image has none (`spawn git ENOENT` in the control-plane log, first seen 2026-10-09 for
`skill-print`). The fix is not to install `git` there. The control plane takes a repository address from any signed-in
user and connects to it, while everything else that touches untrusted source runs in an isolated build job. Instead
the factory stops fetching: **a skill is registered by uploading a package**, and the factory publishes what a package
must contain. The control plane never fetches source and never runs uploaded code. It reads only a bounded, non-extracting
view of the upload (A19).

The same conversation settled who may register, own and share a skill, which needs one new factory capability: groups.

## Decision labels and how they change

Every decision below carries one label.

- **Human aligned:** Dale agreed to it. Changing it needs human approval: Dale's explicit yes in chat, or approval of a
  pull request by `@dsackr`.
- **Agent decided:** an agent chose it so work could proceed. An agent may change it after approval by a committee:
  three fresh reviewer agents, started by the orchestrating session that is carrying out the change and not by the agent
  that wrote the proposal, each given only the decision, its rationale and the proposed change. Each reviewer sets the
  severity of its own findings. The change passes with at least two of the three approving (a 2 to 1 vote passes) and no
  High finding left standing; a High finding stands until the reviewer who raised it withdraws it after a revised
  proposal. A reviewer that does not answer counts as not approving. A revised proposal starts a new vote. The change, the votes and the reasons go in the
  decision log in the same pull request. **A change that touches a human-aligned decision or a Design Authority
  invariant is human-gated, whatever the committee says.**

A decision never changes label by being changed. Decisions stay in this file with their labels: slice 1 copies into
the Design Authority only the amendments in the table below, and Dale's approval of slice 1 is his confirmation of every
amendment in it, including those that follow from agent-decided items. Once recorded there, an amendment is Design
Authority text and is human-gated.

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

Where an agent decision narrows or clarifies the reading of a human-aligned one, the rationale says so.

| ID | Decision | Rationale |
| :--- | :--- | :--- |
| A1 | **Package format.** A gzip tarball with `skill.yaml` at its root, a `spec: 1` field naming the package contract version, the code, and its tests. Python 3.11 or later. At most 5 MiB compressed, 20 MiB expanded, 500 files, 2 MiB per file and 255 characters per path. | Small and boring; the limits keep admission cheap and bound the checker. The spec version lets the contract evolve. |
| A2 | **Dependencies are vendored.** A package is self-contained: pure-Python dependencies sit under `vendor/`. Neither the checks nor the build use the network, so the checker's `pip install` is removed. The runtime and the checker's test run put `vendor/` on `sys.path` beside the skill folder (`runtimes/agent-runtime/runtime/skills.py` today adds only the folder). Tests run with `unittest`, and with `pytest` when a pytest configuration exists; the checker image has pytest baked in. | Offline and deterministic. The factory stays away from package indexes. |
| A3 | **Provenance is optional and untrusted.** The manifest may carry `source: {repo, commit}`. The console shows it; nothing relies on it. The factory records the authenticated registrant, the time and the package hash. | Reviewers want to know where code came from, but a claim in the uploaded file is not evidence. |
| A4 | **The package hash is the pin.** Each package is stored once by sha256. A version is immutable and bound to its hash. | Same guarantee as pinning a commit, with no outside dependency. |
| A5 | **One registration endpoint.** `POST /api/v1/registry/skills` takes the package as a raw `application/gzip` body, read by a new body reader capped at 5 MiB for this route only. The console's form and the CLI call it. Admission is synchronous: the registrant's right, package structure (A19), manifest schema, design rules, duplicate version. It answers 201 with the record and `tests: pending-build`. The checks then run in an isolated job on the stored bytes. | Keeps today's immediate feedback and checker, and drops the manifest-in-the-request path. |
| A6 | **A packaging tool in the factory CLI.** `factory skill pack <dir>` builds a conforming package and `factory skill register <dir>` packs and uploads it. People and the SDLC fleet use the same tool. | One reference implementation of the contract. |
| A7 | **Guardrails are the gate for own use.** The checks (secrets, provider SDKs, hard-coded hosts, build, tests) run on every version. A version that passes can be adopted by the owner's agents with no further approval. What a skill needs (routes, connections, credentials) is still granted separately, as today. | Follows H7. Approving a version already grants nothing by itself. |
| A8 | **Privileges.** Existing names stay: `skills.register` is fleet-wide, held by admin and by anyone who owns any agent, and is removed from the viewer, operator and approver roles that carry a copy today; `skills.retire` becomes scoped to one skill; `skills.decide` stays admin-only and is the publish approval. New, scoped to one skill: `skills.version.add`, `skills.assign`, `skills.publish.request`, `skills.transfer`. "Owns any agent" is a new derived condition, because today's derived agent-owner role covers only privileges scoped to one agent. | Publishing and approving stay separate rights (H8). The factory already scopes privileges to one agent this way. |
| A9 | **Built-in `skill-owner` role.** It carries `skills.version.add`, `skills.retire`, `skills.assign` and `skills.publish.request`, and **not** `skills.transfer`. Admins can define further roles from the scoped skill privileges. | Narrows the reading of H5: "fully manage" means managing the skill, not changing who owns it. A group member cannot take a skill from its owner. |
| A10 | **Group membership is kept in the factory.** Admins create groups and add or remove users. Mapping groups from the identity provider is not part of this plan. | Works the same on every deployment; identity-provider mapping can be added later. |
| A11 | **Only a human user owns content, and an agent registers only for a verified requester.** An agent's registration is accepted only when the run's verified requester (the run's caller, AM2) is the person it registers for and that person holds `skills.register`, the same pattern as CF2. That person is the registrant and owner; the ledger records the agent as actor. An agent cannot name another person. | An agent cannot grant itself access; ownership and accountability stay with people. |
| A12 | **Adoption rule.** An agent's owner can adopt a skill that they own, that is assigned to a group they belong to, or that is published. Group members whose role allows adoption can do the same for agents assigned to their group. | Direct consequence of H5, H7, H8. |
| A13 | **Retirement follows SK6.** Retirement is of the whole skill, by the owner, a group member with `skills.retire`, or an admin, and is refused while an agent uses it. An admin's `force` pauses adopters, strips the skill from their configurations and redeploys them, as SK6 records. Withdrawing a single version is the existing revoke. Unpublishing stops new adoption by non-owners and flags current adopters; it does not touch deployed agents. | Keeps the recorded behavior instead of inventing a second one. |
| A14 | **Builds and checks read the store.** The skills image build and the skill checker take packages by hash. For package versions neither clones a skill repository nor needs a source token. The clone path in `compose-skills.sh` stays, accepting both pin shapes (repository and commit, or package hash), until no agent adopts a repository-registered version. | The point of H1, without stranding agents on existing versions. |
| A15 | **Existing registrations stay valid.** Versions registered from a repository remain pinned records. Their owner is their registrant if that is a user, otherwise an admin. The skill id is the skill's identity: any new version of an existing id must come from its owner, a group member with `skills.version.add`, or an admin. Today a different repo or path is a different skill; that rule goes away. | No flag day, and no one gets an id by uploading to it. Owners re-upload a repository-registered version as a package when they want it off the clone path; slice 5 removes the clone path only after none remain adopted. |
| A16 | **Order of work is an execution-time call.** The slices below are a suggestion. | Dale's standing preference. |
| A17 | **Group roles are limited.** A role given to a group may contain only the scoped skill privileges. It may never be the built-in admin role or contain `skills.decide`. It may contain `skills.register`, as H3 says. | H5 says "over that content only"; this makes it enforceable without narrowing H3. |
| A18 | **Assignment shares with members only.** A group assignment makes the skill adoptable by the group's members, not by others. The owner must be a member of the target group; an admin may assign to any group. Assignment does not publish. | Closes a path around H8. It narrows H5, which lets an owner assign to any group. |
| A19 | **Packages are validated defensively.** The control plane does only bounded, non-extracting work on an upload: it counts bytes as it reads, reads the tar listing and `skill.yaml` (at most 64 KiB), and writes nothing to disk. It refuses absolute or backslash paths, `..`, NUL or control characters, duplicate or case-colliding names, any entry that is not a regular file or directory, setuid bits, and files or paths over the limits in A1. Limits apply to bytes actually read, never to declared sizes. Compiled or binary files (`.pyc`, `.so`, `.pyd`, `.dll`, `.dylib`, `.exe`) and the names `.git` and `__pycache__` are refused. A package must be a single gzip stream with no trailing data; pax and GNU long-name headers are refused. Extraction in the checker and builder applies the same rules. | Keeps untrusted content out of the control plane's disk and process, and stops archive bombs and traversal. |
| A20 | **The checker scans every file in the package, with no skip list.** `vendor/` is included in the secret and provider-SDK scans and excluded from the hard-coded-host and tests checks. | Vendored libraries carry URLs and tests that would trip those two checks; the network fence (gatekeeper-egress) still applies to hosts. |
| A21 | **Package storage is a provider abstraction.** A `SkillPackageStore` per landing zone (object storage on AWS and GCP, a volume on compose) holds packages. The checker and the builder read it with their own cloud identity, not a source token or a presigned link. Packages that fail the checks are quarantined: readable only by the checker and by admins, and kept 30 days so an admin can review and re-run the checks, then deleted. An admin, and the owner and group members of a skill, can list and view a package's files through a read-only endpoint (text only, escaped); there is no bulk download. That is also how an admin reviews a skill before approving its publication (H8). | Keeps the landing zones cloud-agnostic, and gives the admin who approves publishing a way to read the code. A failed package is kept only where an admin can read it. |
| A22 | **The manifest drops `visibility` and `owner`.** A `spec: 1` manifest that contains them is refused. `language: python` stays. Old records keep their fields as history, and they play no part in new decisions. | Ownership comes from registration (H4), and visibility is replaced by publication (H7). |
| A23 | **Who adds versions.** The owner, a group member with `skills.version.add`, and an admin. | Spells out what H5 and H9 imply. |
| A24 | **Transfer needs the recipient.** A transfer is pending until the recipient, who must hold `skills.register`, accepts it. An admin may transfer without acceptance when the owner's rights have been revoked; revoked means the owner has lost the `skills.register` right or the account is disabled. | Stops a skill being dumped on someone, and defines revoked. |
| A25 | **Scope: skills only.** The ownership, group and role model in this plan applies to skills. Agents keep their current ownership model (several owners, CF2) and are not changed here. Extending the model to agents is a separate plan. | Agents have several owners today and their privileges depend on that. H4 and H5 name agents as content, so this narrows the plan's scope, not the intent. |
| A26 | **Ledger rows.** New rows: package uploaded (with hash), transfer requested and accepted, assignment, group created and membership changed, publish requested and approved, unpublished. Existing registration and refusal rows stay. | The ledger invariants expect an auditable row for each. |
| A27 | **Approval path while the work lands.** A package has no private or public kind (A22), so until slice 4 every uploaded package takes the admin-approval flow. Slice 4 replaces it with H7 to H10. | Keeps one path at any time. |

## Amendments to the Design Authority

The plan overrides recorded decisions. Slice 1 amends each one in `DESIGN_AUTHORITY.md` §6 with an explicit "Amends"
entry, confirmed by Dale, and adds a §7 change-log row.

| Recorded decision | Amended by | What changes |
| :--- | :--- | :--- |
| SK1: any authenticated user may register; a skill is its source; per-version admin approval of public versions | H1, H3, H7, H8, H9 | Registration is of a package by a role-holder; admin approval is of publishing a skill; later versions flow. |
| SK2: admin review of declared holds at version approval | H9, A7 | Later versions and own-use adoption have no review; holds still apply at run time. |
| SK3 and CF4: every public adoption needs an admin decision | H7, H8, H10 | Owners adopt what they own or what is published. |
| SK6: retire is admin-only | A13 | Owner and group members with the privilege can retire; `force` stays admin-only. |
| SK7: visibility and owner-agent bindings | H7, A22 | Replaced by ownership, assignment and publication. |
| SK8: inline skills are private skills of their agent | H7, A25 | Inline skills are registered as packages by their owner. |
| CF3, CF5: bundle import registers and approves private skills; owner approves a private skill version | H7, A7, A27 | The owner-approval step goes in slice 4. |
| SK4: builds are from pinned commits | A4, A14 | Skill builds are from package hashes; the clone path stays for repository-registered versions (A14). |
| SK5: private skills are auto-adopted | H7, H10 | Owners choose what to adopt; nothing is adopted for them. |
| SK6: re-adoption after revocation follows the private kind | H7 | Follows ownership and publication instead. |
| §6.15 Bouncer (roles are built into the code; admin-editable roles are "a later enhancement") and the party table row "Register a skill (SK1): any authenticated user"; GAP-090 | H3, H6, A8, A9, A17 | Groups and admin-defined roles arrive for skills; registering needs a role; the `skills.register` copies in the viewer, operator and approver roles go. |
| §6.15 Registrar, Landlord and Property Manager entries that describe repository fetch and the repository-based build | H1, A14 | They describe package intake and builds from the store. |

## What this replaces

- Repository-based registration and the control plane's `git` use for skills (`packages/registrar/src/source.ts`, the
  skill path in `packages/registrar/src/skills.ts`), and the manifest-in-the-request path in the control plane's
  `skills.ts`.
- The skill checker's repository clone and `pip install` (`packages/registrar/src/skill-checks.ts`, the
  `factory-skill-checker` project in `landing-zones/aws/codebuild.tf` and its GCP counterpart): it reads stored packages
  and runs offline (A2, A14).
- `landing-zones/aws/compose-skills.sh` cloning skill repositories with a token during the skills image build (A14).
- The owner-approval step for private skills (§6.18 CF5, PR #228), the owner-agent binding and the public and private
  kinds, in slice 4.
- The e2e check's fixture skill, which is registered by uploading a package built from `examples/skills/e2e-ping`.
- `docs/SKILLS.md`, which describes registration from a repository.

Unchanged: the checks themselves (secrets, provider SDKs, hard-coded hosts, build, tests), the manifest schema apart from
A22 and the new `spec` and optional `source`, adoption as a per-agent versioned choice, and one container per agent run.

## Suggested slices

Each slice is its own pull request, reviewed by a fresh reviewer until clean.

1. **Amend the Design Authority.** The amendments above, the gaps and the tasks, and the conformance rows for SK1 to SK8, CF3 and CF5.
2. **The package contract and store.** Package spec and validator (A1, A19), the store (A21), the upload endpoint (A5), the checker and builder reading the store (A2, A14, A20), `factory skill pack` and `register` (A6), the console upload form, and the e2e check switched to a packaged fixture (registered by an admin; its `skill.yaml` drops `visibility: public`, which `spec: 1` refuses). Packages follow the existing approval flow (A27).
3. **Groups and ownership for skills.** Groups, owner on skills, transfer, assignment, the scoped privileges and the `skill-owner` role, the on-behalf-of rule (A11), and the ledger rows (A26).
4. **Publishing.** The publish request and approval, the adoption rule, retirement and unpublishing; the owner-approval step is removed.
5. **Retire the old path and update the docs.** Remove repository registration, rewrite `docs/SKILLS.md`.

## Not in this plan

Identity-provider group mapping; languages other than Python; migrating existing repository-registered skills; ownership, groups and roles for agents (A25).

## Decision log

| Date | ID | Change | Label | Approved by |
| :--- | :--- | :--- | :--- | :--- |
| 2026-10-25 | H1 to H11 | Plan drafted | Human aligned | Dale |
| 2026-10-25 | A1 to A27 | Plan drafted and revised after two rounds of review of PR #235 | Agent decided | none yet |

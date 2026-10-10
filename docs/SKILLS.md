# Skills: a guide for skill authors

A **skill** is a reusable piece of agent code, such as "post run progress to Discord" or "read a Google Calendar", that
any agent can adopt. The factory keeps a registry of skills. Each version is registered from an exact commit, checked
at admission and approved by a factory admin before any agent can use it (DESIGN_AUTHORITY.md §6.14 SK1).

This guide covers the manifest, registration, the approval flow, what a skill's requirements mean, and how agents adopt
skills.

## 1. The manifest: `skill.yaml`

Each skill has a `skill.yaml` in its folder. The folder can be a whole repository, a folder in a skills monorepo, or a
folder inside an agent's repository.

```yaml
id: discord-progress            # kebab-case, unique in the factory
version: 1.0.0                  # semantic version; each version is registered and approved separately
name: Discord progress
description: Renders a run's progress events as one live status message in the channel that asked.
language: python                # the factory checks python skills (section 4)
entry: discord_progress/render.py  # a module or a path inside the skill folder
requires:                       # all optional; each list defaults to empty
  routes: [discord]             # gatekeeper-egress route ids the skill calls
  connections:                  # Keymaster connections (provider plus scopes, §6.11 K1)
    - provider: google
      scopes: [https://www.googleapis.com/auth/calendar.readonly]
  credentials:                  # static credentials by name only, never a value
    - name: DISCORD_BOT_TOKEN
      source: discord           # Keymaster instruction catalog id (§6.11 K5)
      description: Bot token for the progress message
  models: [claude-haiku-4-5]    # factory model names (§6.9 M1)
visibility: public              # public (default) or private; see below
# owner: higgins                # a private skill names its one owner agent; a public skill names none
actions:                        # what the skill does; optional for skills written before actions existed
  - id: post-message            # kebab-case, unique in the skill
    route: discord              # must also be in requires.routes
    method: POST
    path: /channels/{id}/messages   # a path, never a URL; starts with one "/"
    hold: true                  # required: true = a person approves the exact request first; false = autonomous
```

The schema lives in `packages/contract/src/skill.ts` (`skillManifestSchema`, `validateSkillManifest`). Unknown keys
are refused, so a manifest can't carry a secret value.

**Visibility and owner (§6.14 SK1).** A skill is **public** (any agent can be given it, with approval) or **private**
(it names one owner agent, and only that agent can adopt it). Both are set when the skill is registered and never
change; to change either, register a new skill. A private skill without an `owner`, or a public skill with one, is
refused at admission.

**Actions and `hold` (SK2, E9).** Each action names the route, method and path the skill takes. `hold: true` means
the action is human-in-the-loop: nothing is sent until a person approves that exact request, and the approval is
written to the ledger first. `hold: false` means the action is autonomous. There is no default: an action that doesn't
say is refused. An action must go through a route the skill lists in `requires.routes`, and its path is a path, never a
host or URL. The declared `hold` is recorded and shown to the admin who approves the version, but the
gatekeeper-egress cannot enforce it per action until grants carry actions (GAP-070).

## 2. What `requires` means: a request, not a grant

`requires` lists what the skill needs to work. It grants nothing (§6.14 SK2):

- **The agent's policy decides.** An agent with no admin-set policy has no egress (E7). Adopting a skill lets a policy
  owner grant what the skill declares. A policy can't grant more than the agent's source plus its approved skills declare
  (E8). Enforcement is per agent: inside an agent, a skill can do only what that agent's policy allows.
- **Routes, not hosts.** Skills declare gatekeeper-egress **routes** by id (`discord`, `github`, `notion`). They never
  declare a raw host, URL or IP. Every outbound connection goes through the gatekeeper-egress (E1).
- **Models by name.** Skills name factory models (`claude-haiku-4-5`), never a provider id
  (`anthropic/...`, `bedrock:...`) or an endpoint. Every model call is metered through a gatekeeper-egress provider
  route (E5, M1).
- **Skills never hold secrets (S1).** A credential is declared by name. The Keymaster holds it, and the
  gatekeeper-egress injects it into the matching outbound request. Don't declare platform keys that the
  gatekeeper-egress already holds, such as model provider keys. They need no declaration, and admission refuses them.
  Declare the route or the model instead.

## 3. Registering a version

Register by naming the repository, the skill's folder (`.` for the repository root) and the commit. The factory reads
`skill.yaml` itself and pins the commit.

### From the dashboard

Open **Skills** in the console's sidebar and choose **Register a skill**. Enter:

- **Repository URL**: `https://github.com/your-org/skill-discord-progress`;
- **Path**: the skill's folder (`.` for the repository root, `skills/notes` in a monorepo);
- **Commit, branch or tag**: a full SHA, or a branch or tag name such as `main` or `v1.2.0`.

The factory reads `skill.yaml` in that folder at that commit with its own read-only source token, so you don't paste
the manifest. A branch or tag is resolved now to the full SHA it points at, and the version is recorded at that SHA:
the pin never moves, even if the branch does. If something is wrong, the form shows the reasons (section "Admission
checks").

### From the command line (Claude Code, scripts)

The same endpoint, without a manifest. Behind Cloudflare Access, sign in once with `cloudflared` and send your Access
token, so the factory records the registration under your own identity (§6.12 A2):

```bash
cloudflared access login https://<factory>
curl -X POST "https://<factory>/api/v1/registry/skills" \
  -H "cf-access-token: $(cloudflared access token -app=https://<factory>)" \
  -H "Content-Type: application/json" \
  -d '{"repo": "https://github.com/your-org/skill-discord-progress", "path": ".", "commit": "main"}'
```

The response is the version's record. When you give a branch or tag, it also says which one (`"resolvedFrom": "main"`);
`commit` is the full SHA. This is how an engineer using Claude Code registers a skill as themselves: Claude runs the two
commands above in their terminal.

You can still send the parsed manifest yourself (`"manifest": { ... }`, for example from `yq -o=json skill.yaml`). Then
`commit` must be a full 40-character SHA: a branch is resolved only when the factory reads `skill.yaml` itself.

### The factory's source token

When no manifest is sent, the control plane fetches the one commit with git and reads `<path>/skill.yaml`. It
authenticates with the factory's read-only source token, `FACTORY_AGENT_SOURCE_TOKEN` (the same token admission builds
use), and sends it only over https to the hosts in `FACTORY_AGENT_SOURCE_TOKEN_HOSTS` (comma-separated, default
`github.com`), never to a host a caller typed. Without a token, public repositories still work. A private repository
must grant the token read access.

Any authenticated user can register. A successful registration returns `201` with the version's record:
`{ id, version, repo, path, commit, manifest, status: "pending", tests: "pending-build", checkRun, registeredBy,
registeredAt }`. Registering also starts the factory's checks on the code (section 4).

### Admission checks

A registration is refused with `422 { "error": "skill_refused", "reasons": [...] }` when:

- the repository isn't an https git URL, the commit isn't a full SHA (or, without a manifest, a branch or tag), or the
  path leaves the repository;
- without a manifest: the factory can't fetch the repository (`repo: cannot fetch ...; check that the factory's source
  token can read this repository`), the branch, tag or commit doesn't exist, there is no `skill.yaml` at that path and
  commit, or it isn't valid YAML;
- the manifest doesn't match the schema;
- that version is already registered for this id (versions are immutable, so bump the version);
- the manifest breaks a design rule: a raw host as a route, a model that isn't a plain name, a gatekeeper-held
  platform key as a credential, or a requirement declared twice.

The ledger records every refusal (`SKILL_REFUSED`), along with who made the request and the commit.

## 4. The factory's checks on your code

Like a pull request that merges only when its required checks pass, a version can be approved only after the factory
has fetched it at its pinned commit, checked its code and run its tests (§6.14 SK1). The checks start when the version is
registered. The version's record shows where they are:

| Field | Meaning |
|---|---|
| `tests` | `pending-build` while the checks run, then `passed` or `failed` |
| `checkRun` | the run in progress: `{ id, checker, startedAt, startedBy }` |
| `checks.at`, `checks.run` | when the last run ended, and which run it was |
| `checks.failures` | short reasons when it failed (a file and line, never a value) |

### What is checked

The checks run in the skill's folder at the pinned commit, on Python 3.11 or later:

1. **The manifest.** `skill.yaml` at that commit must match the manifest you registered. Empty lists are the same as
   absent ones.
2. **No committed secrets (S1).** The patterns of the factory's own secret scan (`scripts/secret-scan.sh`): known token
   formats, private keys, and secret-like names assigned long literal values. Every file counts, tests and docs included,
   and a skill can't opt a line out. Build test credentials at test time instead of committing them.
3. **No provider SDKs (E1, E5).** No import of `boto3`, `botocore`, `aiobotocore`, `anthropic`, `openai`, `xai`/`xai_sdk`,
   `vertexai`, `google.cloud`, `google.genai`, `google.generativeai` or `google.ai.generativelanguage`, by `import`,
   `from … import`, `__import__` or `importlib.import_module`. None of those as a dependency either, in
   `requirements*.txt` or `pyproject.toml` (project, optional and dependency groups, and Poetry). A skill reaches a
   provider through a gatekeeper-egress route, which meters model calls and injects credentials.
4. **No hard-coded hosts (E1).** Code may not name an external host or URL (`https://discord.com/...`,
   `api.openai.com`, a public IP address). Read the route's address from its `*_BASE_URL` environment variable, or
   `FACTORY_URL` for the factory itself. Loopback, `.internal` names and `example.com` are fine. Docs (`*.md`, `*.rst`,
   `*.txt`, `docs/`, `examples/`), docstrings and tests may hold example URLs, and so may package metadata
   (`pyproject.toml`, `setup.cfg`).
5. **It builds.** Every `.py` file parses, and the manifest's `entry` exists, either as a file or as a module.
6. **Its tests pass.** For `python`, the factory installs `requirements.txt`, `requirements-dev.txt` and
   `requirements-test.txt` if present, then runs `python -m unittest discover` in the skill's folder. If a pytest
   configuration exists (`pytest.ini`, `conftest.py`, `[tool.pytest.ini_options]` in `pyproject.toml`, `[tool:pytest]`
   in `setup.cfg` or `[pytest]` in `tox.ini`), it also runs `pytest`. Your tests run without the factory's cloud
   credentials or source token.

The only language checked so far is `python`. Any other language is refused until the factory can check it.

### Making your tests discoverable

`unittest discover` finds files named `test*.py` in importable folders, starting from the skill's folder:

```
skill.yaml
discord_progress/__init__.py
discord_progress/render.py
tests/__init__.py          # required: makes tests/ importable
tests/test_render.py       # class ...(unittest.TestCase)
```

Run `python3 -m unittest discover` in the skill's folder before you register. If it prints `Ran 0 tests`, the factory
finds none either. Prefer the standard library. If you use pytest, add a pytest configuration so the factory runs it.

### Failure messages

| Failure | What to do |
|---|---|
| `manifest: skill.yaml at this commit does not match the registered manifest (version, requires.routes)` | Register the manifest that is committed at that commit, or commit the one you registered (as a new version). |
| `manifest: no skill.yaml in the skill folder at this commit` | Check `path` and `commit`. |
| `secrets: tools/client.py:12 looks like a hard-coded credential` | Remove it, rotate it, and declare the credential by name in `requires.credentials`. |
| `provider SDK: skill/llm.py:3 imports anthropic` | Call the model through the gatekeeper-egress provider route and declare the model in `requires.models`. |
| `provider SDK: requirements.txt:2 depends on boto3` | Remove the dependency and use a gatekeeper-egress route. |
| `hosts: skill/post.py:8 hard-codes discord.com` | Read the base URL from `DISCORD_BASE_URL` (or the route's `*_BASE_URL`) and declare the route. |
| `build: skill/x.py:4 does not parse as Python (...)`, `build: entry ... is not a file or module in the skill folder` | Fix the code or the manifest's `entry`. |
| `build: pip could not install requirements.txt` | Pin installable versions. |
| `tests: no tests found (unittest discovers test*.py files in importable folders)` | Add tests (see above). |
| `tests: python -m unittest discover failed (FAILED (failures=1))`, `tests: pytest failed (...)` | Run them locally; the check log has the output. |
| `language: node is not supported by the factory checks yet (supported: python)` | Only Python skills can be approved for now. |
| `source: could not fetch the repository at the pinned commit` | The repository must be reachable by the factory's source token, and the commit must be pushed. |
| `checks: the check run ended FAILED in INSTALL without a result: ...` | The check itself failed to run. Ask an admin to re-run it. |

At most 20 reasons are recorded, in at most 1000 characters. The rest are counted (`... and 3 more`) and appear in the
check log.

### Where the checks run, and re-running them

On AWS, each check is a build of the `factory-skill-checker` CodeBuild project (`landing-zones/aws/codebuild.tf`). Like
agent admission, it clones the pinned commit with the factory's read-only source token, has no access to the factory's
network, and reports its result when the build ends. The control plane follows the build in the background, as it does
for admission builds, and resumes following it after a restart. `FACTORY_SKILL_CHECKER` selects the checker:
`codebuild` (the default where admission uses CodeBuild), `local` (development: runs on the control plane's machine and
needs `git` and `python3`), or `none` (the default elsewhere: versions stay `pending-build`).

An admin can re-run the checks on a version that isn't approved, for example after a transient failure:

```bash
curl -X POST "$FACTORY_URL/api/v1/registry/skills/discord-progress/versions/1.0.0/checks" \
  -H "Authorization: Bearer $FACTORY_ADMIN_TOKEN"
```

The response is `202` with the record back at `pending-build`. A newer run supersedes an older one, and only the newest
run's outcome is recorded. Errors: `404` (unknown version), `409 already_approved` (an approved version's checks are
settled), `501 checker_not_configured`, `502 start_failed`. Each run is ledgered (`SKILL_CHECKS_STARTED`, then
`SKILL_CHECKS_PASSED` or `SKILL_CHECKS_FAILED` with a hash of the reasons).

## 5. Approval: every version, by an admin

A new version is `pending`. A factory admin reviews it (the commit, the code, the requirements) and approves or rejects
it.

### From the dashboard

**Skills** lists every skill with its versions, newest first. Each version shows its status (pending, checks running,
checks passed, checks failed, approved, rejected or revoked), the check results with their failure reasons, what it
requires (routes, connections with scopes, credentials, models), the repository, path and commit (linked), who
registered it and when, and who decided it, when and why. The skill shows its latest approved version. Everyone signed
in can see this; the actions below are shown to admins only.

- **Approve** is enabled only when the checks passed. Add a reason if you like, then confirm.
- **Reject** (a pending version) or **Revoke** (an approved one) asks for a reason. If agents use the version, the
  factory refuses and the dialog lists them. **Revoke anyway and pause these agents** asks once more, naming the agents,
  before it revokes and pauses them (see "Revoking a version").
- **Re-run checks** starts the checks again; the version shows "checks running" and updates when they end.

The screen refreshes the catalog once a minute while it is open.

### From the API

```bash
curl -X POST "$FACTORY_URL/api/v1/registry/skills/discord-progress/versions/1.0.0/approve" \
  -H "Authorization: Bearer $FACTORY_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason": "reviewed at the pinned commit"}'

curl -X POST "$FACTORY_URL/api/v1/registry/skills/discord-progress/versions/1.1.0/reject" \
  -H "Authorization: Bearer $FACTORY_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason": "posts raw tokens to the channel"}'
```

Each decision is ledgered with the admin's identity (`SKILL_APPROVED`, `SKILL_REJECTED`). **Only approved versions can
be adopted.** An approved earlier version doesn't make later versions approved: every version goes through approval.

## 6. The catalog

Any viewer can read the catalog:

| Endpoint | Returns |
|---|---|
| `GET /api/v1/skills` | every skill: name, description, `latestApproved` (or `null`), its requirements, and each version with its status, pin, checks (and the run in progress), and its decision (`decidedBy`, `decidedAt`, `reason`, `revoked`) |
| `GET /api/v1/skills/:id` | one skill, with every version's full record |
| `GET /api/v1/skills/:id/versions/:version` | one version's record |
| `GET /api/v1/skills/:id/adopters` | the agents that use the skill (`approved`: in the agent's configuration) and the pending requests, each with who asked and who approved, and whether a newer approved version is available |

`requires` in the catalog is the latest approved version's, or the newest registered version's if none is approved yet.
Each skill also shows `visibility`, `owner` (private skills), `retired`, and its `adopters`.

**A private skill is visible only to admins and to the owners of its owner agent.** To anyone else it doesn't exist:
the list leaves it out and its other endpoints answer `404`.

## 7. Adoption is deployment configuration

An agent adopts a skill by configuration in the factory, not by a pull request or a code change (§6.14 SK3). The
agent's configuration record lists each adopted skill pinned to an approved version. When the configuration is applied,
the factory builds one image from the agent's source plus each skill at its pinned commit, and deploys exactly that
image (SK4). No code is loaded at runtime. When a newer approved version exists, the owner sees "skill update available"
and decides when to upgrade (SK5).

**What exists today (TSK-158).** The routes below change an agent's configuration record: a new version listing the
adopted skill, with who asked and who approved, and a ledger row. The build and redeploy that make an adoption take
effect on the running agent are the next slice (TSK-159); until then the configuration says what the agent *should*
run.

| Endpoint | Who | What it does |
|---|---|---|
| `GET /api/v1/agents/:id/skills` | any viewer | the agent's adopted skills, pending requests, revocations, and the skills it could adopt now (public skills and its own private ones) |
| `POST /api/v1/agents/:id/skills` `{skillId, version, reason?}` | admin or the agent's owner | asks to adopt (or upgrade to) an approved version; the request shows what access it would add |
| `POST /api/v1/agents/:id/skills/:skillId/adoption/approve` `{reason?}` | admin only | approves the request: writes the new configuration version. It never grants access: the agent's policy still names the routes |
| `POST /api/v1/agents/:id/skills/:skillId/adoption/reject` `{reason?}` | admin only | ends the request, changing nothing |
| `DELETE /api/v1/agents/:id/skills/:skillId` `{reason?}` | admin or the agent's owner | removes the adoption (a new version without it), or withdraws a pending request |
| `POST /api/v1/registry/skills/:id/retire` `{reason?, force?}` | admin only | retires every version: no new version, no new adoption. Refused while an agent adopts it (`409 skill_in_use`); `force` pauses those agents and removes the skill from their configuration; no adoption can start while it runs, and the response lists `paused`, `pauseFailed` and `removedFrom` |

**A forced retire and agents that cannot be paused.** Pausing only flips the agent's state, so it fails in two cases: the
agent is unknown, or it is a built-in agent, which is exempt from the kill switch. Neither is an error to retry, so a
forced retire does not stop for it: the skill is still removed from that agent's configuration and the agent is listed in
`pauseFailed`. Until the redeploy (TSK-159) an agent that was not paused keeps running what it was deployed with.

**One control plane.** Adoption changes for an agent run one at a time, and a forced retire blocks new adoptions of the
skill, by locks held in the control plane's memory. That matches the rest of its stores, which assume one process; a
second replica would not see them.

An owner can ask and remove but never decide: an adoption adds access, so an admin approves it. Asking for a version that
is unapproved, retired, or already adopted is refused (`skill_not_approved`, `skill_retired`, `already_adopted`). A new request for a skill that already has a pending one replaces it, and the response says so (`replacedRequest`).

**Private skills adopt themselves.** Approving a version of a private skill adopts it for its owner agent in the same
step (the response lists `adopted`), with the approving admin recorded as the approver. A later version moves the owner
to it. If the owner removes the skill, later versions are no longer adopted automatically: the owner asks again and an
admin approves (SK6). Registering a private skill needs an admin or an owner of the named agent, and the agent must
exist.

## Who can register, and what counts as the same skill

- Any authenticated user can register a public skill. Registering never makes it usable: an admin approves each version.
- A private skill can be registered by an admin or an owner of the agent it names.
- A skill's visibility and owner never change. A new version that would change either is refused: register a new skill.
- A skill is its source. Every version of a skill id comes from the same repository and path. A different repository
  or path is a different skill, so register it under a different id.

## Revoking a version

An admin can revoke an approved version (`POST /api/v1/registry/skills/:id/versions/:version/reject`). If any agent's
configuration pins that version in its `skills` list (the factory reads its configuration store), the factory refuses (`409 skill_in_use`) and lists those agents: redeploy
them without the skill first. An admin may override with `{"force": true}`, which revokes the version at once and
pauses every agent using it until it is redeployed without it. A revoked version's record is `rejected` with `revoked: true`.

## Checks before approval

Approval returns `409 checks_pending` while the checks run (or when no checker is configured), and `409 checks_failed`
with the reasons when they failed. See section 4.

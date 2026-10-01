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
```

The schema lives in `packages/contract/src/skill.ts` (`skillManifestSchema`, `validateSkillManifest`). Unknown keys
are refused, so a manifest can't carry a secret value.

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

Register by naming the repository, the skill's folder (`.` for the repository root), the full 40-character commit, and
the parsed `skill.yaml`. The factory pins that commit. A branch name or a short SHA is refused.

```bash
# Convert skill.yaml to JSON (yq, or any YAML parser) and post it with the pin.
MANIFEST=$(yq -o=json skill.yaml)
curl -X POST "$FACTORY_URL/api/v1/registry/skills" \
  -H "Authorization: Bearer $FACTORY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"repo\": \"https://github.com/your-org/skill-discord-progress\",
    \"path\": \".\",
    \"commit\": \"$(git rev-parse HEAD)\",
    \"manifest\": $MANIFEST
  }"
```

Any authenticated user can register. A successful registration returns `201` with the version's record:
`{ id, version, repo, path, commit, manifest, status: "pending", tests: "pending-build", checkRun, registeredBy,
registeredAt }`. Registering also starts the factory's checks on the code (section 4).

### Admission checks

A registration is refused with `422 { "error": "skill_refused", "reasons": [...] }` when:

- the repository isn't an https git URL, the commit isn't a full SHA, or the path leaves the repository;
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
it:

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
| `GET /api/v1/skills` | every skill: name, description, `latestApproved` (or `null`), its requirements, and each version with its status, pin and checks |
| `GET /api/v1/skills/:id` | one skill, with every version's full record |
| `GET /api/v1/skills/:id/versions/:version` | one version's record |

`requires` in the catalog is the latest approved version's, or the newest registered version's if none is approved yet.

## 7. Adoption is deployment configuration

An agent adopts a skill by configuration in the factory, not by a pull request or a code change (§6.14 SK3). The
agent's configuration record lists each adopted skill pinned to an approved version. When the configuration is applied,
the factory builds one image from the agent's source plus each skill at its pinned commit, and deploys exactly that
image (SK4). No code is loaded at runtime. When a newer approved version exists, the owner sees "skill update available"
and decides when to upgrade (SK5).

The configuration store and adoption are delivered by TSK-052, TSK-054 and TSK-055. This registry provides what they
build on: approved, pinned versions.

## Who can register, and what counts as the same skill

- Any authenticated user can register a skill. Registering never makes it usable: an admin approves each version.
- A skill is its source. Every version of a skill id comes from the same repository and path. A different repository
  or path is a different skill, so register it under a different id.

## Revoking a version

An admin can revoke an approved version (`POST /api/v1/registry/skills/:id/versions/:version/reject`). If any agent's
configuration pins that version in its `skills` list (the factory reads its configuration store), the factory refuses (`409 skill_in_use`) and lists those agents: redeploy
them without the skill first. An admin may override with `{"force": true}`, which revokes the version at once and
pauses every agent using it until it is redeployed without it.

## Checks before approval

Approval returns `409 checks_pending` while the checks run (or when no checker is configured), and `409 checks_failed`
with the reasons when they failed. See section 4.

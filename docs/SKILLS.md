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
language: node                  # e.g. node, python
entry: src/index.ts             # a module or a path inside the skill folder
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

Registration needs the `operator` role. A successful registration returns `201` with the version's record:
`{ id, version, repo, path, commit, manifest, status: "pending", tests: "pending-build", registeredBy, registeredAt }`.

### Admission checks

A registration is refused with `422 { "error": "skill_refused", "reasons": [...] }` when:

- the repository isn't an https git URL, the commit isn't a full SHA, or the path leaves the repository;
- the manifest doesn't match the schema;
- that version is already registered for this id (versions are immutable, so bump the version);
- the manifest breaks a design rule: a raw host as a route, a model that isn't a plain name, a gatekeeper-held
  platform key as a credential, or a requirement declared twice.

The ledger records every refusal (`SKILL_REFUSED`), along with who made the request and the commit.

Running the skill's own tests and building it happens in the factory's build step (TSK-054). Until that step runs for a
version, its record says `tests: "pending-build"`.

## 4. Approval: every version, by an admin

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

## 5. The catalog

Any viewer can read the catalog:

| Endpoint | Returns |
|---|---|
| `GET /api/v1/skills` | every skill: name, description, `latestApproved` (or `null`), its requirements, and each version with its status and pin |
| `GET /api/v1/skills/:id` | one skill, with every version's full record |
| `GET /api/v1/skills/:id/versions/:version` | one version's record |

`requires` in the catalog is the latest approved version's, or the newest registered version's if none is approved yet.

## 6. Adoption is deployment configuration

An agent adopts a skill by configuration in the factory, not by a pull request or a code change (§6.14 SK3). The
agent's configuration record lists each adopted skill pinned to an approved version. When the configuration is applied,
the factory builds one image from the agent's source plus each skill at its pinned commit, and deploys exactly that
image (SK4). No code is loaded at runtime. When a newer approved version exists, the owner sees "skill update available"
and decides when to upgrade (SK5).

The configuration store and adoption are delivered by TSK-052, TSK-054 and TSK-055. This registry provides what they
build on: approved, pinned versions.

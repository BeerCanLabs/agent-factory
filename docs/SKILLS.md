# Skills: A Guide for Skill Authors and Operators

A **skill** is a reusable, self-contained package of agent capabilities (such as tools, API integrations, and helper logic) that agents in the BeerCanLabs Agent Factory can adopt.

Skills are distributed and registered as immutable, content-addressed archives (`.tar.gz`) stored by SHA-256 hash. The factory operates completely offline during checks and builds: dependencies are vendored, no network access is permitted during admission or container composition, and packages never include committed secrets or cloud provider SDKs.

---

## 1. Skill Packages & The Manifest (`skill.yaml`)

Every skill package is a gzip tar archive (`.tar.gz`) containing at its root a `skill.yaml` manifest specifying `spec: 1`, Python code, vendored dependencies, and tests.

### Package Limits & Validation (A1, A19)
- **Archive size**: At most 5 MiB compressed.
- **Extracted size**: At most 20 MiB expanded.
- **File limits**: At most 500 entries, at most 2 MiB per entry.
- **Path limits**: At most 255 characters per path; paths must be relative and POSIX-compliant (no `..`, no leading `/`, no backslashes).
- **Prohibited entries**: No compiled binaries (`.pyc`, `.so`, `.pyd`, `.dll`, `.dylib`, `.exe`), no `.git/` directories, and no `__pycache__/`.
- **Pure-stream**: Single gzip stream with standard tar headers; pax and GNU long-name headers are refused.
- **Mandatory Smoke Gate (`smoke`) (TSK-281)**: The manifest must declare a `smoke` block (`action`, `input`, and optional `dryRun`). Mutating actions (`POST`/`PUT`/`PATCH`/`DELETE` in `actions:`) and actions requiring approval (`hold: true`) require `dryRun: true`; otherwise admission is refused.

### The Manifest Specification (`spec: 1`)

```yaml
spec: 1                             # Contract specification version (required, must be 1)
id: tavily-search                   # Kebab-case identifier (lowercase letters, digits, single hyphens, max 64 chars)
version: 1.0.0                      # Semantic version (immutable once registered)
name: Tavily Search                 # Human-readable display name
description: Real-time search tools for web discovery.
language: python                    # Python 3.11+
entry: tavily_search                # Python module name or relative file path to load tools()

requires:                           # Declarations of required resources (grants nothing by itself)
  routes: [tavily]                  # Gatekeeper egress route IDs
  credentials:
    - name: TAVILY_API_KEY
      description: Platform credential for Tavily search API
  models: [claude-haiku-4-5]       # Model catalog IDs if model completions are used

actions:                            # Declarative description of external HTTP actions
  - id: execute-search
    route: tavily
    method: POST
    path: /search
    hold: false                     # false = autonomous; true = human approval required

smoke:                              # Mandatory smoke test specification (TSK-281, L4)
  action: execute-search            # Action ID from actions: or declared tool name
  input:                            # Argument dictionary passed to tool handler
    query: ping
  dryRun: true                      # Required true if action is mutating (POST/PUT/PATCH/DELETE) or has hold: true

source:                             # Optional provenance metadata (untrusted informational record)
  repo: https://github.com/BeerCanLabs/skills
  commit: 0123456789abcdef0123456789abcdef01234567
```

> [!NOTE]
> Under `spec: 1`, the manifest **drops** `visibility` and `owner` (A22). Ownership is bound at upload time to the authenticated user, and visibility is determined by publishing status and group assignment.

---

## 2. Directory Layout & Vendoring (A2)

Packages are self-contained and run offline. Any external pure-Python dependencies must be vendored under a `vendor/` subdirectory:

```
my-skill/
├── skill.yaml
├── my_skill/
│   ├── __init__.py                 # Exposes tools() -> list[dict]
│   └── search.py
├── vendor/                         # Pure-Python third-party packages (no native extensions)
│   └── requests/
└── tests/
    ├── __init__.py
    └── test_search.py              # unittest or pytest test cases
```

### Tool Definition (`entry`)
The Python entry module must define a `tools()` function returning a list of tool definitions:
```python
def tools():
    return [
        {
            "name": "search_web",
            "description": "Searches the web for given query terms",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query"}
                },
                "required": ["query"],
            },
            "handler": handle_search,
        }
    ]

def handle_search(arguments: dict, context: dict) -> str:
    query = arguments.get("query", "")
    # Outbound requests must use gatekeeper egress routes (e.g. TAVILY_BASE_URL)
    return f"Results for {query}"
```

---

## 3. Packaging & Registration (A5, A6)

### Using the Factory CLI

The Factory CLI (`@beercanlabs/factory-cli`) provides commands to inspect, package, and upload skills:

```bash
# Package a skill directory into a conforming .tar.gz archive:
factory skill pack ./skills/my-skill

# Package and immediately upload/register to the factory:
factory skill register ./skills/my-skill
```

### Using the REST API

Users with the `skills.register` privilege (admins and agent owners) register skills by streaming the `.tar.gz` archive directly as `application/gzip`:

```bash
curl -X POST "https://<factory-host>/api/v1/registry/skills" \
  -H "Authorization: Bearer $FACTORY_TOKEN" \
  -H "Content-Type: application/gzip" \
  --data-binary @my-skill-1.0.0.tar.gz
```

On success, the factory responds with `HTTP 201 Created` and the skill version record. The package is verified defensively in memory, written to the content-addressed `SkillPackageStore`, and queued for offline checks.

---

## 4. Isolated Offline Checks (A7, A14, A20)

Once uploaded, the factory checks the package in an isolated build environment (AWS CodeBuild, GCP Cloud Build, or local container runner) completely isolated from the network:

1. **Manifest Integrity**: Validates `spec: 1` structure, semver, kebab-case id, and design rules.
2. **Secret Scan (S1)**: Refuses packages containing hard-coded credentials, private keys, or API tokens. Scans all files including `vendor/`.
3. **Provider SDK Gate (E5)**: Prohibits direct imports or dependencies on cloud/AI vendor SDKs (`boto3`, `anthropic`, `openai`, `google.genai`, etc.). All model access must go through the Gatekeeper Egress.
4. **Network Perimeter (E1)**: Code may not hard-code external hostnames or IPs. All outbound traffic routes through designated `*_BASE_URL` Gatekeeper endpoints.
5. **Syntax & Entry Verification**: Confirms that all Python files parse cleanly and the `entry` module exists.
6. **Automated Test Execution**: Tests in `tests/` run offline using `unittest` or `pytest`. Both the skill root and `vendor/` are placed on `sys.path`.
7. **Smoke Handler Execution (TSK-281)**: `SKILL_CHECK_SCRIPT` executes the handler for `smoke.action` in an isolated subprocess with `smoke.input` and `context={"smoke": True, "dryRun": smoke.dryRun}`. The check confirms that the handler runs without unhandled exceptions, honors `dryRun`, and returns a bounded, valid string result.

---

## 5. Governance: Ownership, Groups, and Publishing

### Content Ownership (H4)
Whoever uploads a package is recorded as its **owner**. Ownership grants full management of that skill:
- Uploading subsequent versions (`skills.version.add`).
- Assigning the skill to groups (`skills.assign`).
- Requesting public publication (`skills.publish.request`).
- Retiring the skill (`skills.retire`).
- Transferring ownership (`skills.transfer`) to another user, requiring recipient acceptance (A24).

### Groups (H5, H6, A10, A18)
Admins can create groups and assign roles to them. When an owner assigns a skill to a group, members of that group gain the privileges carried by the group's roles over that skill.
For example, members of a group with the built-in `skill-owner` role can add versions, retire, and manage assignments for any skill assigned to that group.

### Guardrails Gate & Own-Use Adoption (H7, A7)
Once a skill version passes the factory's automated checks, it is **immediately available for adoption** by any agent owned by the skill's owner or members of assigned groups. No manual admin approval is needed for own use.

### Publishing Workflow (H8, H9)
To make a skill available to the entire fleet (all agent owners):
1. The skill owner or a group member requests publication (`POST /api/v1/skills/:id/publish/request`).
2. A factory admin reviews the code (using read-only inspection `GET /api/v1/skills/:id/versions/:version/package/files`) and approves (`POST /api/v1/skills/:id/publish/approve`).
3. Once published, the skill is visible in the public catalog, and any agent owner can adopt it.
4. New versions uploaded by the owner for a published skill flow automatically without requiring repeated admin approvals.

---

## 6. Adoption & Container Composition (SK4, A14)

Agents adopt skills via deployment configuration (`POST /api/v1/agents/:id/skills`).

When an agent configuration with adopted skills is deployed:
1. The provider admission builder (`landing-zones/aws/compose-skills.sh`) fetches each pinned skill by its immutable `packageHash` from the `SkillPackageStore`.
2. The package archive is verified against its SHA-256 hash and unpacked into `/opt/factory/skills/<id>/`.
3. A consolidated manifest is generated at `/opt/factory/skills.json`.
4. A container layer is built and pushed as `<agent>-<commit>-<skills-hash>`.
5. At runtime, the agent runtime loads `/opt/factory/skills.json`, adds each skill's root and `vendor/` to `sys.path`, and registers tool handlers with the model turn loop.

### The Activation Smoke Gate (TSK-281, L4)
Before any candidate image layer containing adopted skills is activated for an agent, the factory executes the candidate container in smoke mode (`runActivationSmoke`):
- **Turn 1**: Executes baseline hello-world agent turn verifying model completion through Gatekeeper Egress (`E5`).
- **Turns 2..N**: Executes each adopted skill's declared `smoke:` action against the live container.
- **Verification**: The candidate container must dispatch the tool, inject smoke context, complete without errors, and record egress audit rows on all required routes.
- **Rollback on Failure**: If any adopted skill fails its smoke turn, the deployment aborts, the failure is ledgered (`AGENT_SMOKE_FAILED`), and the agent rolls back to its prior healthy image without downtime.

---

## 7. Language Support (RT2)

**Skills are Python only. That is the current implementation, not a design limit:** the factory's skill checks and runtime run Python 3.11+. Other languages may be supported in future updates to the checks and runtime.


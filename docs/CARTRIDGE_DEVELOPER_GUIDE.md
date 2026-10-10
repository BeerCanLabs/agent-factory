# The Cartridge Developer Guide: Building Autonomous Agents for BeerCanLabs Agent Factory

Welcome to the **BeerCanLabs Agent Factory** Cartridge Developer Guide. 

This guide teaches software engineers how to design, package, test, and deploy portable, enterprise-grade AI agent cartridges using the **Console vs. Cartridge** paradigm.

---

## 1. Core Philosophy: The "New Hire" Mental Model

Traditional AI frameworks encourage developers to build monolithic agents—blurring the infrastructure, orchestration, secrets management, and reasoning loops into a single script. In production, this causes security vulnerabilities, runaway token spending, and cloud vendor lock-in.

The Agent Factory solves this with a strict separation: **The Console vs. The Cartridge**.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                              THE CONSOLE (The Enterprise Host)                              │
│  - Defends the network perimeter (No public IPs or open ports on agents)                     │
│  - Ingress: Listens to Discord, Slack, Webhooks, APIs, and Cron schedules                   │
│  - Identity: Binds secrets from AWS Secrets Mgr / Azure KeyVault / Vault at boot            │
│  - Filing Cabinet: Hydrates and syncs persistent mind from S3/GCS/Blob storage              │
│  - gatekeeper-egress: Meters every token, enforces budget circuit breakers, logs audit ledger   │
└──────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                               │ Runs in sandbox
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                              THE CARTRIDGE (The Digital Employee)                           │
│  - 1. Job Description (soul.md): Who the agent is, tone, rules, operational boundaries      │
│  - 2. Employment Contract (cartridge.yaml): When they work, access required, tools, memory   │
│  - 3. Performance Rubric (bench.yaml): Acceptance tests & cost-vs-quality scorecard rubric   │
│  - 4. Hands & Eyes (agent.py / agent.ts): Pure task reasoning using standard tools & SDKs    │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

When building a cartridge, **think of yourself as hiring a digital employee**:
1. *How would you explain the job to someone you hired?* → **`soul.md`**
2. *When should they show up to work, and what access badge do they need?* → **`cartridge.yaml`**
3. *What tools do you put on their desk?* → **Tools & MCP Peripherals**
4. *Where is their personal notebook or desk drawer?* → **Persistent Memory (`/memory`)**
5. *How will you evaluate them on their performance review?* → **`bench.yaml`**

The developer focuses 100% on **agent intelligence and domain tools**. The **Console** handles the rest.

---

## 2. Anatomy of a Cartridge

A complete agent cartridge lives in a single folder:

```
my-agent/
├── soul.md                  # 1. Job Description & Operational Boundaries
├── cartridge.yaml           # 2. Employment Contract (Triggers, Secrets, Tools, Memory)
├── bench.yaml               # 3. Performance Rubric (Deterministic Test Cases - Optional)
├── agent.py                 # 4. Agent Code (Python or TypeScript)
├── requirements.txt         # 5. Dependencies
└── Dockerfile               # 6. Container Packaging
```

---

## 3. Step 1: Write the Job Description (`soul.md`)

`soul.md` is the agent's system prompt and behavioral contract. It defines:
- **Identity & Role:** Who the agent is and what team it belongs to.
- **Mission & Responsibilities:** What specific outcomes it must achieve.
- **Tone & Communication Style:** How it responds (concise, analytical, professional).
- **Negative Constraints:** What the agent is **strictly forbidden** from doing.

### Example: `soul.md`
```markdown
# Job Description: Operations Assistant

You are the Operations Assistant for BeerCanLabs.

## Mission
You analyze incoming infrastructure alerts, diagnose anomalies, recommend remediations, and keep human operators informed.

## Tone & Communication
- Direct, concise, and structured.
- Use bullet points for incident timelines and metrics.
- Never guess or extrapolate metrics when data is unavailable.

## Operational Boundaries (Strict Rules)
1. **Zero Destructive Actions:** You may inspect and diagnose systems. You may NOT reboot, delete, or modify production databases or infrastructure without human operator approval.
2. **Sensitive Data:** Never print raw credentials, customer PII, or internal tokens in notifications or logs.
3. **Memory Logging:** Summarize all diagnosed anomalies in your persistent operations log.
```

---

## 4. Step 2: Author the Contract (`cartridge.yaml`)

`cartridge.yaml` is the single machine-enforced configuration file that binds the cartridge to the Factory Console.

### Key Sections:
1. **`triggers` (Ingress):** When does this agent wake up? (e.g. Webhook, Cron schedule, Discord bot mention, HTTP wake).
2. **`secrets.requires` (Access):** What credentials does the code need? (Cartridges declare **variable names**, never secret values).
3. **`persistence` (Memory):** What object-storage prefix should store the agent's local memory?
4. **`compute`:** What OCI container image runs the agent?

### Full `cartridge.yaml` Specification:
```yaml
schemaVersion: "1.0"
id: ops-assistant
name: "Operations Assistant"
role: "Infrastructure Incident Triage"
prompt: "./soul.md"

# When does the agent wake up?
triggers:
  - type: webhook
    path: /hooks/ops-alerts
    secretRef: ALERT_WEBHOOK_SIGNING_SECRET
  - type: cron
    schedule: "0 8 * * 1-5" # Mon-Fri at 8:00 AM UTC
  - type: discord
    secretRef: DISCORD_BOT_TOKEN

# What access does the agent need? (Names only!)
secrets:
  requires:
    - name: ALERT_WEBHOOK_SIGNING_SECRET
      description: "HMAC signing secret for inbound webhook validation"
    - name: PAGERDUTY_API_KEY
      description: "API key to query active incident states"
    - name: SLACK_BOT_TOKEN
      description: "Token to send alerts to #ops-alerts"

# Personal Filing Cabinet / Persistent State
persistence:
  enabled: true
  prefix: "ops-assistant-state"

# Compute definition
compute:
  kind: oci
  ref: "ghcr.io/myorg/ops-assistant:1.0.0"
  localCommand:
    - python3
    - agent.py

# Optional: Warm conversation window before scaling back to zero (seconds)
runtime:
  warmDownSeconds: 3600

# Network Egress Policy (routes and allowed hosts for zero-trust perimeter)
# See docs/NETWORK_ISOLATION_AND_EGRESS.md for details
egress:
  routes:
    - llm              # anthropic, openai reverse-proxy routes
    - discord          # derived automatically if a discord trigger is present
  hosts:
    - api.pagerduty.com # allowed target hosts for HTTP_PROXY / CONNECT tunneling

# Optional: Environmental MCP peripherals and skills
skills:
  - id: pagerduty-ops
    description: "Inspect active alerts and incident timelines via PagerDuty"
```

> [!IMPORTANT]
> **Zero Plaintext Secrets Rule:** Never include secret values or `.env` files in a cartridge repository. Doing so will immediately fail contract validation (`npx @beercanlabs/contract validate`). The Factory Console pulls real values from your enterprise vault (AWS Secrets Manager, Azure Key Vault, HashiCorp Vault) and injects them securely at container boot.

---

### Who may use what: `roles` and a skill's `routes`

An agent often works for more than one person. `roles` says what each kind of person may use; an admin then gives people
a role on your agent (Stephanie is `Family` on Donna). Roles grant people access: they never restrict your agent's own
scheduled or autonomous work.

```yaml
skills:
  - id: google-calendar
    routes: [google-calendar]      # the gatekeeper-egress routes this skill goes through
  - id: gmail
    routes: [google-gmail]

roles:
  Owner:                           # declared, but never assigned: it comes from owning the agent
    skills:
      "*": { allow: ["*"] }        # "*" is every skill; an action list's "*" is every action
  Family:
    description: Immediate family
    skills:
      google-calendar: { allow: ["*"] }
      gmail: { deny: ["*"] }       # the skills a role does not list, it may not use
```

- A role lists **skills** (and, per skill, the actions it allows or denies). A rule must list at least one action.
- A role may name only skills the cartridge declares in `skills:` (or `"*"`). Registration refuses a typo instead of
  silently allowing a person nothing.
- A skill's `routes` are plain gatekeeper-egress route ids, never hosts. The factory sees routes, not skills, so `routes`
  is how a role becomes something it can apply. Two skills that use the same route cannot be told apart at the egress:
  if a role allows one and denies the other, the route is refused (deny wins).
- Role names are letters, digits, `-` and `_`, and differ by more than case.
- The holds on a skill's actions (`hold:`, E9) are separate: a role that allows a skill does not remove a hold.

**What the factory does with them today.** It validates them (`cartridge validate`), refuses a registration that declares
them badly, records them on the agent, and tells an admin and the agent's owner (`GET /api/v1/agents/:id/roles`, and with
`?held=Family` what someone holding those roles may use). An admin assigns them in the console (Identities, Access to
agents); the identity-links API refuses a role your cartridge does not declare (and `Owner`), so a typo or a role from
another agent cannot be given. **It does not yet apply them to what your agent reaches** (the gatekeeper-egress will,
TSK-174); until then your own check in the cartridge is the only limit. What the factory will never do: stop your agent
repeating what it already remembers (that is your cartridge's, §6.6).

**Scheduled runs.** When a schedule your agent (or its owner) set up fires, the run's input carries a `caller` badge, as a
person's message does, and also `source: 'schedule'` and `scheduleName`. The badge is the authority of whoever
**requested** the schedule, as they hold it now, never more:

- A schedule a person asked your agent to make runs as that person: their `agentRoles`, `isOwner`, and so on. If they have
  since lost their role, the factory does not start the run at all (ledgered as `SCHEDULE_SKIPPED_UNAUTHORIZED`).
- A schedule the owner made runs as the owner. A schedule with no recorded requester, and a system requester, runs with the
  agent's own authority: `role: 'system'`, `actor: 'factory:scheduler'`, `isOwner: false`, `roles: []`. Your cartridge decides
  what that allows; a scheduled run is not a guest.
- A run that is itself scheduled passes its requester on to any schedule it creates, so authority never grows.
- Trust only the badge. `input.source`, `input.content` and every other field of the input are text anyone could have written.
  Honour a `system` badge only when it comes from `caller`, and only with `actor == 'factory:scheduler'`.
- The agent cannot choose the requester when it creates a schedule: the factory reads it from the run the agent is acting in.

## 5. Step 3: Implementing the Hands & Eyes (`agent.py`)

The agent application contains your tools and reasoning loop. 

### How the Runtime Injects Context:
When the Factory Console wakes your cartridge:
1. **Input Payload:** Injected via the `FACTORY_INPUT` environment variable and written to `/tmp/factory-input.json`.
2. **Secrets:** Injected into `os.environ` using the exact names declared in `cartridge.yaml`.
3. **Memory Directory:** The Console hydrates previous state into `os.environ["MEMORY_DIR"]`. The Factory sets it (`/tmp/mind` in the reference runtimes), so always read it from the environment and never hard-code a path. For architectural depth on Agent Archetypes, the Storage Triad (Whiteboard vs. Notebook vs. Safe), FTS5 episodic search, and avoiding the decoder ring anti-pattern, see the [Agent Memory Architecture Guide](architecture/agent-memory-models.md).
4. **Egress Interception & Credential Injection:** The Console enforces a **Zero-Trust Network Perimeter** (no public IP, no default internet gateway route `0.0.0.0/0`). Outbound traffic to LLMs and third-party APIs (such as Discord) egresses exclusively through the **gatekeeper-egress** via standard Base URL variables:
   - `ANTHROPIC_BASE_URL` (`${GATEKEEPER_EGRESS_URL}/anthropic`)
   - `OPENAI_BASE_URL` (`${GATEKEEPER_EGRESS_URL}/v1`)
   - `DISCORD_BASE_URL` (`${GATEKEEPER_EGRESS_URL}/discord`)
   Agents authenticate to the gatekeeper-egress using their ephemeral `FACTORY_RUN_TOKEN`. The gatekeeper-egress verifies run lifecycle and egress policy, meters the call, injects the real provider key or bot token (`Bot <token>`), and proxies to the upstream service.
5. **Portability Fallback:** Cartridges remain 100% portable. If `DISCORD_BASE_URL` is unset, code defaults to `https://discord.com/api/v10` and uses local secrets (`DISCORD_BOT_TOKEN`).
6. **Output Delivery:** The agent simply writes its JSON response to `/tmp/factory-result.json` and exits `0`.

### Complete Python Example (`agent.py`):
```python
#!/usr/bin/env python3
import os
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from anthropic import Anthropic

# 1. The Notebook: Persistent SQLite Memory ("The Notebook & Safe")
# Cartridges write to local SQLite in $MEMORY_DIR; the Factory Console backs up to S3.
# NEVER import boto3 or cloud storage SDKs for cartridge memory.
def get_db(memory_dir: Path) -> sqlite3.Connection:
    memory_dir.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(memory_dir / "ops_state.db"))
    db.execute("PRAGMA journal_mode=WAL;")
    db.execute("PRAGMA synchronous=NORMAL;")
    db.execute("PRAGMA busy_timeout=5000;")
    db.execute("""
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            service TEXT NOT NULL,
            summary TEXT NOT NULL
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_incidents_timestamp ON incidents (timestamp);")
    db.commit()
    return db

def prune_old_records(conn: sqlite3.Connection, retention_days: int = 14):
    """Keep the notebook small (<10MB) so S3 backup remains sub-second."""
    from datetime import timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    conn.execute("DELETE FROM incidents WHERE timestamp < ?", (cutoff,))
    conn.commit()

def close_db(conn: sqlite3.Connection):
    """Clean checkpoint so S3 syncs a single, unfragmented .db file without dangling WAL locks."""
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    finally:
        conn.close()

# 2. Toolbox: Tools available to the Agent
def query_system_health(service_name: str) -> dict:
    """Queries external infrastructure health for a specific service."""
    # In real life, use requests with os.environ["PAGERDUTY_API_KEY"]
    return {
        "service": service_name,
        "cpu_load": "94%",
        "active_alerts": 2,
        "status": "degraded"
    }

# 3. Reading Input Payload
def read_input() -> dict:
    raw = os.environ.get("FACTORY_INPUT")
    if not raw:
        input_file = Path(os.environ.get("FACTORY_INPUT_FILE", "/tmp/factory-input.json"))
        if input_file.exists():
            raw = input_file.read_text("utf-8")
    return json.loads(raw) if raw else {"service": "payments", "alert": "latency_spike"}

# 4. Emitting Result
def write_result(output: dict):
    result_path = Path(os.environ.get("FACTORY_RESULT_FILE", "/tmp/factory-result.json"))
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps({"status": "succeeded", "output": output}), "utf-8")

def main():
    payload = read_input()
    memory_dir = Path(os.environ.get("MEMORY_DIR", "/tmp/ops-memory"))
    db = get_db(memory_dir)

    # Standard, unmodified Anthropic SDK!
    # gatekeeper-egress automatically meters tokens, enforces budget limits,
    # and records execution to the immutable audit ledger.
    client = Anthropic()

    system_prompt = Path("soul.md").read_text("utf-8") if Path("soul.md").exists() else "You are an ops agent."

    # Call LLM with persona and context
    response = client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1024,
        system=system_prompt,
        messages=[{
            "role": "user", 
            "content": f"Analyze incident alert for service '{payload.get('service')}': {json.dumps(payload)}"
        }]
    )

    summary = response.content[0].text

    # Record in persistent memory
    db.execute(
        "INSERT INTO incidents (timestamp, service, summary) VALUES (?, ?, ?)",
        (datetime.now(timezone.utc).isoformat(), payload.get("service", "unknown"), summary)
    )
    db.commit()

    # Deliver result
    write_result({"service": payload.get("service"), "analysis": summary})
    print("[agent] Run completed successfully.")

if __name__ == "__main__":
    main()
```

### Calling models
Agents call models through the gatekeeper-egress using the **factory model API**: the OpenAI Chat Completions request format (DESIGN_AUTHORITY §6.9). You never hold a provider key, never import a provider or cloud SDK (`boto3`, `anthropic`, …) for inference, and never call a provider directly. The gatekeeper-egress meters and ledgers every call, enforces your policy and budget, and translates the request to whichever provider operations has configured (Bedrock, Anthropic, Vertex, …).

**Request.** `POST ${FACTORY_MODEL_BASE_URL}/chat/completions` with header `Authorization: Bearer ${FACTORY_RUN_TOKEN}` and a JSON body:

| Field | Required | Notes |
|---|---|---|
| `model` | yes | A neutral model name, e.g. `claude-sonnet-4-5`, `claude-haiku-4-5`. Not a provider id. |
| `messages` | yes | `[{"role": "system" \| "user" \| "assistant", "content": "<string>"}]` |
| `max_tokens` | no | Output token limit. |
| `temperature` | no | |

Streaming is not supported yet: `"stream": true` returns `400 {"error": "streaming_not_supported"}`.

**Response** (OpenAI shape):
```json
{"id": "chatcmpl-…", "object": "chat.completion", "model": "claude-sonnet-4-5",
 "choices": [{"index": 0, "message": {"role": "assistant", "content": "…"}, "finish_reason": "stop"}],
 "usage": {"prompt_tokens": 1200, "completion_tokens": 300, "total_tokens": 1500}}
```

**Which model you get is decided by policy, not by your code.** Your cartridge declares a *preferred* model; an admin's policy decides which models your agent may use (deny by default, E7), and operations decides which models the factory offers. If the factory sets `FACTORY_MODEL` for a run, use it; the gatekeeper-egress refuses any other model for that run. `GET ${FACTORY_MODEL_BASE_URL}/models` lists the models your policy currently allows.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `model_not_offered` | This factory does not offer that model name. |
| 403 | `route_not_allowed` | Your policy does not grant the `models` route. Ask an admin. |
| 403 | `model_not_allowed` / `model_pinned` | Your policy (or this run) does not allow that model. |
| 402 | `budget_exceeded` | Your budget window is spent. |
| 429 | `throttled` / `upstream_throttled` | Your tokens-per-minute limit, or the provider, is throttling. Back off and retry. |

A minimal example using only the Python standard library:

```python
import json
import os
import urllib.request

def ask(prompt: str, system: str = "You are a helpful assistant.") -> str:
    body = {
        "model": os.environ.get("FACTORY_MODEL", "claude-sonnet-4-5"),
        "max_tokens": 1024,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
    }
    req = urllib.request.Request(
        os.environ["FACTORY_MODEL_BASE_URL"].rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {os.environ['FACTORY_RUN_TOKEN']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.load(resp)["choices"][0]["message"]["content"]
```

Because the format is OpenAI's, the stock OpenAI SDK also works: `OpenAI(base_url=os.environ["FACTORY_MODEL_BASE_URL"], api_key=os.environ["FACTORY_RUN_TOKEN"])` (non-streaming calls only).

### Conversational Agents: Warm-Down Window & Mailbox
For interactive agents (e.g., Discord or Slack chatbots), agents often stay warm after their first turn to handle follow-up user messages with zero cold-start latency:
1. Declare `runtime.warmDownSeconds: 3600` (e.g. 1 hour) in `cartridge.yaml`.
2. After processing the initial turn, long-poll the factory mailbox:
   `GET /api/v1/runs/${FACTORY_RUN_ID}/mailbox?timeout=20000` with header `Authorization: Bearer ${FACTORY_RUN_TOKEN}`.
3. If a follow-up message arrives, reset your idle timer and handle the turn.
4. When the idle window expires without further messages, call `write_result()` and exit `0` to scale back to zero.

### Egress to External APIs (e.g. Discord, Slack)
Because cartridges operate inside a zero-trust VPC with no public IP or direct internet egress route, third-party API communication uses perimeter credential injection through the gatekeeper-egress:

```python
import os
import urllib.request
import json

def reply_discord(channel_id: str, content: str):
    base_url = os.environ.get("DISCORD_BASE_URL", "https://discord.com/api/v10").rstrip("/")
    run_token = os.environ.get("FACTORY_RUN_TOKEN")
    is_gatekeeper_egress = "discord.com" not in base_url

    # In the Factory: send run token. The gatekeeper-egress attaches the real Bot token.
    # Standalone: use local DISCORD_BOT_TOKEN directly.
    auth_header = (
        f"Bearer {run_token}"
        if (is_gatekeeper_egress and run_token)
        else f"Bot {os.environ.get('DISCORD_BOT_TOKEN', '')}"
    )

    req = urllib.request.Request(
        f"{base_url}/channels/{channel_id}/messages",
        data=json.dumps({"content": content[:1900]}).encode("utf-8"),
        headers={"Authorization": auth_header, "Content-Type": "application/json"},
        method="POST"
    )
    urllib.request.urlopen(req, timeout=10)
```
When running in production, the Factory gatekeeper-egress intercepts the request, validates the cartridge's policy, strips `FACTORY_RUN_TOKEN`, resolves the agent-specific credential (`{agent}_DISCORD_BOT_TOKEN`), and forwards the call to `discord.com`. When running standalone, it connects directly using local tokens. Cartridge code never needs to hardcode environment-specific endpoints.

---

## 6. Step 4: The 90-Day Review (`bench.yaml`)

In the Agent Factory, **`bench.yaml` is your automated quality and FinOps benchmark harness**.

It allows the Factory to exercise your cartridge against deterministic test cases across candidate models (e.g., Claude 3.5 Haiku vs. Sonnet vs. Opus), generating a **Cost vs. Quality Scorecard**:

```
================================================================================
                    CARTRIDGE BENCHMARK SCORECARD
================================================================================
Model                   Pass Rate    Avg Latency    Cost / 1,000 runs
--------------------------------------------------------------------------------
Claude 3.5 Haiku         82.0%         420 ms            $2.40
Claude 3.5 Sonnet        96.5%         890 ms           $12.50   <-- RECOMMENDED
Claude 3.5 Opus          99.0%       2,150 ms           $37.00
================================================================================
```

### Authoring `bench.yaml`:
```yaml
cases:
  - id: payments-alert
    input:
      service: payments
      alert: latency_spike
    expect:
      status: DONE
      contains:
        - "payments"
        - "latency"
  - id: unknown-service-fallback
    input:
      service: internal-shadow-service
    expect:
      status: DONE
      matches: ".*(investigating|unrecognized).*"
    timeoutSeconds: 30
```

### Policy Gate Rule:
* **Optional by default:** You can develop, test, and register a cartridge without `bench.yaml`.
* **Policy Configurable:** Factory administrators can create company policies that require a minimum benchmark pass rate (e.g. `minPass: 95%`) before an agent is elevated to production.

---

## 7. Step 5: Packaging & Local Validation

### 1. Validate the Contract Locally
Before deploying, validate your cartridge files with the Factory CLI:
```bash
npx @beercanlabs/contract validate ./my-agent
```
Output:
```
ok  my-agent  /path/to/my-agent
```

### 2. Containerize with Docker
Write a standard Dockerfile:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY soul.md cartridge.yaml agent.py ./
ENTRYPOINT ["python3", "agent.py"]
```
Build and push to your container registry:
```bash
docker build -t ghcr.io/myorg/ops-assistant:1.0.0 .
docker push ghcr.io/myorg/ops-assistant:1.0.0
```

### 3. What the Factory Checks Before It Accepts a Commit (Admission)
When an owner registers an agent by naming its repository, the Factory pins the exact commit and builds it in an isolated build environment before anything is deployed (DESIGN_AUTHORITY.md L3 and L4). A commit that fails is refused with a reason, and the refusal is recorded in the ledger. Check these yourself first; the reference starter (`agents/examples/starter-python`) passes them.

1. **A pinned commit.** The Factory builds the full 40-character commit SHA you register, never a branch or a mutable tag. The image is tagged `<agent-id>-<first 12 characters of the SHA>`.
2. **No hard-coded credentials** (refusal `hardcoded_secret`). Every tracked file is scanned for known token formats (GitHub, Slack, Anthropic, xAI, AWS keys, Notion, private-key headers) and for `secret`, `password`, `api_key` or `token` assigned a long literal. A hit is reported as `file:line`, never the value. Declare secrets by name in `cartridge.yaml` (`secrets.requires`); the Factory injects them, and an agent holds only its run token (S1). A line that is a deliberate false positive can carry the marker `secret-scan:allow`.
3. **Your own tests exist and pass** (refusals `no_tests`, `tests_failed`). Python agents (a `requirements.txt`, `pyproject.toml` or `setup.py`) need at least one `test_*.py` or `*_test.py` file, and `python -m pytest -q` must pass; pytest collecting nothing counts as `no_tests`. Node agents (a `package.json`) need a real `scripts.test`, and `npm ci && npm test` must pass. Any other kind of agent is refused as `no_tests`. `requirements.txt` is installed first, so declare every dependency your tests and agent import.
4. **The image builds and is pushed** (refusals `build_failed`, `push_failed`). The build runs `docker build` on your `Dockerfile`, so every file the agent imports must be copied into the image.
5. **The source is reachable** (refusal `source_unavailable`): the repository can be cloned and the commit is the one registered.

The Factory also validates `cartridge.yaml` and its sibling files against the contract when it loads the agent (the same check as `npx @beercanlabs/contract validate`, section 7.1), and the Factory design rules apply: memory under `$MEMORY_DIR` with no cloud storage SDKs (section 5 and `docs/architecture/agent-memory-models.md`), every outbound call through the gatekeeper-egress, and egress declared in the cartridge.

Admission is not deployment. An agent deploys only after a policy owner has set its policy and budget (E7), and the Factory deploys exactly the admitted image. The build steps above are the AWS landing zone's builder (`landing-zones/aws/codebuild.tf`); a provider whose build cannot run tests yet (the GCP landing zone today) refuses every commit with `not_supported`.

---

## 8. Real-World Architectural Case Studies

The Cartridge model handles any autonomous agent workload. Here is how four production archetypes are constructed:

### Case Study 1: Rosie (Smart Home & Home Assistant Manager)
* **Mission:** Monitors Home Assistant for broken IoT devices, installs updates, and recognizes family behavioral patterns to suggest automations.
* **Triggers:** Discord mention (`@Rosie`), daily cron audit at 2:00 AM, HA error webhooks.
* **Secrets:** `HASS_TOKEN`, `HASS_URL`, `DISCORD_BOT_TOKEN`.
* **Toolbox:** Home Assistant REST/WebSocket API tool to inspect device states and inject automations.
* **Filing Cabinet:** Persistent SQLite database in `/memory/family_patterns.db` recording time-stamped switch events. After 14 days of observing lights turned off between 10:30 PM and midnight, Rosie messages the family Discord proposing an automated routine.

### Case Study 2: Higgins (Real Estate Operations Manager)
* **Mission:** Manages weekly contact outreach for Stephanie's real estate business.
* **Triggers:** Weekly cron (Monday at 7:00 AM), Discord (`@Higgins`), webhook from web app (`cc.dalesackrider.com`).
* **Secrets:** `CRM_API_KEY`, `WEBAPP_API_TOKEN`, `PRINTER_IP`, `HASS_TOKEN`.
* **Toolbox:** 
  - CRM lead algorithm tool to pull 25 contacts.
  - IPP network print tool to print the contact sheet on the home office printer.
  - Home Assistant tool to push a summary KPI graphic to the office e-ink dashboard.
* **Interactive Turns:** When Stephanie messages on Discord: *"Move Jim out two weeks"*, Higgins locks Jim into the queue two weeks forward, pulls the next eligible contact into this week's 25, updates the web app, and refreshes the office dashboard.

### Case Study 3: Archie (Engineering Code Reviewer)
* **Mission:** Automated GitHub PR code reviews, security scanning, and issue triage.
* **Triggers:** GitHub webhook (`pull_request`, `issues`), Discord (`@Archie`).
* **Secrets:** `GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`.
* **Toolbox:** GitHub API / MCP server to read diffs, inspect ASTs, and post PR comments.
* **Filing Cabinet:** Repository architectural guidelines and historical review preferences in `/memory`.
* **Benchmark:** Tested against sample pull requests with intentional vulnerabilities (SQL injections, hardcoded secrets) to verify that Archie denies them with 100% precision.

### Case Study 4: Switch (Jira Triage & Routing Agent)
* **Mission:** Validates incoming Jira tickets against the "Definition of Ready" and routes them to team queues.
* **Triggers:** Jira webhook (`issue_created`, `issue_updated` in Triage status).
* **Secrets:** `JIRA_API_TOKEN`, `SLACK_BOT_TOKEN`.
* **Toolbox:** Jira REST API to update fields and transition ticket states; Slack API to notify assignees.
* **Behavior:** If a ticket lacks clear acceptance criteria or steps to reproduce, Switch comments on the ticket requesting clarification and leaves it in Triage. If ready, Switch routes it to the sprint backlog and notifies the tech lead on Slack.

---

## 9. Summary: The Golden Rules for Cartridge Authors

1. **Think Like a Hiring Manager:** Fill out the Job Description (`soul.md`), Contract (`cartridge.yaml`), and Performance Rubric (`bench.yaml`).
2. **Never Hardcode Secrets:** Declare variable names in `cartridge.yaml`; let the Factory Console inject them at runtime.
3. **Bring Lightweight Memory:** Use local SQLite or JSON in `$MEMORY_DIR` for personal agent memory. The Factory takes care of cloud syncing. See the [Agent Memory Architecture Guide](architecture/agent-memory-models.md) for complete details.
4. **Use Standard LLM SDKs:** Call `anthropic` or `openai` normally. The gatekeeper-egress intercepts, meters, and protects your cloud budget automatically.
5. **Sleep at Zero:** Your agent only runs when a trigger fires, keeping cloud costs strictly at zero when idle.

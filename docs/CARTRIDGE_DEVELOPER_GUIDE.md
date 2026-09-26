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
│  - Egress Gateway: Meters every token, enforces budget circuit breakers, logs audit ledger   │
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

## 5. Step 3: Implementing the Hands & Eyes (`agent.py`)

The agent application contains your tools and reasoning loop. 

### How the Runtime Injects Context:
When the Factory Console wakes your cartridge:
1. **Input Payload:** Injected via the `FACTORY_INPUT` environment variable and written to `/tmp/factory-input.json`.
2. **Secrets:** Injected into `os.environ` using the exact names declared in `cartridge.yaml`.
3. **Memory Directory:** The Console hydrates previous state into `os.environ["MEMORY_DIR"]` (defaults to `/memory`).
4. **Egress Interception & Credential Injection:** The Console enforces a **Zero-Trust Network Perimeter** (no public IP, no default internet gateway route `0.0.0.0/0`). Outbound traffic to LLMs and third-party APIs (such as Discord) egresses exclusively through the **Factory Egress Gateway** via standard Base URL variables:
   - `ANTHROPIC_BASE_URL` (`${GATEWAY_URL}/anthropic`)
   - `OPENAI_BASE_URL` (`${GATEWAY_URL}/v1`)
   - `DISCORD_BASE_URL` (`${GATEWAY_URL}/discord`)
   Agents authenticate to the gateway using their ephemeral `FACTORY_RUN_TOKEN`. The Gateway verifies run lifecycle and egress policy, meters the call, injects the real provider key or bot token (`Bot <token>`), and proxies to the upstream service.
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

# 1. Filing Cabinet: Persistent SQLite Memory
def get_db(memory_dir: Path) -> sqlite3.Connection:
    memory_dir.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(memory_dir / "ops_state.db"))
    db.execute("""
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            service TEXT NOT NULL,
            summary TEXT NOT NULL
        )
    """)
    db.commit()
    return db

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
    # Factory Egress Gateway automatically meters tokens, enforces budget limits,
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

### Conversational Agents: Warm-Down Window & Mailbox
For interactive agents (e.g., Discord or Slack chatbots), agents often stay warm after their first turn to handle follow-up user messages with zero cold-start latency:
1. Declare `runtime.warmDownSeconds: 3600` (e.g. 1 hour) in `cartridge.yaml`.
2. After processing the initial turn, long-poll the factory mailbox:
   `GET /api/v1/runs/${FACTORY_RUN_ID}/mailbox?timeout=20000` with header `Authorization: Bearer ${FACTORY_RUN_TOKEN}`.
3. If a follow-up message arrives, reset your idle timer and handle the turn.
4. When the idle window expires without further messages, call `write_result()` and exit `0` to scale back to zero.

### Egress to External APIs (e.g. Discord, Slack)
Because cartridges operate inside a zero-trust VPC with no public IP or direct internet egress route, third-party API communication uses perimeter credential injection through the Gateway:

```python
import os
import urllib.request
import json

def reply_discord(channel_id: str, content: str):
    base_url = os.environ.get("DISCORD_BASE_URL", "https://discord.com/api/v10").rstrip("/")
    run_token = os.environ.get("FACTORY_RUN_TOKEN")
    is_gateway = "discord.com" not in base_url

    # In the Factory: send run token. The Gateway attaches the real Bot token.
    # Standalone: use local DISCORD_BOT_TOKEN directly.
    auth_header = (
        f"Bearer {run_token}"
        if (is_gateway and run_token)
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
When running in production, the Factory Gateway intercepts the request, validates the cartridge's policy, strips `FACTORY_RUN_TOKEN`, resolves the agent-specific credential (`{agent}_DISCORD_BOT_TOKEN`), and forwards the call to `discord.com`. When running standalone, it connects directly using local tokens. Cartridge code never needs to hardcode environment-specific endpoints.

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
3. **Bring Lightweight Memory:** Use local SQLite or JSON in `$MEMORY_DIR` for personal agent memory. The Factory takes care of cloud syncing.
4. **Use Standard LLM SDKs:** Call `anthropic` or `openai` normally. The Factory Egress Gateway intercepts, meters, and protects your cloud budget automatically.
5. **Sleep at Zero:** Your agent only runs when a trigger fires, keeping cloud costs strictly at zero when idle.

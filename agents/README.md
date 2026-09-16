# Example cartridges

These directories are **portable agent cartridges**, not factory modules. Factory code must not import this tree.

Each cartridge consumes factory APIs:

| Cartridge | Factory surface |
|---|---|
| `finops-officer` | `GET /api/v1/ledger`, `POST .../isolate` |
| `med-doc` | crash events routed by the control plane (`type=crash`) |
| `compliance-officer` | ledger + logs |
| `librarian` | MCP peripheral allowlist only |
| `factory-mechanic` | IaC as an agent, not factory code |
| `examples/echo-agent` | contract fixture; `worker.mjs` writes to hydrated `MEMORY_DIR` |

Crash routing and budget alerts are **event routes** in the control plane (by cartridge id). Remediation logic stays in the agent.

# Example cartridges

These directories are **portable example agent cartridges and test fixtures**, not factory modules. Factory code must not import this tree.

Each cartridge consumes factory APIs:

| Cartridge | Factory surface |
|---|---|
| `examples/echo-agent` | contract fixture; `worker.mjs` writes to hydrated `MEMORY_DIR` |
| `examples/llm-summarizer` | test fixture for model metering and bench scoring |
| `examples/starter-python` | reference decoupled Python agent starter |

Crash routing and budget alerts are **event routes** in the control plane (by cartridge id). Remediation logic stays in the agent.

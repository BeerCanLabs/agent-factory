# BeerCanLabs Agent Factory

Turnkey hosting for autonomous agent fleets. **The factory is the console; the agent is the cartridge.**

If you are an AI asked to “build that” from this repo, read **[AGENTS.md](./AGENTS.md)** first. Humans: same file is the deploy playbook.

Canonical architecture: [POSITION_PAPER.md](./POSITION_PAPER.md).

---

## What this is

A **harness**: wake from zero, bind secrets (names only), hydrate mind, intercept LLM/MCP egress, append-only ledger, MCP/HTTP console. Discord is an **optional mailbox** (Doorman). You do not need a Discord app to deploy the factory. You do not install Hermes or OpenClaw.

Landing zone (GCP, AWS, VMware, Mac mini, …) is chosen at deploy time. See `landing-zones/CONTRACT.md`.

---

## Kernel vs optional

| Always | Optional / later |
|---|---|
| Control plane REST + MCP | Discord (Doorman holds Gateway when a cartridge has a `discord` surface **and** a bot token is bound) |
| Sidecar intercept + kill-switch | Garrison or any other UI |
| Secret binding, hydrate, ledger | Training gym, OAuth vault, skill library |
| Auth plug-in (bearer or OIDC: Cloudflare / Entra / Google) | |

Doorman is **always installed** and **idle** (`GET :8090/healthz` → `discord: idle`) until Discord credentials exist. Sleeping Discord-surface agents appear **offline**; after wake + conversation handoff they appear **available**. The Gateway stays connected.

---

## Layout

```
AGENTS.md                 # implementing-AI playbook
POSITION_PAPER.md
packages/contract|auth|secrets-bind|hydrate|ledger|control-plane|doorman
sidecar/
agents/                   # example cartridges (not factory modules)
landing-zones/            # GCP, mac-mini, CONTRACT
runtimes/generic/         # hydrate then exec
```

---

## License

Apache-2.0 © BeerCanLabs

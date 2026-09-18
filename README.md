# BeerCanLabs Agent Factory

Turnkey hosting for autonomous agent fleets. **The factory is the console; the agent is the portable cartridge.**

If you are an AI asked to “build that” from this repo, read **[AGENTS.md](./AGENTS.md)** first.

Canonical architecture: [POSITION_PAPER.md](./POSITION_PAPER.md).

---

## What this is

A **harness**: wake from zero, bind secrets (names only), hydrate mind from object storage, intercept LLM/MCP egress, append-only ledger, MCP/HTTP console. Discord is an **optional mailbox** (Doorman). You do not need a Discord app to deploy the factory. You do not install Hermes or OpenClaw.

Landing zone is a **Draftsman interview**: pick a baseline pattern in `.draft/sdp.yaml`, then bind Azure, AWS, GCP, or Compose. See `landing-zones/PATTERNS.md`. `landing-zones/aws` is one bind (orchestrated-tasks × AWS), not the factory.

---

## Kernel vs Optional

| Always | Optional |
|---|---|
| Control plane REST + MCP | Discord (Doorman holds Gateway when a cartridge has a `discord` surface **and** a bot token is bound) |
| Gateway intercept + kill-switch | Garrison or any other UI |
| Secret binding, S3/volume hydrate, ledger | Prompt traces in mind (`FACTORY_TRACE_PROMPTS`) |
| Auth: JWKS-verified OIDC (Entra / Cloudflare / Google) + named service tokens, RBAC | |

---

## Known Gaps (As Designed)

The architecture is opinionated and accepts certain limits by design:
- **Cloud Providers:** GCP and Azure are notes and examples only; full IaC is currently AWS and Docker Compose.
- **Compose Isolation:** Compose-host is root-equivalent; trust is assumed for the control plane.
- **Queues:** SQS is the only inbound queue provider supported.
- **Event Bus:** EventBridge delivery is at-least-once, meaning subscribers must handle idempotency.
- **Control Plane:** The control plane is a single writer/instance by design to serialize the ledger hash chain.

---

## Layout

```
AGENTS.md                 # implementing-AI playbook
POSITION_PAPER.md
packages/…                # kernel (control-plane, gateway, doorman, etc)
agents/                   # example cartridges (not factory modules)
landing-zones/            # PATTERNS.md + aws/azure/gcp/compose binds
.draft/sdp.yaml           # three baseline patterns + interview slots
runtimes/generic/         # agent shim + exec
```

---

## License

Apache-2.0 © BeerCanLabs

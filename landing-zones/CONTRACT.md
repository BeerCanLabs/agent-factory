# Landing zone contract

A landing zone is **where** the factory runs. It is not the factory. Pick a **baseline pattern** in `.draft/sdp.yaml`, then bind a provider (Azure, AWS, GCP, VM). See `PATTERNS.md`.

If you are an implementing AI, provision every slot. A module that only starts an agent task is incomplete. A module that assumes ECS/S3 when the human has Azure is wrong.

## Kernel slots (always)

| Slot | Purpose |
|---|---|
| Ingress | HTTP/MCP. Discord Gateway is not this. |
| Control plane | REST + MCP |
| Doorman | Always on, idle without a bot token |
| Sidecar + worker | Same task/revision; agents scale to zero |
| Mind | Object storage |
| Ledger | Append-only metadata+hash on durable store |
| Secret bind | Adopter vault |
| Auth | OIDC or first-bring-up bearer |

## Must not require

- AWS, ECS, or S3
- A Discord application
- Hermes, OpenClaw, Garrison

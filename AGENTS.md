# Agent Factory — instructions for implementing AIs

You are deploying **BeerCanLabs Agent Factory** from this repository. The human said some variant of “build that.” Follow this file. Canonical architecture: `POSITION_PAPER.md`. On conflict, the paper wins, then this file, then `SPEC.md`.

You are not installing Hermes, OpenClaw, or Garrison. Those are not the factory.

## Goal

Leave a **fully functional factory** on the landing zone they choose:

- Control plane (REST + MCP) reachable and authenticated
- Portable cartridges can wake from zero with secrets bound, mind hydrated, ledger appended
- Sidecar intercepts LLM/MCP egress (kill-switch)
- **Doorman is installed but idle** until an agent cartridge declares a Discord surface *and* Discord bot credentials are bound. Do **not** require a Discord application to deploy the factory.
- Sleeping Discord-surface agents appear **offline** in Discord. After Doorman wakes the agent and hands off the conversation they appear **available**. Doorman keeps the Gateway socket; it does not drop the connection while “offline.”

## Interview (ask before provisioning)

Do not assume AWS, GCP, or Discord. Ask:

1. **Landing zone** — GCP, AWS, VMware, Mac mini / Linux VM, or other. They must have credentials for that zone (e.g. `gcloud`, `aws`, SSH, or local Docker).
2. **Identity provider** for the factory console — Cloudflare Access, Microsoft Entra, Google OAuth/OIDC, or a long-lived bearer token for a first bring-up.
3. **Secrets backend** — GCP Secret Manager, AWS Secrets Manager, Vault, or a gitignored file on a VM.
4. **Discord** — optional. Only if they already have (or will add) an *agent with a Discord surface*. Factory deploy itself must not block on a Discord app.

If they cannot answer (1) and cannot grant you access, stop and tell them what access you need.

## What to install (kernel)

Always:

| Piece | Path |
|---|---|
| Cartridge contract | `packages/contract` |
| Secret binding | `packages/secrets-bind` |
| Mind hydrate | `packages/hydrate` |
| Ledger | `packages/ledger` |
| Control plane | `packages/control-plane` |
| Sidecar | `sidecar/` |
| Auth hook | `packages/auth` |
| Doorman (idle) | `packages/doorman` |
| Landing-zone contract | `landing-zones/CONTRACT.md` |
| Reference zone | `landing-zones/gcp` or `landing-zones/mac-mini` |

Never install as factory kernel: Hermes, OpenClaw, Garrison, a shared skill library, a factory-owned OAuth token vault.

## Landing zones

Read `landing-zones/CONTRACT.md`. Copy the closest reference (`gcp`, `mac-mini`) and adapt. The factory is the control plane + mailbox + bind + hydrate + ledger + sidecar. An “agent task only” Terraform module is incomplete.

Mac mini / VM: `landing-zones/mac-mini` (Compose). GCP: `landing-zones/gcp`. AWS: adapt GCP’s resource list; do not cargo-cult `blueprints/aws` without adding the control plane.

## Auth

`FACTORY_AUTH=bearer|oidc|none`

- `oidc`: `FACTORY_OIDC_ISSUER` + `FACTORY_OIDC_AUDIENCE` (Cloudflare Access, Entra, Google).
- `bearer`: `FACTORY_TOKEN` — acceptable for first bring-up; tell them to switch to OIDC.
- `none`: local break-glass only.

## Discord / Doorman

- Deploy Doorman **always** as a process/service. It starts with no bot token and does nothing.
- When a cartridge has `surface.yaml` `type: discord` and `DISCORD_BOT_TOKEN` (or the named `secretRef`) binds successfully, Doorman logs in, **presence = offline/invisible**, and waits.
- Inbound Discord message → `POST /api/v1/agents/:id/wake` → presence available → hand off conversation (`POST /api/v1/agents/:id/conversation`).
- Agent scale-to-zero → presence offline again. **Do not disconnect the Gateway.**
- Offline is presence, not a dropped socket.

## Definition of done (verify)

1. `GET /healthz` on the control plane.
2. Authenticated `GET /api/v1/agents` lists cartridges.
3. `POST /mcp` `tools/list` works.
4. Bind echo’s secrets; `POST /api/v1/agents/echo-agent/wake` returns 200 not 412; ledger has a `RESUME` row; `MEMORY_STORE` has prefix data after idle. Ledger JSONL must not contain secret values or prompt/content fields (metadata + `payloadSha256` only).
5. Doorman `/healthz` is ok with `discord: idle` when no Discord surface/token.
6. If they provided a Discord-surface agent **and** a bot token: Doorman `discord: connected`, presence offline until wake.

## Secrets

Cartridges declare **names only**. Never commit values. Unbound required names → HTTP 412 with `missing: [...]`.

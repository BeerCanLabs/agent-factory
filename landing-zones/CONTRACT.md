# Landing zone contract

A landing zone is **where** the factory runs (GCP, AWS, VMware, Mac mini, …). It is not the factory.

If you are an implementing AI, provision **all** of these. A module that only starts an agent container is incomplete.

## Must exist

| Resource | Purpose |
|---|---|
| Control plane service | REST + MCP. Public or IdP-fronted URL. Scale the *service* with the platform; agents stay at zero. |
| Doorman service | Always deployed. Idle until a Discord-surface cartridge binds a bot token. |
| Sidecar + worker pattern | Per-agent: sidecar proxies LLM/MCP; worker is the cartridge. |
| Mind bucket / volume | Object store (GCS/S3) or a disk volume on a VM. Hydrate on wake, push on sleep. |
| Ledger | Append-only (JSONL on disk/object store is fine). |
| Secret bind | Names from `secrets.manifest.yaml` → Secret Manager / Vault / file. Factory does not store values. |
| Scale-to-zero | Agent compute desired=0 / min_instance_count=0 / no process. Wake via control plane. |
| Auth | `FACTORY_AUTH=oidc` (Cloudflare/Entra/Google) or bearer for first bring-up. |

## Must not require

- A Discord application (Doorman stays `discord: idle`)
- Hermes, OpenClaw, Garrison
- Cloning a second repo

## References in this tree

- `landing-zones/mac-mini` — Docker Compose (VM / Mac mini)
- `landing-zones/gcp` — Cloud Run min=0 + GCS mind + idle Doorman
- `blueprints/aws` — adapt; add control plane + Doorman before using as a copy source

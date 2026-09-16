# GCP landing zone

Implements `landing-zones/CONTRACT.md` on Cloud Run.

Terraform lives in `blueprints/gcp/` (images, mind bucket, min_instance_count = 0, secret refs). When deploying, also stand up:

1. **Control plane** Cloud Run service from `packages/control-plane/Dockerfile` (or a published image). Env: `AGENTS_ROOT`, `FACTORY_AUTH`, `FACTORY_OIDC_*` or `FACTORY_TOKEN`, `FACTORY_LEDGER_PATH` (or mount), `MEMORY_STORE_DIR` / GCS via hydrate, `DOORMAN_URL`.
2. **Doorman** Cloud Run service from `packages/doorman` (`src/server.ts`). Env: `FACTORY_URL`, `FACTORY_TOKEN`. No `DISCORD_BOT_TOKEN` at factory deploy.
3. **Echo (or their cartridge)** as a min=0 service or RunJob woken by the control plane — not a 24/7 `desiredCount=1`.

Enable APIs: `run`, `storage`, `secretmanager`, `artifactregistry`.

Do not require a Discord app to `terraform apply`.

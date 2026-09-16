# BeerCanLabs Agent Factory

Turnkey infrastructure for hosting, scaling, governing, and observing autonomous agent fleets.

**The Factory is the universal console; the Agent is the portable cartridge.**

The architectural mandate is [POSITION_PAPER.md](./POSITION_PAPER.md). Other docs (`SPEC.md`, `KPF.md`) describe implementation detail and must not contradict the paper.

---

## Architecture: Factory vs overlay

The factory is headless: API-first and MCP-first. Command decks, CLIs, web UIs, and 3D environments such as [Agent Garrison](https://github.com/BeerCanLabs/agent-garrison) are privileged clients. They consume factory telemetry and issue REST, WebSocket, or MCP commands. If every UX layer is taken offline, fleets must still run, scale, and report.

```
Privileged clients (Garrison, CLI, Web UI)
        |  REST / WebSocket / MCP
        v
Factory control plane (headless)
  - cartridge registry + schema validation
  - wake / scale-to-zero routing from surface.yaml
  - secret binding (BYO Vault / AWS SM / GCP SM)
  - memory hydration (object storage)
  - append-only execution ledger
        |
        v
Per-instance factory sidecar
  - intercept LLM + MCP egress
  - token / tool records -> ledger
  - kill-switch (pause / isolate / throttle at the proxy)
  - optional Garrison telemetry sink
        |
        v
Agent cartridge
  soul.md + surface.yaml + secrets.manifest.yaml
  + portable compute artifact
```

---

## Agent / Factory contract

An agent is a portable bundle. If it provides the bundle, the factory provisions compute, injects secrets at boot, routes wake events, and hydrates memory.

```
my-agent/
├── soul.md                  # persona, instructions, operating boundaries
├── surface.yaml             # ingress triggers (cron, webhook, queue, http)
├── secrets.manifest.yaml    # credential *names* only (no values)
├── skills.yaml              # optional MCP peripheral allowlist (not a code library)
├── identity.yaml            # optional daemon vs on-behalf-of
└── artifact                 # OCI image, serverless function, or managed-engine ref
```

Skills that are ordinary libraries ship *inside* the artifact (`npm` / PyPI). The factory exposes MCP only for environmental peripherals, bloated tools, or centralized stateful security.

---

## Kernel vs deferred

| Kernel (paper) | Deferred (not factory kernel) |
|---|---|
| Scale-to-zero compute | Doorman socket-lease broker |
| Persistent mind (object-storage hydration) | Cloud OAuth / OBO token vault |
| Secret *binding* to a BYO vault | Training Gym / Promptfoo model sweep |
| Sidecar intercept + kill-switch | Factory-owned model router product |
| Immutable execution ledger | Central skill/code library |
| Headless REST + MCP control plane | Voice / robotics streaming gateway |

---

## Repository structure

```
agent-factory/
├── POSITION_PAPER.md        # canonical architecture
├── SPEC.md                  # implementation spec (kernel + deferred)
├── KPF.md                   # key product flows
├── packages/contract/       # cartridge schema + `factory validate`
├── packages/secrets-bind/   # BYO vault/env/file binding (no factory vault)
├── packages/hydrate/        # object-storage mind pull/push
├── packages/ledger/         # append-only JSONL execution ledger
├── packages/control-plane/  # headless REST + MCP factory console
├── agents/                  # example cartridges (not imported by factory code)
├── blueprints/
│   ├── aws/                 # Fargate RunTask-from-zero + sidecar + S3 mind
│   ├── gcp/                 # Cloud Run min=0 + sidecar + GCS mind
│   └── docker/docker-compose.yml
├── sidecar/                 # factory sidecar (currently a Garrison-coupled supervisor; being replaced)
├── runtimes/                # thin entrypoints (hermes / openclaw stubs)
├── cloud-run-service.yaml   # two-container worker + sidecar example
└── package.json
```

Blueprints, sidecar, and runtimes are **not** yet aligned with the paper. See `SPEC.md` for the gap list and the intended kernel.

---

## Local sandbox

```bash
npm test
npm run validate
cd blueprints/docker
docker compose up --build
```

Control plane: `http://localhost:8088/healthz`  
Catalog (dev token): `Authorization: Bearer dev-token` then `GET /api/v1/agents`  
MCP: `POST /mcp`  
Sidecar health: `http://localhost:9090/healthz`

Wake an agent (secrets must be bound in env or `FACTORY_SECRETS_FILE`):

```bash
curl -s -X POST http://localhost:8088/api/v1/agents/echo-agent/wake \
  -H 'Authorization: Bearer dev-token'
```

Idle instances scale back to zero (`FACTORY_IDLE_MS`). Garrison is optional (`TELEMETRY_SINKS=garrison`).

---

## License

Apache-2.0 © BeerCanLabs

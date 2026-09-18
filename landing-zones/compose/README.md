# Compose landing zone (pattern 3, one host)

```bash
docker compose --profile agents build      # agent images, one per cartridge
docker compose up -d                        # control plane, gateway, doorman, docker API proxy
curl -H 'Authorization: Bearer dev-admin-token' localhost:8088/api/v1/agents
```

Requires Docker Engine 26+ (volume subpaths). Fill `../docker-secrets.env` with provider keys and `gateway.json` `prices` (USD per million tokens) before agents can call models: unpriced models are refused. Give an agent egress with `PUT /api/v1/agents/<id>/policy {"routes":["anthropic"]}`.

**Isolation is by network, not configuration.** Each run is its own container on `factory-agents`, an `internal` Docker network whose only peers are the control plane and the gateway. Nothing on it can reach the internet or a provider directly.

**Trust boundary.** The control plane creates containers through a socket proxy that exposes only the containers API, and every container it creates is unprivileged, read-only, capability-free, and memory/PID limited. Creating containers on a single host is still root-equivalent, so treat the control plane host as the trust boundary. Managed runtimes (ECS, Cloud Run, Container Apps) avoid this.

**Ledger anchor.** `FACTORY_LEDGER_WORM_URI=file:///data/worm` is a local anchor, not write-once. Point it at an Object Lock / immutable bucket for compliance.

**Proof.** `../../scripts/compose-e2e.sh` stands the stack up with a mock provider (`docker-compose.e2e.yml`) and checks every claim end to end.

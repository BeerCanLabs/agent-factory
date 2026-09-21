# Claude Rules for agent-factory

These rules dictate how you (Claude) must interact with this repository.

## 1. Reference Architecture & Decoupling
This repository is the canonical reference implementation of **Agent Factory**.
- It must remain **cloud-agnostic and provider-neutral**.
- Do not commit company-specific AWS account IDs, internal deployment scripts, or private credentials into this repository.
- Production and enterprise deployments for BeerCanLabs belong in the dedicated operations repository (`BeerCanLabs/submind-aws`).

## 2. General Etiquette
* Follow the canonical architecture defined in `POSITION_PAPER.md` and `AGENTS.md`.
* The Factory relies on four specific ingress/egress interfaces (API, Webhooks, WebSockets, Events) as documented in `KPF.md`. Do not invent new interfaces.
* Kernel packages live in `packages/` (`contract`, `auth`, `secrets-bind`, `hydrate`, `ledger`, `control-plane`, `doorman`, `telemetry/`).
* Landing zone examples in `landing-zones/` are reference patterns for cloud providers (`aws`, `azure`, `gcp`, `compose`).

## 3. Continuous Integration
All PRs and commits are verified by `.github/workflows/ci.yml` which executes the test suite (`npm test`, `npm run validate`) and the Docker compose end-to-end isolation proof (`./scripts/compose-e2e.sh`).

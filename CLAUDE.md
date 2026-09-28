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

## Change Workflow & Enforcement (mandatory, all AI tools)
`DESIGN_AUTHORITY.md` is the source of truth and it is **machine-checked** (§6.7). Before changing code:
1. **Follow the Design Authority protocol (§2):** update intent and confirm it with the user, register the gap, and take a task lock listing every file you will touch. Do not edit files outside your lock.
2. **Never push to `main`.** `main` is protected: work on a branch, open a pull request, and merge only when CI (`test`, `compose-proof`) is green.
3. **Run `npm install` once per clone.** It enables the git `pre-push` hook (`.githooks/pre-push`), which runs `scripts/conformance.sh`. Never bypass it (`--no-verify`) or weaken a check to make it pass.
4. **Conformance failures are design violations, not flaky tests.** Fix the code. Only with the user's approval may a known violation be baselined, and only in `packages/conformance/baseline.json` with a registered gap.
5. **Never skip tests** (`describe.skip`, `it.skip`). CI fails on any skip.
6. **Egress and secrets (§6.3):** every agent connection goes through the gateway (E1–E6), every model call is metered through a gateway provider route (E5), and agents never hold real secrets (S1). There are no exceptions.

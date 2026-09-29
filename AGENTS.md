# Agent Factory — instructions for implementing AIs

You are deploying **BeerCanLabs Agent Factory**. Canonical architecture & task SSOT: `DESIGN_AUTHORITY.md` and `POSITION_PAPER.md`. On conflict: `DESIGN_AUTHORITY.md`, paper, then `.draft/sdp.yaml`, then this file. Cartridges use "The Notebook & Safe" pattern (local SQLite in `$MEMORY_DIR` synced to mind storage by Console shim; zero cloud SDKs in cartridges).

You are not installing Hermes, OpenClaw, or Garrison. You are not required to use AWS, ECS, or S3.

If a Draftsman / drafting-table session is available, run **that** onboarding interview and write answers into the SDP (`deploymentTarget`, `tierVariants.deploymentTarget.provider`). If not, ask the same questions here.

## Goal

A working factory on **whatever landing zone they actually have** (new Azure subscription, new AWS account, GCP, or a Linux VM):

- Control plane REST + MCP up and authenticated
- Agents wake from zero; shim in the same unit; mind on object storage; ledger metadata+hash
- Doorman deployed **sleeping** (no Discord app required)
- Kernel from this repo; cloud products from the pattern table, not from a hardcoded AWS module

## Interview (Draftsman baseline)

Ask in this order. Do not skip to Terraform.

1. **Provider** — Azure, AWS, GCP, or a VM/Compose host? Use credentials they give you. If they only have Azure, do **not** apply `landing-zones/aws`.
2. **Baseline pattern** (`.draft/sdp.yaml` `notes.baselinePatterns` / `landing-zones/PATTERNS.md`):
   - `serverless-containers` — Container Apps / Cloud Run / App Runner; agents min=0
   - `orchestrated-tasks` — AKS / ECS / GKE; mailbox as a service, agents as jobs
   - `compose-host` — `landing-zones/compose`
3. **IdP** — Entra, Cloudflare Access, Google OIDC, or bearer for first bring-up.
4. **Secrets manager** — Key Vault, AWS SM, GCP SM, Vault, or a file on the VM.
5. **Discord** — optional; only if they will add a cartridge with a `discord` surface.
6. **Prompt traces** — optional; `FACTORY_TRACE_PROMPTS` + TTL.

Record the answers on the SDP (`tierVariants`, `serviceGroups[].deploymentTarget`). Then bind the slot table in `landing-zones/PATTERNS.md` and provision.

Example: Azure + serverless-containers → Container Apps + Blob + Key Vault + Entra. No ECS.

## Kernel (always)

`packages/contract`, `auth`, `secrets-bind`, `hydrate`, `ledger`, `control-plane`, `doorman`, `telemetry/`. Example cartridges under `agents/` are not factory modules.

## Landing-zone examples (optional cargo-cult)

- `landing-zones/aws` — **orchestrated-tasks × AWS only**. Use iff interview selected that pair.
- `landing-zones/azure` — bind notes, not a second kernel.
- `landing-zones/gcp` — bind notes.
- `landing-zones/compose` — compose-host.

## Discord / Doorman

Always deploy Doorman. No bot token at factory build. Presence offline while the agent sleeps; available after handoff; do not drop the Gateway.

## Definition of done

1. Control plane `/healthz` on the chosen ingress
2. Authenticated `GET /api/v1/agents` and `POST /mcp` `tools/list`
3. Echo (or their cartridge) wake returns 200; compute actually starts on the chosen pattern; ledger has `RESUME`; mind prefix exists after sleeping
4. Ledger has no secrets and no prompt bodies
5. Doorman `/healthz` is `discord: sleeping` without a bot token
6. SDP `deploymentTarget` is no longer `drafting-interview-required`

## Secrets

Names only in git. Unbound required names → HTTP 412. Agents receive placeholders, never real values (S1).

## Change Workflow & Enforcement (mandatory, all AI tools)
`DESIGN_AUTHORITY.md` is the source of truth and it is **machine-checked** (§6.7). Before changing code:
1. **Follow the Design Authority protocol (§2):** first cite the existing invariants (§6) and the user's recorded decisions (§7) that apply (if one already covers the case, fix the violation instead of adding a rule), then update intent and confirm it with the user, register the gap, and take a task lock listing every file you will touch. Do not edit files outside your lock.
2. **Never push to `main`.** `main` is protected: work on a branch, open a pull request, and merge only when CI (`test`, `compose-proof`) is green.
3. **Run `npm install` once per clone.** It enables the git `pre-push` hook (`.githooks/pre-push`), which runs `scripts/conformance.sh`. Never bypass it (`--no-verify`) or weaken a check to make it pass.
4. **Conformance failures are design violations, not flaky tests.** Fix the code. Only with the user's approval may a known violation be baselined, and only in `packages/conformance/baseline.json` with a registered gap.
5. **Never skip tests** (`describe.skip`, `it.skip`). CI fails on any skip.
6. **Egress and secrets (§6.3):** every agent connection goes through the gateway (E1–E6), every model call is metered through a gateway provider route (E5), and agents never hold real secrets (S1). There are no exceptions.

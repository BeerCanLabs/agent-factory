# Antigravity Rules for agent-factory

These rules dictate how you (Antigravity) must interact with this repository.

## 1. AWS and Infrastructure Operations
This repository contains a highly isolated deployment pipeline targeting the BeerCanLabs AWS account. To prevent credential leakage or accidental deployments to Frontline accounts, **you must never use the standard `aws` or `terraform` CLI commands directly.**

When you need to interact with AWS or Terraform:
1. You MUST use the wrapper script located at `./scripts/bcl-aws`.
2. You MUST ensure `.envrc` is sourced in your execution environment before running the wrapper, as it contains the required `BCL_AWS_ACCOUNT_ID` variable.

**Examples:**
* ❌ Incorrect: `aws sts get-caller-identity`
* ❌ Incorrect: `terraform apply`
* ✅ Correct: `source .envrc && ./scripts/bcl-aws aws sts get-caller-identity`
* ✅ Correct: `source .envrc && ./scripts/bcl-aws aws ecs list-clusters`
* ✅ Correct: `source .envrc && ./scripts/bcl-aws terraform plan`

The isolated configuration directory is maintained at `~/.aws/beercanlabs/`. The script automatically handles pointing the CLI tools to this directory and purging ambient environment variables.

## 2. General Etiquette
* Follow the architectural constraints defined in `POSITION_PAPER.md` (Console vs. Cartridge).
* The Factory relies on four specific ingress/egress interfaces (API, Webhooks, WebSockets, Events) as documented in `KPF.md`. Do not invent new interfaces.

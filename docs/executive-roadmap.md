# Executive roadmap: model configuration

Status: **intent confirmed (Dale, chat, 2026-10-10); extraction done, model configuration queued.** The Executive
extraction (`DESIGN_AUTHORITY.md` §6.15, step 6; TSK-147 to TSK-155) was moves only, apart from the guard test that
fails on a second copy of its rules. The behavior below is a separate
work stream that follows it (GAP-126; TSK-165 to TSK-170). This file is for any person or AI agent picking the work up;
everything in it can be checked against the code paths named below.

## Intent

1. **Model choice is configuration, not code.** The agent's owner chooses the model the agent runs on, a **backup
   model**, and optionally **a model for each skill** the agent has adopted. They do it through the API, and the console
   calls that API, as often as they like. A new model becoming available never needs a rebuild, a redeploy or a
   cartridge change: the owner selects it.
2. **Nothing in code names a model.** Cartridges and skills carry no model names and there is no "preferred model"
   option. A model name that a call carries is recorded in the ledger but does not decide what serves it
   (`DESIGN_AUTHORITY.md` M2).
3. **Agents do work of different weight.** Some tasks need a strong model and some do not. The owner sets a skill's
   model in the agent's configuration, so a simple skill can run on a lighter model than the agent's primary.
4. **The Executive serves the choice.** It serves the owner's selected model, serves the backup when the selected model
   cannot serve a call, and records both the model requested and the model served.
5. **Provider-native routes stay strict (M4).** A call made in a provider's own format names a model in that format and
   cannot be substituted. It is served or refused under the policy's allow-list.

## What the code does today (checked 2026-10-10)

- The owner's control is the policy's `models` list (`packages/gatekeeper/src/policy/index.ts`; edited in
  `packages/console/src/components/PolicyEditor.tsx`). It is an allow-list. There is no field for a selected model, a
  backup or a per-skill model.
- A policy that names no models grants exactly the factory default, never every model (M2, E7). *(2026-10-18, GAP-181:
  the default is factory configuration, never a value in code; none configured means `no_default_model`.)*
- *(Superseded 2026-10-18, GAP-181.)* The gatekeeper-egress used to **refuse** a model the policy does not list
  (403 `model_not_allowed`). The factory model API now serves the run's pin, the policy's first model or the default,
  whatever the call names, and records a differing name as `requestedModel`. Provider-native routes (M4) stay strict.
- A run is pinned only when a caller names a model for that run (`run.model`, delivered to the agent as
  `FACTORY_MODEL`, `app.ts`).
- **Model names are written in code and metadata:** the cartridge's `model` and `models` (`packages/contract/src/schema.ts`),
  stored by the registrar as `requestedModels`; the registration route reading `cartridge.model` (`app.ts`); the skill
  manifest's `requires.models` (`packages/contract/src/skill.ts`) and the missing-models check in
  `packages/control-plane/src/skills.ts`.
- **The failback lives in the cartridge.** SM-donna reads `model:` and `models:` from `cartridge.yaml` and has a
  hard-coded `DEFAULT_FALLBACK_MODEL` in `agent.py` (`load_model_preferences`). It retries once on 400 or 403 and is not
  told the allowed list. The owner cannot see or change it.
- The model catalog (names, providers, prices) is operations data: `FACTORY_MODEL_CATALOG` (M3).
- Skills run inside the agent and there is no shared layer that makes model calls for them.

### The incident that motivates this

On 2026-10-05 Donna had no model. Her policy history in the configuration store showed version 6 ("policy updated")
narrowing her allowed models from `[claude-sonnet-4-5, claude-haiku-4-5]` to `[claude-sonnet-4-6]`. Her cartridge asks
for `claude-sonnet-4-5` and falls back to `claude-haiku-4-5`; both were refused with 403 `model_not_allowed`, and she
answered "model access is unavailable right now." Nothing was down. A model choice made by the owner broke an agent
whose code named other models.

## Order of work

**First, the extraction (moves only, apart from the guard test): done** (TSK-147 to TSK-155: the plan in #125, the code in #128, #132 and #134). The signer,
the catalog and adapters, token counting, the policy gate (`checkModel`, `offeredModels`) and the serving of a call
(`findModel`, `complete`) are in `packages/executive`; the Executive owns no file in `gatekeeper-egress`; a conformance
test guards against a second copy. What stays in the egress is GAP-130.

**Then the model configuration work stream** (each task is scoped when its turn comes):

1. **TSK-165, the policy holds the selection (Completed, Slice 1 / PR #280):** `policy.models: string[]` (approved models), `currentModel` (execution slot), `primaryModel` (1st failback target), `secondaryModel` (optional 2nd failback target). Two-tier authority (`M2`, `M3`), retirement & unapproval cascading transitions, and effective slots resolution. Headless REST API (`GET`/`PUT /api/v1/agents/:id/models`) and MCP tools (`get_agent_models`, `set_agent_models`).
2. **TSK-166, the Executive serves it (Completed, Slice 1 / PR #280):** `resolveModel` and `failbackCandidates` in `packages/executive`; egress serves `selection.model` and records both `model` (served) and `requestedModel` (differing request).
3. **TSK-168, persistent failback & model failover (Completed, Slice 2 / PR #281):** Egress candidate chain `failbackCandidates(policy, requested)` (`[current, primary, secondary]`). Automatic failover on transient upstream errors (5xx, 429, 503, unpriced 403, 422 malformed tool syntax). Non-failover fatal errors fail immediately (403 unapproved, 403 pinned, 400 bad json, 400 streaming, 402 budget, 429 throttle). Mid-failover budget metering and standing checks. Egress failover handler calls `POST /api/v1/gatekeeper-egress/runs/:id/failover` which ledgers `MODEL_FAILOVER` and persists `currentModel` across agent turns.
4. **TSK-287 / GAP-210, run-token model selection & conversational parity (Completed, Slice 3 / PR #282):** Run-token parity on REST (`GET`/`PUT /api/v1/runs/:id/models`) and MCP (`POST /mcp` `get_agent_models`/`set_agent_models`). Verified human requester authority check (agent owner or factory admin) with warm-run taint protection (non-manager turns taint the run, returning 403 `requester_unauthorized_for_model_switch`). Prompt-injection ceiling: `approvedModels` is strictly read-only for agents (mutation rejected with 403 `approved_models_ceiling`), model slots selectable strictly within approved models. Transparent egress injection and execution of `factory_get_models` and `factory_set_models` with AP3 footnote preservation (`[no tools called]` omitted on text turns without caller tools).
5. **TSK-167, a skill's calls use the skill's model (Queued):** each call from a skill carries the skill's id.
6. **TSK-169, the console (Queued):** the owner picks the model, the backup and each skill's model from the offered models in Console UI.
7. **TSK-170, remove model names from code and metadata (Queued):** migrate SM-donna and SM-template. Accept-and-ignore before removing, so no existing cartridge or skill breaks.

## Open decisions for Dale

1. **What "cannot serve" means for the backup:** the selected model is not offered, or the provider answers 429, 5xx or
   times out. And whether a failover is visible to the person or only in the ledger (the ledger is confirmed; more is open).
2. **Cost.** A backup that costs more than the selected model: how it counts against the budget; whether the console
   shows each model's price when the owner selects.
3. **How a skill's id reaches the call.** A header the skill sets, or a small shared helper that ships with the starter
   template (there is no shared layer today).
4. **How soon a running agent sees a change** to its selection (the run's policy is cached for a short time in the
   egress). Check before promising "immediately".

## Constraints that stay

- The Donna Test: what a model is asked and how an agent reasons stays in the cartridge; which model serves the call is
  the Factory's. No new interface beyond API, webhooks, WebSockets and events (`KPF.md`); a header on the existing model
  API call is a field, not an interface.
- M3: prices and the catalog are operations data, not repository data. E5: every model call is metered through the
  gatekeeper-egress. E7: deny by default still applies to routes, to the allow-list and to provider-native model calls.
- A model change by the owner must never require editing or redeploying a cartridge.

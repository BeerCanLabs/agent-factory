# Executive roadmap: model selection

Status: **intent recorded, not started.** Plan and build when the Executive's turn comes in the Cast extraction roadmap
(`DESIGN_AUTHORITY.md` §6.15, step 6). Owner of the intent: Dale (chat, 2026-10-05). This file is for any person or AI
agent picking the work up; it is self-contained, and everything in it can be checked against the code paths named below.

## Intent

1. **A cartridge hints; it does not require.** The cartridge says which model it was tested and optimized for. That is
   the agent builder's belief about what gives good results. The Factory is free to follow it or not
   (`DESIGN_AUTHORITY.md` M2, "Preferred, not chosen").
2. **The agent owner chooses.** The Factory shows the owner the models it offers. The owner selects the model the agent
   runs on and a **secondary model for failback**. Neither is named by the cartridge, and changing either never needs a
   cartridge update.
3. **Skills hint too.** A skill can say which model it is optimized for, and an agent executing that skill can run it on
   a different model than the agent's primary.
4. **The Executive serves.** The Executive (the Factory's model service) applies the owner's selection: it serves the primary,
   fails over to the secondary, and records which model actually served each call.

## What the code does today (checked 2026-10-05)

- The cartridge declares `model:` and an optional `models:` list in `cartridge.yaml`. The Factory stores the list as
  `requestedModels` (`packages/registrar/src/catalog.ts`, `app.ts` registry route).
- The owner's control is the policy's `models` list (`packages/control-plane/src/policy.ts`; edited in
  `packages/console/src/components/PolicyEditor.tsx`). It is an allow-list. There is no field for a primary or a
  secondary, and the console cannot name a fallback.
- A policy that names no models grants exactly the factory default (`FACTORY_DEFAULT_MODEL`, Claude Haiku 4.5 unless
  operations configure another), never every model (M2).
- The gatekeeper-egress **denies** a model the policy does not list: `modelDenial` in
  `packages/gatekeeper-egress/src/gatekeeper-egress.ts` answers 403 `model_not_allowed`, and 403 `model_pinned` when a
  run is pinned to another model. Nothing substitutes an allowed model.
- A run is pinned only when a caller names a model for that run (`run.model`, delivered to the agent as
  `FACTORY_MODEL`, `app.ts`). Normal wakes have no pin, so the agent asks for its own preference.
- **The failback lives in the cartridge.** For example SM-donna reads `model:` and the `models:` list from
  `cartridge.yaml` and has a hard-coded `DEFAULT_FALLBACK_MODEL` in `agent.py` (`load_model_preferences`). It retries
  once on 400 or 403 and is not told the allowed list. The owner cannot see or change it.
- The model catalog (names, providers, prices) is operations data: `FACTORY_MODEL_CATALOG` (M3).

### The incident that motivates this

On 2026-10-05 Donna had no model. Her policy history in the configuration store showed version 6 ("policy updated")
narrowing her allowed models from `[claude-sonnet-4-5, claude-haiku-4-5]` to `[claude-sonnet-4-6]`. Her cartridge asks
for `claude-sonnet-4-5` and falls back to `claude-haiku-4-5`; both were refused with 403 `model_not_allowed`, and she
answered "model access is unavailable right now." Nothing was down. A model choice made by the owner broke an agent
whose cartridge named other models.

## Target flow

| Part | What it means |
| :--- | :--- |
| Hints | `cartridge.yaml` keeps `model:` as a hint; `skill.yaml` gains an optional model hint. Hints are advice shown to the owner, never a requirement. |
| Owner selection | The policy gains an owner-chosen primary and secondary model, picked in the console from the offered catalog. The allow-list and the selection stay consistent. |
| Per-skill model | When an agent executes a skill, the model call carries which skill it is for, and the Executive may choose a model for that skill (the skill's hint, subject to the policy) instead of the agent's primary. |
| The Executive serves | One resolution rule: skill choice, then the owner's primary, then the owner's secondary, then the factory default, only among models the policy allows. The ledger records the requested and the served model. |

## Open decisions for Dale (not answered yet)

1. **Where the hints are declared and what they are called** in `cartridge.yaml` and `skill.yaml`, and whether the
   Factory should warn the owner when a hint is not allowed or not offered.
2. **What a failover looks like to the person:** silent with a ledger record, or visible in the console (a warning on
   the agent), or in the reply.
3. **How the Factory knows a call is for a skill.** The agent must say so on the model call; decide the field and
   whether an agent that does not say gets only the primary.
4. **What happens on provider-native routes** (an agent calling a provider directly instead of the factory model API).
   Today they are explicit and denied when not allowed (M4); decide whether they follow the same resolution or stay
   explicit.
5. **Cost.** The owner's selection decides the price; decide whether the console shows the price of each offered model
   at selection time, and how a secondary that costs more than the primary is treated against the budget.
6. **Cartridge fallbacks that already exist** (SM-donna and the SM-template): whether the Factory tells the cartridge
   which model to use for the run so a cartridge stops carrying its own failback.

## Proposed order of work (plan each part when its turn comes)

Follow the shape of the Treasurer and Bouncer extractions in `DESIGN_AUTHORITY.md`: small tasks, each green on its own,
behavior-preserving moves first, new behavior as separate later tasks, decisions written as "Confirmed by Dale" before
anything is handed to an executor, and the plan checked against the code by someone other than its author.

1. **Extract the Executive** into its own package behind a typed contract (moves only): provider translation, token
   counting, model catalog and the model-policy check currently inside `gatekeeper-egress`. Pricing is already the
   Treasurer's (`packages/budget`).
2. **The resolution contract**: a pure function `resolveModel({ policy, hint, skill })` in the Executive package that
   returns the model to serve and why, with the rule above. Unit tests cover every branch.
3. **Policy fields**: primary and secondary in the policy, with validation and a migration so existing policies keep
   the behavior they have now.
4. **The egress uses it** on the factory model API: serve the resolved model instead of denying, and ledger the
   requested and the served model. Provider-native routes follow decision 4.
5. **Console**: the owner picks the primary and secondary from the offered models; hints are shown beside them.
6. **Skill hints**: the `skill.yaml` field, its validation in the skill checks, and the per-call skill signal.
7. **Cartridge guidance**: update the Cartridge Developer Guide and SM-template so a cartridge states a hint and does
   not carry its own failback; migrate SM-donna.

## Constraints that stay

- The Donna Test: what a model is asked and how an agent reasons stays in the cartridge; which model serves the call
  is the Factory's. No new interface beyond API, webhooks, WebSockets and events (`KPF.md`).
- M3: prices and the catalog are operations data, not repository data. E5: every model call is metered through the
  gatekeeper-egress. E7: deny by default still applies to routes and to provider-native model calls.
- A model change by the owner must never require editing or redeploying a cartridge.

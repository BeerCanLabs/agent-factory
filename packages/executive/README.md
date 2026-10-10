# Executive (`@beercanlabs/factory-executive`)

The Executive is the Factory's model service (`DESIGN_AUTHORITY.md` §6.15, M1 to M4). It is being extracted from `packages/gatekeeper-egress` one piece at a time (the Executive flow work stream, TSK-148 to TSK-155).

Today it holds:

- `signV4`, `awsCredentialsFromEnv`: AWS SigV4 request signing, used by the Bedrock adapter.
- `parseModelCatalog`, `parseChatRequest`, `defaultModelAdapters`, `bedrockConverse`, `toConverse`, `fromConverse`, `ModelUpstreamError`: the model catalog (operations data, M3), the OpenAI-compatible request rules (M1) and the provider adapters.
- `usageFromJson`, `SseMeter`, `Usage`, `Provider`: token counting (E5). The Executive reports each call's usage; the Treasurer prices it (`packages/budget`).
- `checkModel`, `offeredModels`: whether an agent may use a model (the policy's allow-list, the factory default when it names none, the training exemption and a run's pin). The Executive decides; the gatekeeper-egress enforces the answer.
- `findModel`, `complete`: serving one call on the factory model API: the catalog lookup, then, after the egress's own checks, validating the request, finding the provider's adapter and calling it. `complete` never throws; it returns the result, a refusal made before any provider was called, or the upstream failure.

The handlers (`handleModels`, `handleLlm`), the throttle, the price check, the ledger rows and the egress's own metrics stay in `gatekeeper-egress`: they are the Gatekeeper's, the Treasurer's, the Auditor's and the Inspector's.

The dependency points one way: the egress depends on the Executive; the Executive never imports the egress, the control plane or the console. Prices and the catalog are operations data (M3), not repository data.

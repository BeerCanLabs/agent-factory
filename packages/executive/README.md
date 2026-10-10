# Executive (`@beercanlabs/factory-executive`)

The Executive is the Factory's model service (`DESIGN_AUTHORITY.md` §6.15, M1 to M4). It is being extracted from `packages/gatekeeper-egress` one piece at a time (the Executive flow work stream, TSK-148 to TSK-155).

Today it holds:

- `signV4`, `awsCredentialsFromEnv`: AWS SigV4 request signing, used by the Bedrock adapter.
- `parseModelCatalog`, `parseChatRequest`, `defaultModelAdapters`, `bedrockConverse`, `toConverse`, `fromConverse`, `ModelUpstreamError`: the model catalog (operations data, M3), the OpenAI-compatible request rules (M1) and the provider adapters.
- `usageFromJson`, `SseMeter`, `Usage`, `Provider`: token counting (E5). The Executive reports each call's usage; the Treasurer prices it (`packages/budget`).

Still in `gatekeeper-egress` until its task lands: the model-policy gate (`modelDenial`, TSK-151).

The dependency points one way: the egress depends on the Executive; the Executive never imports the egress, the control plane or the console. Prices and the catalog are operations data (M3), not repository data.

export { signV4, awsCredentialsFromEnv } from './sigv4.js';
export type { AwsCredentials } from './sigv4.js';
export { checkModel, offeredModels, selectModel, failbackCandidates } from './model-policy.js';
export type { ModelCheck, ModelPolicy, ModelSelection } from './model-policy.js';
export { complete, findModel } from './complete.js';
export type { Completion } from './complete.js';
export { SseMeter, usageFromJson } from './meter.js';
export type { Provider, Usage } from './meter.js';
export {
  bedrockConverse,
  vertexGemini,
  vertexAnthropic,
  anthropicMessages,
  openAiCompatible,
  defaultModelAdapters,
  BUILTIN_PROVIDER_SECRETS,
  BUILTIN_PROVIDER_HOSTS,
  resolveProviderSecret,
  parseModelCatalog,
  parseChatRequest,
  toConverse,
  toOpenAiMessages,
  claudeAcceptsSampling,
  modelCapabilities,
  fromConverse,
  ModelUpstreamError,
} from './models.js';
export type {
  BedrockConverseOptions,
  VertexOptions,
  ApiKeyAdapterOptions,
  DefaultModelAdaptersOptions,
  CatalogEntry,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelAdapter,
  ModelCapabilities,
  ModelCatalog,
} from './models.js';
export {
  discoverVendorModels,
  resolveModelReference,
  REFERENCE_MODEL_PRICING,
} from './discovery.js';
export type {
  DiscoveredModel,
  ModelPricing,
  ModelReference,
  VendorDiscoveryOptions,
} from './discovery.js';

export {
  subscriptionResponses,
  discoverSubscriptionModels,
  subscriptionHeaders,
  subscriptionInferenceUrl,
  toResponsesRequest,
  fromResponses,
  readResponsesStream,
  recogniseSubscriptionError,
  chatgptAccountIdFromJwt,
  SubscriptionLimitError,
  SubscriptionNeedsReconsentError,
} from './responses.js';
export type { ResponsesAdapterOptions, SubscriptionTokenResult, SubscriptionDiscovery, SubscriptionModel } from './responses.js';
export function isSubscriptionEntry(entry: { credentialMode?: string; connection?: string }): entry is { credentialMode: 'subscription'; connection: string } {
  return entry.credentialMode === 'subscription' && typeof entry.connection === 'string' && entry.connection.length > 0;
}

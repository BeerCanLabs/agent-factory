import { z } from 'zod';

/**
 * System definition schemas (DESIGN_AUTHORITY.md §6.3.1 E10).
 *
 * External systems an agent reaches, other than model providers (§6.9), are defined once in the factory:
 * where requests go (upstream), the credential kind (static secret or OAuth connection) and how it is injected.
 * Admin approval is required per definition version.
 */

export const SYSTEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Model provider hosts (E5): model calls use landing-zone provider routes, unless registered as an ai-provider system. */
export const MODEL_PROVIDER_HOST = /(^|\.)(api\.anthropic\.com|api\.openai\.com|api\.x\.ai|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|openai\.azure\.com)$|^bedrock(-runtime)?[.-]/;

const systemUpstream = z
  .string()
  .url('upstream must be a valid https URL')
  .refine((u) => u.startsWith('https://'), 'upstream must be an https URL');

export const aiProviderConfigSchema = z
  .object({
    adapter: z.enum(['openAiCompatible', 'anthropicMessages', 'vertexGemini', 'vertexAnthropic', 'bedrockConverse']).default('openAiCompatible'),
    discoveryPath: z.string().optional().default('/v1/models'),
    defaultHeaders: z.record(z.string()).optional(),
  })
  .strict();

export const systemCredentialSchema = z
  .object({
    secret: z.string().min(1),
    header: z.string().min(1),
    format: z.string().optional(),
    fallback: z.boolean().optional(),
    /** `basic`: the formatted value is sent as HTTP Basic credentials (base64), e.g. git over HTTPS (`x-access-token:{}`). */
    encoding: z.enum(['basic']).optional(),
  })
  .strict();

export const systemHoldSchema = z
  .object({
    methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])).min(1),
    preview: z.string().optional(),
  })
  .strict();

const httpsUrl = (field: string) =>
  z.string().url(`${field} must be a valid URL`).refine((u) => u.startsWith('https://'), `${field} must be an https URL`);

/** Keymaster-named entries for a provider's own credentials (K5.1): no one chooses a secret-manager name. */
export const oauthClientSecretName = (systemId: string) => `shared/${systemId}/oauth-client`;
export const serviceAccountKeyName = (systemId: string) => `shared/${systemId}/service-account-key`;

/** Platform API-key name for a system. Built-ins keep the secret already in the store; every other id gets its own. */
const BUILTIN_PLATFORM_CREDENTIAL: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  google: 'GEMINI_API_KEY',
};

export function platformCredentialName(systemId: string): string {
  return BUILTIN_PLATFORM_CREDENTIAL[systemId] ?? `${systemId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

export const systemOAuthUserSchema = z
  .object({
    kind: z.literal('oauth-user').default('oauth-user'),
    authUrl: httpsUrl('authUrl'),
    tokenUrl: httpsUrl('tokenUrl'),
    /** Where the Keymaster keeps this provider's OAuth client. Omitted: `shared/<system id>/oauth-client` (K5.1). */
    clientSecret: z.string().min(1).optional(),
    authParams: z.record(z.string()).optional(),
    refresh: z.boolean().optional(),
    defaultScopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const systemJwtBearerSchema = z
  .object({
    kind: z.literal('jwt-bearer'),
    tokenUrl: httpsUrl('tokenUrl'),
    /** Where the Keymaster keeps the service-account key. Omitted: `shared/<system id>/service-account-key` (K5.1). */
    keySecret: z.string().min(1).optional(),
    defaultScopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const systemOAuthSchema = z.discriminatedUnion('kind', [
  systemOAuthUserSchema,
  systemJwtBearerSchema,
]);

export const systemProposalSchema = z
  .object({
    id: z.string().max(64).regex(SYSTEM_ID, 'system id must be kebab-case (e.g. github, discord, closing-climb)'),
    name: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(['http', 'mcp', 'ai-provider']).default('http'),
    upstream: systemUpstream,
    aiProvider: aiProviderConfigSchema.optional(),
    credential: systemCredentialSchema.optional(),
    connection: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
    oauth: systemOAuthSchema.optional(),
    hold: systemHoldSchema.optional(),
    stripSignInLinks: z.boolean().optional(),
    maxContentChars: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.kind === 'ai-provider') return true;
      try {
        return !MODEL_PROVIDER_HOST.test(new URL(data.upstream).hostname);
      } catch {
        return true;
      }
    },
    { message: 'a model provider is not a system (E5: model calls use provider routes)', path: ['upstream'] },
  )
  .refine(
    (data) => !(data.credential && data.connection),
    { message: 'a system definition cannot combine a static credential and a Keymaster connection', path: ['connection'] },
  )
  .refine(
    (data) => !(data.credential && data.oauth),
    { message: 'a system definition cannot combine a static credential and OAuth provider configuration', path: ['oauth'] },
  )
  .refine(
    (data) => !(data.connection && data.kind !== 'http'),
    { message: 'Keymaster connections are supported on http systems only', path: ['connection'] },
  )
  .refine(
    (data) => !(data.oauth && data.kind !== 'http'),
    { message: 'OAuth providers are supported on http systems only', path: ['oauth'] },
  );

export const systemDefinitionSchema = z
  .object({
    id: z.string().max(64).regex(SYSTEM_ID, 'system id must be kebab-case (e.g. github, discord, closing-climb)'),
    name: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(['http', 'mcp', 'ai-provider']).default('http'),
    upstream: systemUpstream,
    aiProvider: aiProviderConfigSchema.optional(),
    credential: systemCredentialSchema.optional(),
    connection: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
    oauth: systemOAuthSchema.optional(),
    hold: systemHoldSchema.optional(),
    stripSignInLinks: z.boolean().optional(),
    maxContentChars: z.number().int().positive().optional(),
    version: z.number().int().positive(),
    status: z.enum(['proposed', 'approved', 'rejected']),
    proposedBy: z.string().min(1),
    proposedAt: z.string().min(1),
    decidedBy: z.string().optional(),
    decidedAt: z.string().optional(),
    reason: z.string().optional(),
    hash: z.string().min(1),
  })
  .strict()
  .refine(
    (data) => {
      if (data.kind === 'ai-provider') return true;
      try {
        return !MODEL_PROVIDER_HOST.test(new URL(data.upstream).hostname);
      } catch {
        return true;
      }
    },
    { message: 'a model provider is not a system (E5: model calls use provider routes)', path: ['upstream'] },
  )
  .refine(
    (data) => !(data.credential && data.connection),
    { message: 'a system definition cannot combine a static credential and a Keymaster connection', path: ['connection'] },
  )
  .refine(
    (data) => !(data.credential && data.oauth),
    { message: 'a system definition cannot combine a static credential and OAuth provider configuration', path: ['oauth'] },
  )
  .refine(
    (data) => !(data.connection && data.kind !== 'http'),
    { message: 'Keymaster connections are supported on http systems only', path: ['connection'] },
  )
  .refine(
    (data) => !(data.oauth && data.kind !== 'http'),
    { message: 'OAuth providers are supported on http systems only', path: ['oauth'] },
  );

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;
export type SystemCredential = z.infer<typeof systemCredentialSchema>;
export type SystemHold = z.infer<typeof systemHoldSchema>;
export type SystemOAuthUser = z.infer<typeof systemOAuthUserSchema>;
export type SystemJwtBearer = z.infer<typeof systemJwtBearerSchema>;
export type SystemOAuth = z.infer<typeof systemOAuthSchema>;
export type SystemProposal = z.infer<typeof systemProposalSchema>;
export type SystemDefinition = z.infer<typeof systemDefinitionSchema>;

export const AI_PROVIDER_TEMPLATES: Record<string, {
  name: string;
  description: string;
  upstream: string;
  adapter: 'openAiCompatible' | 'anthropicMessages' | 'vertexGemini' | 'vertexAnthropic' | 'bedrockConverse';
  adapterKey: string;
  heldSecret: string;
  discoveryPath: string;
  credentialHeader: string;
  credentialFormat?: string;
}> = {
  openai: {
    name: 'OpenAI',
    description: 'Flagship models (GPT-4o, o1, o3-mini) from OpenAI',
    upstream: 'https://api.openai.com',
    adapter: 'openAiCompatible',
    adapterKey: 'openai',
    heldSecret: 'OPENAI_API_KEY',
    discoveryPath: '/v1/models',
    credentialHeader: 'Authorization',
    credentialFormat: 'Bearer {}',
  },
  anthropic: {
    name: 'Anthropic',
    description: 'Claude models (Sonnet, Haiku, Opus) direct from Anthropic',
    upstream: 'https://api.anthropic.com',
    adapter: 'anthropicMessages',
    adapterKey: 'anthropic',
    heldSecret: 'ANTHROPIC_API_KEY',
    discoveryPath: '/v1/models',
    credentialHeader: 'x-api-key',
  },
  xai: {
    name: 'xAI (Grok)',
    description: 'Grok models from xAI',
    upstream: 'https://api.x.ai',
    adapter: 'openAiCompatible',
    adapterKey: 'xai',
    heldSecret: 'XAI_API_KEY',
    discoveryPath: '/v1/models',
    credentialHeader: 'Authorization',
    credentialFormat: 'Bearer {}',
  },
  google: {
    name: 'Google Gemini',
    description: 'Gemini models direct via Google AI Studio API',
    upstream: 'https://generativelanguage.googleapis.com',
    adapter: 'vertexGemini',
    adapterKey: 'google',
    heldSecret: 'GEMINI_API_KEY',
    discoveryPath: '/v1beta/models',
    credentialHeader: 'x-goog-api-key',
  },
  custom: {
    name: 'Custom OpenAI-Compatible',
    description: 'Self-hosted or specialized endpoint (Ollama, vLLM, DeepSeek, Together, Groq)',
    upstream: 'https://api.example.com',
    adapter: 'openAiCompatible',
    adapterKey: 'openai',
    heldSecret: '',
    discoveryPath: '/v1/models',
    credentialHeader: 'Authorization',
    credentialFormat: 'Bearer {}',
  },
};

export type SystemIssue = { path: string; message: string };
export type SystemValidation = { ok: true; proposal: SystemProposal } | { ok: false; issues: SystemIssue[] };

export function validateSystemProposal(raw: unknown): SystemValidation {
  const parsed = systemProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  return { ok: true, proposal: parsed.data };
}

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
    /** M5(1): `api-key` (a platform credential, today's only mode, the default) or `subscription` (a subscriber's plan). */
    credentialMode: z.enum(['api-key', 'subscription']).optional(),
    /** M5(5): the shipped subscription template this system was created from. Only meaningful with `subscription`. */
    templateId: z.string().min(1).optional(),
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
  gemini: 'GEMINI_API_KEY',
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

/**
 * Subscription templates (DESIGN_AUTHORITY.md §6.9 M5).
 *
 * A subscription template is contract code, reviewed with the Design Authority like AI_PROVIDER_TEMPLATES. It names the
 * vendor's public client its permission covers, the sign-in, token and inference hosts, the scopes, every header the
 * factory sends with its role, the vendor errors that mean plan limit or tier refused, and the vendor's permission record.
 * An admin cannot change any of it, and a system an admin proposes cannot carry the `subscription` mode.
 */
export type SubscriptionHeaderRole = 'factory-identity' | 'vendor-required';

export interface SubscriptionHeader {
  name: string;
  /** `{version}` is the factory version, `{access_token}` the Keymaster's current token, `{account_id}` the signed-in account's id. */
  value: string;
  role: SubscriptionHeaderRole;
}

/** A vendor response that means the plan's usage limit is spent, or the plan's tier is refused (M5(7)); never an ordinary rate limit. */
export interface SubscriptionErrorRecogniser {
  kind: 'plan-limit' | 'tier-refused';
  status: number;
  /** The vendor's own error code, read from `error.code` or `error.type` in the response body. */
  code: string;
  /** Where the vendor gives a reset time, in the body: epoch seconds (`resets_at`) or seconds from now (`resets_in_seconds`). */
  resetFields?: ('resets_at' | 'resets_in_seconds' | 'reset_at')[];
  /** False where the code is our best knowledge and not yet confirmed against a vendor response (TSK-327 confirms it against fixtures). */
  confirmed: boolean;
}

export interface SubscriptionTemplate {
  id: string;
  vendor: 'xai' | 'openai';
  name: string;
  description: string;
  /** The vendor's public client for third-party tools. Neither client needs a secret. */
  client: { id: string };
  signIn: {
    flow: 'device-code';
    deviceCodeUrl: string;
    verificationUrl: string;
    /** xAI: the OIDC discovery document, and the origin rule every discovered endpoint must meet (TSK-326). */
    discoveryUrl?: string;
    hostRule?: { scheme: 'https'; host: string; allowSubdomains: boolean };
  };
  tokenUrl: string;
  scopes: string[];
  inference: { upstream: string; path: string; adapter: 'responses' };
  /** What a system created from this template carries as `aiProvider.adapter` and `aiProvider.discoveryPath`. */
  aiProvider: { adapter: 'openAiCompatible'; discoveryPath: string };
  headers: SubscriptionHeader[];
  errors: SubscriptionErrorRecogniser[];
  permission: { statementUrls: string[]; checkedDate: string; tiers: string[] };
}

export const SUBSCRIPTION_TEMPLATES: Record<string, SubscriptionTemplate> = {
  'xai-subscription': {
    id: 'xai-subscription',
    vendor: 'xai',
    name: 'xAI (Grok) subscription',
    description: 'Grok models on a subscriber\'s SuperGrok or X Premium plan',
    client: { id: 'b1a00492-073a-47ea-816f-4c329264a828' },
    signIn: {
      flow: 'device-code',
      deviceCodeUrl: 'https://auth.x.ai/oauth2/device/code',
      // The verification URL comes from the device-code response and the token endpoint from OIDC discovery
      // (/tmp/hermes-ref hermes_cli/auth_xai.py); the values here are the expected ones, not vendor-documented constants.
      // TSK-326 must take both from discovery and the device-code response, accepting only https on x.ai or *.x.ai.
      verificationUrl: 'https://auth.x.ai/oauth2/device',
      discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
      hostRule: { scheme: 'https', host: 'x.ai', allowSubdomains: true },
    },
    // token_endpoint: from OIDC discovery (see above).
    tokenUrl: 'https://auth.x.ai/oauth2/token',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
    inference: { upstream: 'https://api.x.ai', path: '/v1/responses', adapter: 'responses' },
    aiProvider: { adapter: 'openAiCompatible', discoveryPath: '/v1/models' },
    headers: [
      { name: 'User-Agent', value: 'BeerCanLabs-AgentFactory/{version}', role: 'factory-identity' },
      { name: 'Authorization', value: 'Bearer {access_token}', role: 'vendor-required' },
    ],
    errors: [
      // unverified: no xAI source confirms these codes.
      { kind: 'plan-limit', status: 429, code: 'usage_limit_reached', resetFields: ['resets_at'], confirmed: false },
      // unverified
      { kind: 'tier-refused', status: 403, code: 'subscription_required', confirmed: false },
    ],
    permission: {
      statementUrls: ['https://x.ai/news/grok-hermes', 'https://x.ai/news/grok-openclaw', 'https://x.ai/news/grok-opencode'],
      checkedDate: '2026-11-07',
      tiers: ['SuperGrok', 'X Premium'],
    },
  },
  'openai-subscription': {
    id: 'openai-subscription',
    vendor: 'openai',
    name: 'OpenAI (ChatGPT) subscription',
    description: 'OpenAI models on a subscriber\'s ChatGPT Go, Plus or Pro plan',
    client: { id: 'app_EMoamEEZ73f0CkXaXp7hrann' },
    // Not RFC 8628: OpenAI's Codex device flow posts `client_id` only to the usercode endpoint and polls
    // `deviceauth/token`; the scopes below are informational (they apply to the browser flow). TSK-326 must not
    // treat `oauth.authUrl` (= the usercode URL) as an RFC 8628 device authorization endpoint.
    signIn: {
      flow: 'device-code',
      deviceCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
      verificationUrl: 'https://auth.openai.com/codex/device',
    },
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    inference: { upstream: 'https://chatgpt.com', path: '/backend-api/codex/responses', adapter: 'responses' },
    aiProvider: { adapter: 'openAiCompatible', discoveryPath: '/backend-api/codex/models' },
    // Hermes also sends the optional `x-openai-internal-codex-residency` header; it is intentionally omitted (M5(3): only
    // identity and vendor-required headers). TSK-327: a 401 may follow on residency-enforced workspaces.
    headers: [
      { name: 'User-Agent', value: 'BeerCanLabs-AgentFactory/{version}', role: 'factory-identity' },
      { name: 'originator', value: 'beercanlabs-agent-factory', role: 'factory-identity' },
      { name: 'Authorization', value: 'Bearer {access_token}', role: 'vendor-required' },
      { name: 'ChatGPT-Account-ID', value: '{account_id}', role: 'vendor-required' },
    ],
    errors: [
      // Confirmed: 429 with error.type or error.code `usage_limit_reached`.
      { kind: 'plan-limit', status: 429, code: 'usage_limit_reached', resetFields: ['resets_at', 'resets_in_seconds', 'reset_at'], confirmed: true },
      // unverified
      { kind: 'tier-refused', status: 403, code: 'usage_not_included', confirmed: false },
    ],
    permission: {
      statementUrls: ['https://help.openai.com/en/articles/20001542'],
      checkedDate: '2026-11-07',
      tiers: ['ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro'],
    },
  },
};

/** Vendors that prohibit subscription use in third-party software (M5(2)): Anthropic and Google. */
export const SUBSCRIPTION_PROHIBITED_HOST =
  /(^|\.)(anthropic\.com|claude\.ai|claude\.com|google|google\.com|googleapis\.com|googleusercontent\.com|geminicli\.com)$/;

export const SUBSCRIPTION_NOT_PERMITTED_MESSAGE =
  'subscription_not_permitted: Anthropic and Google prohibit using consumer plans in third-party agent software (M5(2)); use an API key or a cloud model service (M3)';

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Every sign-in, token and inference host a template names. */
export function subscriptionTemplateHosts(t: SubscriptionTemplate): string[] {
  return [t.signIn.deviceCodeUrl, t.signIn.verificationUrl, t.tokenUrl, t.inference.upstream]
    .map(hostOf)
    .filter((h): h is string => h !== undefined);
}

/** The M5(2) backstop: `subscription_not_permitted` for a template whose sign-in, token or inference host is Anthropic's or Google's. */
export function subscriptionTemplateIssue(t: SubscriptionTemplate): 'subscription_not_permitted' | undefined {
  return subscriptionTemplateHosts(t).some((h) => SUBSCRIPTION_PROHIBITED_HOST.test(h)) ? 'subscription_not_permitted' : undefined;
}

/** The static (factory identity) headers a subscription system carries; vendor-required ones are injected per call (M5(6)). */
export function subscriptionDefaultHeaders(t: SubscriptionTemplate): Record<string, string> {
  return Object.fromEntries(t.headers.filter((h) => h.role === 'factory-identity').map((h) => [h.name, h.value]));
}

const sameList = (a: readonly string[] | undefined, b: readonly string[]) =>
  !!a && a.length === b.length && a.every((v, i) => v === b[i]);

type SystemShape = {
  id: string;
  kind: 'http' | 'mcp' | 'ai-provider';
  upstream: string;
  aiProvider?: { adapter?: string; discoveryPath?: string; credentialMode?: string; templateId?: string; defaultHeaders?: Record<string, string> };
  credential?: unknown;
  connection?: string;
  oauth?: { kind: string; authUrl?: string; tokenUrl: string; defaultScopes?: string[]; clientSecret?: string; authParams?: Record<string, string>; refresh?: boolean };
  hold?: unknown;
  scopes?: unknown;
};

const isSubscription = (d: SystemShape) => d.aiProvider?.credentialMode === 'subscription';

/** M5(5): a stored definition may carry `subscription` only when created from a shipped template, taking everything from it. */
function subscriptionDefinitionIssues(d: SystemShape): SystemIssue[] {
  const issues: SystemIssue[] = [];
  if (!isSubscription(d)) {
    if (d.aiProvider?.templateId) issues.push({ path: 'aiProvider.templateId', message: 'templateId applies only to the subscription credential mode' });
    return issues;
  }
  const templateId = d.aiProvider?.templateId;
  const template = templateId ? SUBSCRIPTION_TEMPLATES[templateId] : undefined;
  if (!template) {
    issues.push({ path: 'aiProvider.templateId', message: 'the subscription mode requires a shipped subscription template id (M5(5))' });
    return issues;
  }
  const backstop = subscriptionTemplateIssue(template);
  if (backstop) issues.push({ path: 'aiProvider.templateId', message: SUBSCRIPTION_NOT_PERMITTED_MESSAGE });
  const hosts = [d.upstream, d.oauth?.tokenUrl, d.oauth?.authUrl].filter((u): u is string => !!u).map(hostOf);
  if (hosts.some((h) => h && SUBSCRIPTION_PROHIBITED_HOST.test(h))) {
    issues.push({ path: 'upstream', message: SUBSCRIPTION_NOT_PERMITTED_MESSAGE });
  }
  if (d.kind !== 'ai-provider') issues.push({ path: 'kind', message: 'a subscription system is an ai-provider system' });
  // One system per template: the system's id is its template's id (connections are per vendor account, M5(4)).
  if (d.id !== template.id) issues.push({ path: 'id', message: `a subscription system created from ${template.id} has that id` });
  if (d.credential) issues.push({ path: 'credential', message: 'a subscription system carries no static credential' });
  if (d.connection) issues.push({ path: 'connection', message: 'a subscription system carries no Keymaster connection declaration' });
  if (d.upstream !== template.inference.upstream) issues.push({ path: 'upstream', message: 'a subscription system takes its inference host from its template' });
  const o = d.oauth;
  const oauthKeys = ['kind', 'authUrl', 'tokenUrl', 'defaultScopes', 'refresh'];
  if (
    !o || o.kind !== 'oauth-user' || o.authUrl !== template.signIn.deviceCodeUrl || o.tokenUrl !== template.tokenUrl ||
    !sameList(o.defaultScopes, template.scopes) || o.refresh !== true ||
    o.clientSecret !== undefined || o.authParams !== undefined ||
    Object.keys(o).some((k) => !oauthKeys.includes(k))
  ) {
    issues.push({ path: 'oauth', message: 'a subscription system takes its public client sign-in, token host, scopes and refresh from its template, with no client secret or extra auth parameters' });
  }
  const ap = d.aiProvider ?? {};
  if (ap.adapter !== template.aiProvider.adapter || ap.discoveryPath !== template.aiProvider.discoveryPath) {
    issues.push({ path: 'aiProvider', message: 'a subscription system takes its adapter and discovery path from its template' });
  }
  const apKeys = ['adapter', 'discoveryPath', 'defaultHeaders', 'credentialMode', 'templateId'];
  if (Object.keys(ap).some((k) => !apKeys.includes(k))) {
    issues.push({ path: 'aiProvider', message: 'a subscription system carries no aiProvider field its template does not set' });
  }
  if (d.hold !== undefined || d.scopes !== undefined) {
    issues.push({ path: 'hold', message: 'a subscription system carries no hold or scopes its template does not set' });
  }
  const headers = ap.defaultHeaders;
  const want = subscriptionDefaultHeaders(template);
  const same = !!headers && Object.keys(headers).length === Object.keys(want).length && Object.entries(want).every(([k, v]) => headers[k] === v);
  if (!same) issues.push({ path: 'aiProvider.defaultHeaders', message: 'a subscription system carries exactly its template\'s factory-identity headers' });
  return issues;
}

/** M5(5): an admin-proposed system cannot carry the subscription mode, or name a template. */
function subscriptionProposalIssues(d: SystemShape): SystemIssue[] {
  if (isSubscription(d) || d.aiProvider?.templateId) {
    return [{
      path: 'aiProvider.credentialMode',
      message: 'the subscription mode is valid only on a system created from a shipped subscription template, never on a proposed system (M5(5))',
    }];
  }
  return [];
}

const addIssues = (issues: SystemIssue[], ctx: z.RefinementCtx) => {
  for (const i of issues) ctx.addIssue({ code: z.ZodIssueCode.custom, message: i.message, path: i.path.split('.') });
};

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
    (data) => !(data.oauth && data.kind !== 'http' && !isSubscription(data)),
    { message: 'OAuth providers are supported on http systems only', path: ['oauth'] },
  )
  .superRefine((data, ctx) => addIssues(subscriptionProposalIssues(data), ctx));

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
    (data) => !(data.oauth && data.kind !== 'http' && !isSubscription(data)),
    { message: 'OAuth providers are supported on http systems only', path: ['oauth'] },
  )
  .superRefine((data, ctx) => addIssues(subscriptionDefinitionIssues(data), ctx));

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
  gemini: {
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

import { z } from 'zod';

/**
 * System definition schemas (DESIGN_AUTHORITY.md §6.3.1 E10).
 *
 * External systems an agent reaches, other than model providers (§6.9), are defined once in the factory:
 * where requests go (upstream), the credential kind (static secret or OAuth connection) and how it is injected.
 * Admin approval is required per definition version.
 */

export const SYSTEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const systemCredentialSchema = z
  .object({
    secret: z.string().min(1),
    header: z.string().min(1),
    format: z.string().optional(),
    fallback: z.boolean().optional(),
  })
  .strict();

export const systemHoldSchema = z
  .object({
    methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])).min(1),
    preview: z.string().optional(),
  })
  .strict();

export const systemOAuthUserSchema = z
  .object({
    kind: z.literal('oauth-user').default('oauth-user'),
    authUrl: z.string().url('authUrl must be a valid URL'),
    tokenUrl: z.string().url('tokenUrl must be a valid URL'),
    clientSecret: z.string().min(1),
    authParams: z.record(z.string()).optional(),
    refresh: z.boolean().optional(),
    defaultScopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const systemJwtBearerSchema = z
  .object({
    kind: z.literal('jwt-bearer'),
    tokenUrl: z.string().url('tokenUrl must be a valid URL'),
    keySecret: z.string().min(1),
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
    kind: z.enum(['http', 'mcp']).default('http'),
    upstream: z.string().url('upstream must be a valid HTTP/HTTPS URL'),
    credential: systemCredentialSchema.optional(),
    connection: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
    oauth: systemOAuthSchema.optional(),
    hold: systemHoldSchema.optional(),
    stripSignInLinks: z.boolean().optional(),
  })
  .strict()
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
    kind: z.enum(['http', 'mcp']).default('http'),
    upstream: z.string().url('upstream must be a valid HTTP/HTTPS URL'),
    credential: systemCredentialSchema.optional(),
    connection: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
    oauth: systemOAuthSchema.optional(),
    hold: systemHoldSchema.optional(),
    stripSignInLinks: z.boolean().optional(),
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

export type SystemCredential = z.infer<typeof systemCredentialSchema>;
export type SystemHold = z.infer<typeof systemHoldSchema>;
export type SystemOAuthUser = z.infer<typeof systemOAuthUserSchema>;
export type SystemJwtBearer = z.infer<typeof systemJwtBearerSchema>;
export type SystemOAuth = z.infer<typeof systemOAuthSchema>;
export type SystemProposal = z.infer<typeof systemProposalSchema>;
export type SystemDefinition = z.infer<typeof systemDefinitionSchema>;

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

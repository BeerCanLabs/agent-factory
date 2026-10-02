import { z } from 'zod';

/**
 * System definition schemas (DESIGN_AUTHORITY.md §6.3.1 E10).
 *
 * External systems an agent reaches, other than model providers (§6.9), are defined once in the factory:
 * where requests go (upstream), the credential kind (static secret or OAuth connection) and how it is injected.
 * Admin approval is required per definition version.
 */

export const SYSTEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Model provider hosts (E5): model calls use landing-zone provider routes, never a factory system. */
export const MODEL_PROVIDER_HOST = /(^|\.)(api\.anthropic\.com|api\.openai\.com|api\.x\.ai|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|openai\.azure\.com)$|^bedrock(-runtime)?[.-]/;

const systemUpstream = z
  .string()
  .url('upstream must be a valid https URL')
  .refine((u) => u.startsWith('https://'), 'upstream must be an https URL')
  .refine((u) => {
    try {
      return !MODEL_PROVIDER_HOST.test(new URL(u).hostname);
    } catch {
      return false;
    }
  }, 'a model provider is not a system (E5: model calls use provider routes)');

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

export const systemProposalSchema = z
  .object({
    id: z.string().max(64).regex(SYSTEM_ID, 'system id must be kebab-case (e.g. github, discord, closing-climb)'),
    name: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(['http', 'mcp']).default('http'),
    upstream: systemUpstream,
    credential: systemCredentialSchema.optional(),
    connection: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
    hold: systemHoldSchema.optional(),
    stripSignInLinks: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => !(data.credential && data.connection),
    { message: 'a system definition cannot combine a static credential and a Keymaster connection', path: ['connection'] },
  )
  .refine(
    (data) => !(data.connection && data.kind !== 'http'),
    { message: 'Keymaster connections are supported on http systems only', path: ['connection'] },
  );

export const systemDefinitionSchema = z
  .object({
    id: z.string().max(64).regex(SYSTEM_ID, 'system id must be kebab-case (e.g. github, discord, closing-climb)'),
    name: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(['http', 'mcp']).default('http'),
    upstream: systemUpstream,
    credential: systemCredentialSchema.optional(),
    connection: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
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
    (data) => !(data.connection && data.kind !== 'http'),
    { message: 'Keymaster connections are supported on http systems only', path: ['connection'] },
  );

export type SystemCredential = z.infer<typeof systemCredentialSchema>;
export type SystemHold = z.infer<typeof systemHoldSchema>;
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

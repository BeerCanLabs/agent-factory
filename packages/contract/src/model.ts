import { z } from 'zod';

/**
 * Model offering schemas (DESIGN_AUTHORITY.md §6.9 M3).
 *
 * Each factory's offering (provider, the provider's model id, price) is factory data that admins maintain,
 * changed without a redeploy; provider keys are supplied through Keymaster platform credentials,
 * and a landing zone supplies only cloud permissions.
 */

export const MODEL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9.]+)*$/;

export const modelPriceSchema = z
  .object({
    inputPerMTok: z.number().nonnegative('inputPerMTok must be >= 0'),
    outputPerMTok: z.number().nonnegative('outputPerMTok must be >= 0'),
  })
  .strict();

export const modelProposalSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(MODEL_NAME_REGEX, 'model name must be lowercase kebab-case (e.g. claude-sonnet-4-5, gpt-4o)'),
    provider: z.string().min(1, 'provider is required'),
    id: z.string().min(1, 'id (provider model id) is required'),
    region: z.string().optional(),
    price: modelPriceSchema,
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const modelDefinitionSchema = modelProposalSchema
  .extend({
    version: z.number().int().positive(),
    status: z.enum(['proposed', 'approved', 'rejected']),
    proposedBy: z.string().min(1),
    proposedAt: z.string().min(1),
    decidedBy: z.string().optional(),
    decidedAt: z.string().optional(),
    reason: z.string().optional(),
    hash: z.string().min(1),
  })
  .strict();

export type ModelPrice = z.infer<typeof modelPriceSchema>;
export type ModelProposal = z.infer<typeof modelProposalSchema>;
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;
export type ModelStatus = ModelDefinition['status'];

export function validateModelProposal(data: unknown): { ok: true; proposal: ModelProposal } | { ok: false; error: string } {
  const result = modelProposalSchema.safeParse(data);
  if (result.success) {
    return { ok: true, proposal: result.data };
  }
  const firstIssue = result.error.issues[0];
  const path = firstIssue.path.join('.');
  return {
    ok: false,
    error: path ? `${path}: ${firstIssue.message}` : firstIssue.message,
  };
}

export function validateModelDefinition(data: unknown): { ok: true; definition: ModelDefinition } | { ok: false; error: string } {
  const result = modelDefinitionSchema.safeParse(data);
  if (result.success) {
    return { ok: true, definition: result.data };
  }
  const firstIssue = result.error.issues[0];
  const path = firstIssue.path.join('.');
  return {
    ok: false,
    error: path ? `${path}: ${firstIssue.message}` : firstIssue.message,
  };
}

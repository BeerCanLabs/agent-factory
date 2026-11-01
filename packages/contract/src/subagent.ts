/**
 * E1.1 (#292): a helper (subagent) definition. A helper is prompt-only and ephemeral: it has no memory, no persistence,
 * no tools of its own. Its approved model list (#332) is an admin grant kept on its record, not in the definition. Its only egress is
 * `github`, and that route is read-only; a definition cannot turn the read-only flag off.
 */
import { z } from 'zod';

export const SUBAGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Fields a helper may never declare, with the reason shown to the admin. */
const FORBIDDEN: Readonly<Record<string, string>> = {
  memory: 'a helper keeps nothing between runs; memory is not allowed',
  persistence: 'a helper keeps nothing between runs; persistence is not allowed',
  tools: 'a helper is prompt-only; tools are not allowed',
  skills: 'a helper is prompt-only; skills are not allowed',
  routes: 'a helper reaches only the read-only github route; routes are not allowed',
  model: 'a helper has no model of its own; the parent picks one per run from the helper\'s approved list',
  models: 'set a helper\'s approved models with PUT /api/v1/registry/subagents/<id>/models, not in its definition',
  approvedModels: 'set a helper\'s approved models with PUT /api/v1/registry/subagents/<id>/models, not in its definition',
  requestedModels: 'set a helper\'s approved models with PUT /api/v1/registry/subagents/<id>/models, not in its definition',
  secrets: 'a helper holds no secrets; it borrows the parent\'s access through the gatekeeper',
  triggers: 'a helper is started only by its parent agent',
};

export const subagentSchema = z
  .object({
    id: z.string().regex(SUBAGENT_ID, 'a helper id is a slug (lowercase letters, digits, - and _)'),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    prompt: z.string().trim().min(1, 'a helper needs a prompt'),
    egress: z
      .object({
        github: z.object({ readOnly: z.literal(true, { errorMap: () => ({ message: 'github egress for a helper is always read-only' }) }).default(true) }).strict().default({ readOnly: true }),
      })
      .strict()
      .default({ github: { readOnly: true } }),
  })
  .strict();

export type SubagentDefinition = z.infer<typeof subagentSchema>;
export type SubagentFieldError = { field: string; message: string };
export type SubagentValidation = { ok: true; value: SubagentDefinition } | { ok: false; errors: SubagentFieldError[] };

export function validateSubagent(input: unknown): SubagentValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: [{ field: '', message: 'a helper definition is an object' }] };
  const errors: SubagentFieldError[] = Object.keys(input)
    .filter((k) => Object.prototype.hasOwnProperty.call(FORBIDDEN, k))
    .map((k) => ({ field: k, message: FORBIDDEN[k] }));
  if (errors.length) return { ok: false, errors };
  const parsed = subagentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => ({
      field: i.code === 'unrecognized_keys' ? [...i.path, ...i.keys].join('.') : i.path.join('.'),
      message: i.message,
    })),
  };
}

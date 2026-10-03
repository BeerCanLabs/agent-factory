import { z } from 'zod';

/**
 * ActionHoldContract: Inter-service contract between Gatekeeper and Bouncer (E4, E9).
 * Gatekeeper intercepts held writes and forwards them to Bouncer; Bouncer releases verified requests.
 */
export const heldActionRequestSchema = z.object({
  approvalId: z.string().min(1),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  system: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  contentType: z.string().default('application/json'),
  bodySha256: z.string().min(64).max(64),
  previewKind: z.string().optional(),
});

export type HeldActionRequest = z.infer<typeof heldActionRequestSchema>;

export const heldActionReleaseSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().min(1),
  decidedAt: z.string().datetime(),
  releaseToken: z.string().min(1).optional(),
  rejectionReason: z.string().optional(),
});

export type HeldActionRelease = z.infer<typeof heldActionReleaseSchema>;

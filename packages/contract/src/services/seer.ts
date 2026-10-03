import { z } from 'zod';

/**
 * ProgressEventContract: Inter-service contract for streaming live run progress events to Seer (§6.5).
 */
export const progressEventSchema = z.object({
  agentId: z.string().min(1),
  runId: z.string().min(1),
  timestamp: z.string().datetime(),
  step: z.string().min(1),
  status: z.enum(['running', 'waiting_for_approval', 'completed', 'failed']),
  detail: z.string().optional(),
  callMeta: z.object({
    route: z.string().optional(),
    model: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    outcome: z.string().optional(),
  }).optional(),
});

export type ProgressEvent = z.infer<typeof progressEventSchema>;

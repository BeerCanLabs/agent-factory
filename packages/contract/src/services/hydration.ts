import { z } from 'zod';

/**
 * HydrationContract: Inter-service contract between Landlord and Secretary (§6.6).
 * Landlord provisions the volume and triggers hydration; Secretary manages the sync.
 */
export const hydrationRequestSchema = z.object({
  agentId: z.string().min(1),
  runId: z.string().min(1),
  memoryStoreUri: z.string().url(),
  localMemoryDir: z.string().min(1),
  mode: z.enum(['pull', 'push']),
});

export type HydrationRequest = z.infer<typeof hydrationRequestSchema>;

export const hydrationResultSchema = z.object({
  success: z.boolean(),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  bytesTransferred: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export type HydrationResult = z.infer<typeof hydrationResultSchema>;

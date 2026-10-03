import { z } from 'zod';

/**
 * KeymasterContract: Inter-service contract between Landlord and Keymaster (§6.11).
 * Landlord checks whether an agent's required credentials are satisfied before compute wakes.
 */
export const preflightCheckRequestSchema = z.object({
  agentId: z.string().min(1),
  declaredSecrets: z.array(z.string().min(1)),
  declaredConnections: z.array(
    z.object({
      provider: z.string().min(1),
      scopes: z.array(z.string()),
    })
  ).default([]),
});

export type PreflightCheckRequest = z.infer<typeof preflightCheckRequestSchema>;

export const preflightCheckResultSchema = z.object({
  satisfied: z.boolean(),
  missingSecrets: z.array(z.string()),
  missingConnections: z.array(z.string()),
  needsReconsent: z.array(z.string()),
});

export type PreflightCheckResult = z.infer<typeof preflightCheckResultSchema>;

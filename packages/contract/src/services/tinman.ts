import { z } from 'zod';

/**
 * ModelInferenceContract: Contract for calling the Factory Model Service (M1–M4).
 * Enforces uniform OpenAI Chat Completions format with run-token authentication.
 */
export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const modelInferenceRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
});

export type ModelInferenceRequest = z.infer<typeof modelInferenceRequestSchema>;

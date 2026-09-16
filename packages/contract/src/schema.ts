import { z } from 'zod';

const secretName = z
  .string()
  .min(1)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'secret names must be ENV-style (A-Z, 0-9, _)');

export const secretsManifestSchema = z
  .object({
    requires: z.array(secretName).default([]),
  })
  .strict();

const cronTrigger = z
  .object({
    type: z.literal('cron'),
    schedule: z.string().min(1),
  })
  .strict();

const webhookTrigger = z
  .object({
    type: z.literal('webhook'),
    path: z.string().startsWith('/'),
    secretRef: secretName.optional(),
  })
  .strict();

const queueTrigger = z
  .object({
    type: z.literal('queue'),
    provider: z.enum(['pubsub', 'sqs', 'local']),
    name: z.string().min(1),
  })
  .strict();

const httpTrigger = z
  .object({
    type: z.literal('http'),
    path: z.string().startsWith('/'),
  })
  .strict();

const discordTrigger = z
  .object({
    type: z.literal('discord'),
    secretRef: secretName.default('DISCORD_BOT_TOKEN'),
  })
  .strict();

export const surfaceSchema = z
  .object({
    triggers: z
      .array(z.discriminatedUnion('type', [cronTrigger, webhookTrigger, queueTrigger, httpTrigger, discordTrigger]))
      .min(1),
  })
  .strict();

export const artifactSchema = z
  .object({
    kind: z.enum(['oci', 'serverless', 'managed']),
    ref: z.string().min(1),
    localCommand: z.array(z.string()).min(1).optional(),
  })
  .strict();

const mcpEntry = z
  .object({
    id: z.string().min(1),
    description: z.string().optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const skillsSchema = z
  .object({
    skills: z.array(mcpEntry).optional(),
    mcpAllowlist: z.array(mcpEntry).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.skills?.length || v.mcpAllowlist?.length), {
    message: 'skills.yaml must list skills[] or mcpAllowlist[] (MCP peripherals only)',
  });

export const identitySchema = z
  .object({
    mode: z.enum(['daemon', 'on_behalf_of']),
    serviceAccount: z.string().optional(),
  })
  .strict();

export const memorySchema = z
  .object({
    prefix: z.string().min(1),
  })
  .strict();

export type SecretsManifest = z.infer<typeof secretsManifestSchema>;
export type Surface = z.infer<typeof surfaceSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Skills = z.infer<typeof skillsSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type Memory = z.infer<typeof memorySchema>;

export const REQUIRED_FILES = ['soul.md', 'surface.yaml', 'secrets.manifest.yaml', 'artifact.yaml'] as const;
export const OPTIONAL_FILES = ['skills.yaml', 'identity.yaml', 'memory.yaml'] as const;

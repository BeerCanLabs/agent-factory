import { z } from 'zod';

export const secretName = z
  .string()
  .min(1)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'secret names must be ENV-style (A-Z, 0-9, _)');

export const secretItem = z.union([
  secretName,
  z
    .object({
      name: secretName,
      description: z.string().optional(),
    })
    .strict(),
]);

export const secretsManifestSchema = z
  .object({
    requires: z.array(secretName).default([]),
  })
  .strict();

export const cronTrigger = z
  .object({
    type: z.literal('cron'),
    schedule: z.string().min(1),
  })
  .strict();

export const webhookTrigger = z
  .object({
    type: z.literal('webhook'),
    path: z.string().startsWith('/'),
    secretRef: secretName.optional(),
  })
  .strict();

export const queueTrigger = z
  .object({
    type: z.literal('queue'),
    provider: z.literal('sqs'),
    name: z.string().url('queue name is the SQS queue URL'),
  })
  .strict();

export const httpTrigger = z
  .object({
    type: z.literal('http'),
    path: z.string().startsWith('/'),
  })
  .strict();

export const discordTrigger = z
  .object({
    type: z.literal('discord'),
    secretRef: secretName.default('DISCORD_BOT_TOKEN'),
  })
  .strict();

export const triggerSchema = z.discriminatedUnion('type', [
  cronTrigger,
  webhookTrigger,
  queueTrigger,
  httpTrigger,
  discordTrigger,
]);

export const surfaceSchema = z
  .object({
    triggers: z.array(triggerSchema).min(1),
  })
  .strict();

export const artifactSchema = z
  .object({
    kind: z.enum(['oci', 'serverless', 'managed', 'local']),
    ref: z.string().min(1),
    localCommand: z.array(z.string()).min(1).optional(),
    cpu: z.number().positive().optional(),
    memory: z.number().positive().optional(),
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
    enabled: z.boolean().optional(),
  })
  .strict();

export const benchCase = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i, 'case ids are slugs'),
    input: z.unknown().optional(),
    expect: z
      .object({
        status: z.enum(['DONE', 'FAILED']).default('DONE'),
        equals: z.unknown().optional(),
        contains: z.array(z.string()).optional(),
        matches: z.string().optional(),
      })
      .strict()
      .default({ status: 'DONE' }),
    timeoutSeconds: z.number().positive().max(3600).default(300),
  })
  .strict();

/** The cartridge's regression suite. Deterministic checks only; the harness runs it per model. */
export const benchSchema = z
  .object({
    cases: z.array(benchCase).min(1),
  })
  .strict()
  .refine((b) => new Set(b.cases.map((c) => c.id)).size === b.cases.length, { message: 'case ids must be unique' });

/** Unified cartridge.yaml schema */
export const cartridgeSchema = z
  .object({
    schemaVersion: z.string().default('1.0'),
    id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i, 'cartridge id must be a slug').optional(),
    name: z.string().min(1).optional(),
    role: z.string().optional(),
    prompt: z.string().optional(),
    triggers: z.array(triggerSchema).min(1).optional(),
    secrets: z
      .object({
        requires: z.array(secretItem).default([]),
      })
      .strict()
      .optional(),
    persistence: memorySchema.optional(),
    memory: memorySchema.optional(),
    compute: artifactSchema.optional(),
    artifact: artifactSchema.optional(),
    skills: z.array(mcpEntry).optional(),
    mcpAllowlist: z.array(mcpEntry).optional(),
    identity: identitySchema.optional(),
    runtime: z
      .object({
        warmDownSeconds: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

export type SecretsManifest = z.infer<typeof secretsManifestSchema>;
export type Surface = z.infer<typeof surfaceSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Skills = z.infer<typeof skillsSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type Memory = z.infer<typeof memorySchema>;
export type Bench = z.infer<typeof benchSchema>;
export type BenchCase = z.infer<typeof benchCase>;
export type Cartridge = z.infer<typeof cartridgeSchema>;

export const REQUIRED_FILES = ['soul.md', 'surface.yaml', 'secrets.manifest.yaml', 'artifact.yaml'] as const;
export const OPTIONAL_FILES = ['bench.yaml', 'skills.yaml', 'identity.yaml', 'memory.yaml'] as const;


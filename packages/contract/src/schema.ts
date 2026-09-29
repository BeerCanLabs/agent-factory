import { z } from 'zod';

export const secretName = z
  .string()
  .min(1)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'secret names must be ENV-style (A-Z, 0-9, _)');

export const secretGate = z.enum(['ungated', 'gated']);
export type SecretGate = z.infer<typeof secretGate>;

/**
 * Where a static credential comes from (§6.11 K5.1): an id in the Keymaster's instruction catalog, such as `discord`,
 * `github`, `slack`, `notion`, `xai`, `anthropic`, or `home-assistant`. Optional so existing cartridges stay valid.
 */
export const credentialSource = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'secret source must be a catalog id slug (e.g. discord)');

export const secretItem = z.union([
  secretName,
  z
    .object({
      name: secretName,
      description: z.string().optional(),
      gate: secretGate.default('ungated'),
      source: credentialSource.optional(),
    })
    .strict(),
]);

/** A declared static credential (§6.11 K5.1): its secret name, and where it comes from when the cartridge says. */
export type SecretDeclaration = { name: string; source?: string; description?: string };

type SecretItemInput = string | { name: string; description?: string; gate?: SecretGate; source?: string };

/**
 * Every static secret a cartridge declares (requires, ungated, gated), once each, with its source and description.
 * Invalid entries are dropped; the first declaration of a name that carries a source or description wins.
 */
export function secretDeclarations(secrets?: { requires?: unknown; ungated?: unknown; gated?: unknown }): SecretDeclaration[] {
  const out = new Map<string, SecretDeclaration>();
  if (!secrets || typeof secrets !== 'object') return [];
  for (const list of [secrets.requires, secrets.ungated, secrets.gated]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const parsed = secretItem.safeParse(item);
      if (!parsed.success) continue;
      const d = typeof parsed.data === 'string' ? { name: parsed.data } : parsed.data;
      const prev = out.get(d.name) ?? { name: d.name };
      prev.source ??= 'source' in d ? d.source : undefined;
      prev.description ??= 'description' in d ? d.description : undefined;
      out.set(d.name, prev);
    }
  }
  return [...out.values()].map((d) => ({ name: d.name, ...(d.source ? { source: d.source } : {}), ...(d.description ? { description: d.description } : {}) }));
}

export const secretsManifestSchema = z
  .object({
    requires: z.array(secretItem).default([]),
    ungated: z.array(secretItem).optional(),
    gated: z.array(secretItem).optional(),
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

export const mcpEntry = z
  .object({
    id: z.string().min(1),
    description: z.string().optional(),
    url: z.string().url().optional(),
    gate: secretGate.default('ungated'),
  })
  .strict();

export const skillsSchema = z
  .object({
    skills: z.array(mcpEntry).optional(),
    mcpAllowlist: z.array(mcpEntry).optional(),
    ungated: z.array(mcpEntry).optional(),
    gated: z.array(mcpEntry).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.skills?.length || v.mcpAllowlist?.length || v.ungated?.length || v.gated?.length), {
    message: 'skills.yaml must list skills[], mcpAllowlist[], ungated[], or gated[] (MCP peripherals only)',
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

/**
 * A connection the agent needs (§6.11 K1): provider plus scopes. A request shown at admission; the Keymaster holds
 * the credential and the gateway injects it. `google` is a person's OAuth grant; `google-service-account` is the
 * factory's app credential.
 */
export const connectionSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'connection provider must be a slug (e.g. google)'),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** Unified cartridge.yaml schema */
export const cartridgeSchema = z
  .object({
    schemaVersion: z.string().default('1.0'),
    id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i, 'cartridge id must be a slug').optional(),
    name: z.string().min(1).optional(),
    role: z.string().optional(),
    /** `builtin` lists the agent with platform/system agents (and applies their budget and kill-switch exemptions). */
    category: z.enum(['user', 'builtin']).optional(),
    prompt: z.string().optional(),
    triggers: z.array(triggerSchema).min(1).optional(),
    secrets: z
      .object({
        requires: z.array(secretItem).default([]),
        ungated: z.array(secretItem).optional(),
        gated: z.array(secretItem).optional(),
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
        warmDownSeconds: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    egress: z
      .object({
        routes: z.array(z.string()).optional(),
        hosts: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    model: z.string().optional(),
    models: z.array(z.string()).optional(),
    requestedModels: z.array(z.string()).optional(),
    approvedModels: z.array(z.string()).optional(),
    connections: z.array(connectionSchema).optional(),
  })
  .strict();

export const egressSchema = z
  .object({
    routes: z.array(z.string()).optional(),
    hosts: z.array(z.string()).optional(),
  })
  .strict();

export type Egress = z.infer<typeof egressSchema>;
export type SecretsManifest = z.infer<typeof secretsManifestSchema>;
export type Surface = z.infer<typeof surfaceSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Skills = z.infer<typeof skillsSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type Memory = z.infer<typeof memorySchema>;
export type Bench = z.infer<typeof benchSchema>;
export type BenchCase = z.infer<typeof benchCase>;
export type Cartridge = z.infer<typeof cartridgeSchema>;
export type Connection = z.infer<typeof connectionSchema>;

/** The egress a cartridge requests, for an admin to review. Never a grant (DESIGN_AUTHORITY.md E7). */
export function deriveEgress(cartridge?: {
  triggers?: Array<{ type: string }>;
  models?: string[];
  approvedModels?: string[];
  model?: string;
  egress?: { routes?: string[]; hosts?: string[] };
}): { routes: string[]; hosts: string[] } {
  const routes = new Set<string>(cartridge?.egress?.routes ?? []);
  const hosts = new Set<string>(cartridge?.egress?.hosts ?? []);

  // 1. Triggers requiring dedicated egress routes
  if (cartridge?.triggers?.some((t) => t.type === 'discord')) {
    routes.add('discord');
  }

  return { routes: Array.from(routes), hosts: Array.from(hosts) };
}

export const REQUIRED_FILES = ['soul.md', 'surface.yaml', 'secrets.manifest.yaml', 'artifact.yaml'] as const;
export const OPTIONAL_FILES = ['bench.yaml', 'skills.yaml', 'identity.yaml', 'memory.yaml'] as const;

export type ClassifiedSecrets = {
  all: string[];
  ungated: string[];
  gated: string[];
};

export function classifySecrets(secrets?: {
  requires?: SecretItemInput[];
  ungated?: SecretItemInput[];
  gated?: SecretItemInput[];
}): ClassifiedSecrets {
  const ungatedSet = new Set<string>();
  const gatedSet = new Set<string>();

  if (!secrets) {
    return { all: [], ungated: [], gated: [] };
  }

  // 1. Explicit gated block
  if (Array.isArray(secrets.gated)) {
    for (const item of secrets.gated) {
      const name = typeof item === 'string' ? item : item?.name;
      if (name) gatedSet.add(name);
    }
  }

  // 2. Explicit ungated block
  if (Array.isArray(secrets.ungated)) {
    for (const item of secrets.ungated) {
      const name = typeof item === 'string' ? item : item?.name;
      if (name) ungatedSet.add(name);
    }
  }

  // 3. requires block (legacy / backwards compatibility)
  if (Array.isArray(secrets.requires)) {
    for (const item of secrets.requires) {
      if (typeof item === 'string') {
        if (!gatedSet.has(item)) {
          ungatedSet.add(item);
        }
      } else if (item && typeof item === 'object' && item.name) {
        if (item.gate === 'gated') {
          gatedSet.add(item.name);
        } else if (!gatedSet.has(item.name)) {
          ungatedSet.add(item.name);
        }
      }
    }
  }

  for (const g of gatedSet) {
    ungatedSet.delete(g);
  }

  const ungated = [...ungatedSet];
  const gated = [...gatedSet];
  const all = [...new Set([...ungated, ...gated])];

  return { all, ungated, gated };
}

export type McpCapability = z.infer<typeof mcpEntry>;

export type ClassifiedCapabilities = {
  all: McpCapability[];
  ungated: McpCapability[];
  gated: McpCapability[];
};

export function classifyCapabilities(source?: {
  skills?: McpCapability[];
  mcpAllowlist?: McpCapability[];
  ungated?: McpCapability[];
  gated?: McpCapability[];
}): ClassifiedCapabilities {
  const ungatedMap = new Map<string, McpCapability>();
  const gatedMap = new Map<string, McpCapability>();

  if (!source) return { all: [], ungated: [], gated: [] };

  if (Array.isArray(source.gated)) {
    for (const item of source.gated) {
      if (item?.id) gatedMap.set(item.id, { ...item, gate: 'gated' });
    }
  }

  if (Array.isArray(source.ungated)) {
    for (const item of source.ungated) {
      if (item?.id) ungatedMap.set(item.id, { ...item, gate: 'ungated' });
    }
  }

  const legacy = [...(source.skills ?? []), ...(source.mcpAllowlist ?? [])];
  for (const item of legacy) {
    if (!item?.id) continue;
    if (item.gate === 'gated') {
      gatedMap.set(item.id, item);
    } else if (!gatedMap.has(item.id)) {
      ungatedMap.set(item.id, item);
    }
  }

  for (const id of gatedMap.keys()) {
    ungatedMap.delete(id);
  }

  const ungated = [...ungatedMap.values()];
  const gated = [...gatedMap.values()];
  const allMap = new Map<string, McpCapability>();
  for (const c of [...ungated, ...gated]) allMap.set(c.id, c);

  return { all: [...allMap.values()], ungated, gated };
}


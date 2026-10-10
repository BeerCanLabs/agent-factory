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

/** A gatekeeper-egress route id: a plain name, never a host, URL or port. */
export const ROUTE_ID = /^[a-z0-9][a-z0-9_-]*$/;

export const skillEntry = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    url: z.string().url().optional(),
    gate: secretGate.default('ungated'),
    system: z.string().optional(),
    secretRef: z.string().min(1).optional(),
    hold: z.union([z.enum(['none', 'required']), z.string()]).default('none'),
    injection: z.string().optional(),
    /**
     * E12: the gatekeeper-egress routes this skill goes through, by id. A role allows or denies a skill, and the egress
     * sees routes, so this is how one becomes the other. A registered skill's routes are `requires.routes` (SK2).
     */
    routes: z.array(z.string().regex(ROUTE_ID, 'a skill route is a gatekeeper-egress route id (lowercase letters, digits, - and _), never a host')).optional(),
  })
  .strict();

export const mcpEntry = skillEntry;

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

export const memoryArchetype = z.enum(['ephemeral', 'episodic', 'workspace']);

export const memorySchema = z
  .object({
    prefix: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    archetype: memoryArchetype.optional(),
    retentionDays: z.number().int().positive().optional(),
    maxMessages: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
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
 * the credential and the gatekeeper-egress injects it. `google` is a person's OAuth grant; `google-service-account` is the
 * factory's app credential.
 */
export const connectionSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'connection provider must be a slug (e.g. google)'),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** A role's name: letters, digits, `-` and `_`. The same rule the identity links apply to a role they assign. */
export const ROLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What a role may do with one skill (E12): the actions it allows and the ones it denies, `"*"` meaning every action.
 * A rule must say something: an empty rule would read as "nothing" or as "everything" depending on who reads it.
 */
export const roleSkillRuleSchema = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((r) => (r.allow?.length ?? 0) + (r.deny?.length ?? 0) > 0, {
    message: 'a rule must list at least one action to allow or deny ("*" is every action)',
  });

/** A role the cartridge declares (E12): which skills it may use. The key `"*"` stands for every skill. */
export const roleSchema = z
  .object({
    description: z.string().optional(),
    skills: z.record(z.string().min(1), roleSkillRuleSchema).default({}),
  })
  .strict();

export type CartridgeRole = z.infer<typeof roleSchema>;

export type RoleIssue = { path: Array<string | number>; message: string };

/**
 * E12: what is wrong with the roles a cartridge declares, apart from their shape: a role that names a skill the
 * cartridge does not declare (it could never be applied, and a typo would silently allow nothing), or two roles whose
 * names differ only in case (`Owner` and `owner`: one role under two names). Pure, so validation and registration agree.
 */
export function cartridgeRoleIssues(cartridge: { roles?: unknown; skills?: unknown }): RoleIssue[] {
  const roles = cartridge.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return [];
  const declared = new Set(
    (Array.isArray(cartridge.skills) ? cartridge.skills : []).map((s) => (s && typeof s === 'object' ? (s as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === 'string'),
  );
  const issues: RoleIssue[] = [];
  const seen = new Map<string, string>();
  for (const [name, role] of Object.entries(roles as Record<string, unknown>)) {
    const earlier = seen.get(name.toLowerCase());
    if (earlier !== undefined) issues.push({ path: ['roles', name], message: `role "${name}" is the same role as "${earlier}": role names differ by more than case` });
    else seen.set(name.toLowerCase(), name);
    const skills = role && typeof role === 'object' ? (role as { skills?: unknown }).skills : undefined;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) continue;
    for (const skillId of Object.keys(skills as Record<string, unknown>)) {
      if (skillId !== '*' && !declared.has(skillId)) {
        issues.push({ path: ['roles', name, 'skills', skillId], message: `role "${name}" names skill "${skillId}", which the cartridge does not declare in skills[]` });
      }
    }
  }
  return issues;
}

/**
 * Every problem with the roles and skill routes a cartridge body declares, as readable reasons (E12). Registration reads
 * a cartridge body without running the whole schema, so it asks this; validation asks the schema, which asks the same
 * rules. Empty when the cartridge declares none.
 */
export function cartridgeRoleProblems(cartridge: { roles?: unknown; skills?: unknown }): string[] {
  const reasons: string[] = [];
  if (cartridge.roles !== undefined && cartridge.roles !== null) {
    const shape = z.record(z.string().regex(ROLE_NAME, 'a role name is letters, digits, - and _ (at most 64)'), roleSchema).safeParse(cartridge.roles);
    if (!shape.success) for (const i of shape.error.issues) reasons.push(`roles${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`);
  }
  if (Array.isArray(cartridge.skills)) {
    cartridge.skills.forEach((s, n) => {
      const routes = s && typeof s === 'object' ? (s as { routes?: unknown }).routes : undefined;
      if (routes === undefined) return;
      const id = typeof (s as { id?: unknown }).id === 'string' ? (s as { id: string }).id : String(n);
      if (!Array.isArray(routes) || routes.some((r) => typeof r !== 'string' || !ROUTE_ID.test(r))) {
        reasons.push(`skills.${id}.routes: a skill route is a gatekeeper-egress route id (lowercase letters, digits, - and _), never a host`);
      }
    });
  }
  for (const i of cartridgeRoleIssues(cartridge)) reasons.push(`${i.path.join('.')}: ${i.message}`);
  return reasons;
}

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
    /** E12: the roles a person may hold on this agent, and what each may use. `Owner` is declared here but never assigned. */
    roles: z.record(z.string().regex(ROLE_NAME, 'a role name is letters, digits, - and _ (at most 64)'), roleSchema).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const issue of cartridgeRoleIssues(c)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  });

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

export type SkillEntry = z.infer<typeof skillEntry>;
export type McpCapability = SkillEntry;

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


import { z } from 'zod';
import { connectionSchema, credentialSource, secretName } from './schema.js';

/**
 * `skill.yaml`: what a skill is and what it needs (DESIGN_AUTHORITY.md §6.14 SK1, SK2).
 *
 * A skill's requirements are a request, never a grant: what a skill can do inside an agent is bounded by that agent's
 * policy (E7, E8). A skill holds no secret (S1): it names the credentials it needs, the Keymaster holds them and the
 * gatekeeper-egress injects them. Unknown keys are refused, so a value can never ride along in the manifest.
 *
 * A skill is public (any agent may be given it) or private (it names one owner agent and only that agent may adopt it,
 * SK1, SK3). It declares its actions (SK2): each names the route, method and path it takes and says `hold: true`
 * (human-in-the-loop, E9) or `hold: false` (autonomous). A declared `hold` is recorded and shown to the approver but is
 * enforced only once grants carry actions (GAP-070).
 */

/** Semantic Versioning 2.0.0 (https://semver.org), without a leading `v`. */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Skill ids are kebab-case: lowercase letters and digits, words joined by single hyphens. */
export const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const skillCredentialSchema = z
  .object({
    name: secretName,
    source: credentialSource.optional(),
    description: z.string().optional(),
  })
  .strict();

export const skillRequiresSchema = z
  .object({
    routes: z.array(z.string().min(1)).default([]),
    connections: z.array(connectionSchema).default([]),
    credentials: z.array(skillCredentialSchema).default([]),
    models: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const SKILL_VISIBILITIES = ['public', 'private'] as const;
export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number];

/** An agent id, as a skill's `owner` names it: lowercase letters, digits, `-` and `_`. */
export const SKILL_OWNER = /^[a-z0-9][a-z0-9_-]*$/;

export const SKILL_ACTION_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * One thing a skill does at a system (E11): the route it goes through, the method and the path. `hold` has no default
 * (E9: there is no factory default): the author says true (a person approves the exact request first) or false.
 */
export const skillActionSchema = z
  .object({
    id: z.string().max(64).regex(SKILL_ID, 'action id must be kebab-case (e.g. post-message)'),
    route: z.string().min(1),
    method: z.enum(SKILL_ACTION_METHODS),
    path: z.string().max(512).regex(/^\/(?!\/)[^\s?#]*$/, 'action path must start with a single "/" and hold no query, fragment or spaces'),
    hold: z.boolean({
      required_error: 'action must declare hold: true (a person approves it first) or hold: false (autonomous); there is no default (E9)',
      invalid_type_error: 'hold must be true or false',
    }),
  })
  .strict();

export const skillManifestSchema = z
  .object({
    id: z.string().max(64).regex(SKILL_ID, 'skill id must be kebab-case (e.g. discord-progress)'),
    version: z.string().max(64).regex(SEMVER, 'version must be a semantic version (e.g. 1.2.0)'),
    name: z.string().min(1),
    description: z.string().min(1),
    language: z.string().regex(/^[a-z][a-z0-9-]*$/, 'language must be a lowercase name (e.g. python, node)'),
    entry: z
      .string()
      .min(1)
      .refine((e) => !e.startsWith('/') && !e.split(/[\\/]/).includes('..'), 'entry must be a module or a path inside the skill'),
    visibility: z.enum(SKILL_VISIBILITIES).default('public'),
    owner: z.string().max(64).regex(SKILL_OWNER, 'owner must be an agent id (lowercase letters, digits, - and _)').optional(),
    requires: skillRequiresSchema.default({}),
    actions: z.array(skillActionSchema).default([]),
  })
  .strict();

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillAction = z.infer<typeof skillActionSchema>;
export type SkillRequires = z.infer<typeof skillRequiresSchema>;
export type SkillCredential = z.infer<typeof skillCredentialSchema>;

export type SkillIssue = { path: string; message: string };
export type SkillValidation = { ok: true; manifest: SkillManifest } | { ok: false; issues: SkillIssue[] };

/** Validates a parsed `skill.yaml` against the schema, filling defaults (public, and an absent `requires` or `actions` list is empty). */
export function validateSkillManifest(raw: unknown): SkillValidation {
  const parsed = skillManifestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({ path: i.path.length ? i.path.join('.') : '(root)', message: i.message })),
  };
}

/** A gatekeeper-egress route id or a factory model name: a plain name, never a host, URL, port or provider path. */
const PLAIN_ROUTE = /^[a-z0-9][a-z0-9_-]*$/;
const PLAIN_MODEL = /^[a-z0-9][a-z0-9._-]*$/;
const LOOKS_LIKE_HOST = /(^[a-z]+:\/\/)|[/:@]|(^\d+\.\d+\.\d+\.\d+$)|(\.[a-z]{2,}$)/i;

export type SkillDesignOptions = {
  /** Provider keys only the gatekeeper-egress holds (FACTORY_GATEKEEPER_EGRESS_HELD_SECRETS); never declared by a skill. */
  gatekeeperEgressHeld?: Iterable<string>;
};

/**
 * The design rules a skill's manifest must meet at admission (SK1, SK2, E1, E5, S1). Returns refusal reasons; empty
 * means the manifest passes. Code-level checks (tests, build, provider SDKs) belong to the build step (TSK-054).
 *
 * - Routes are gatekeeper-egress route ids. A skill never declares a raw host: no host-level egress (E1).
 * - Models are factory model names, metered through a provider route (E5, M1), never a provider-qualified id or URL.
 * - A credential the gatekeeper-egress already holds for the platform (a model provider key) needs no declaration
 *   and is refused: declaring it would ask for a platform key to be put in reach of the skill (S1, E5).
 * - A private skill names its owner agent and a public skill names none (SK1).
 * - An action goes through a route the skill declares, has a unique id, and a path that is a path, never a URL (E1, E11).
 * - Names are declared once each.
 */
export function skillDesignIssues(manifest: SkillManifest, opts: SkillDesignOptions = {}): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const held = new Set(opts.gatekeeperEgressHeld ?? []);
  const dupes = (list: string[], path: string) => {
    const seen = new Set<string>();
    for (const v of list) {
      if (seen.has(v)) issues.push({ path, message: `"${v}" is declared more than once` });
      seen.add(v);
    }
  };

  manifest.requires.routes.forEach((r, i) => {
    if (LOOKS_LIKE_HOST.test(r) || r.includes('.')) {
      issues.push({ path: `requires.routes.${i}`, message: `"${r}" is a host, not a route: skills declare gatekeeper-egress routes only, never raw hosts (E1, SK2)` });
    } else if (!PLAIN_ROUTE.test(r)) {
      issues.push({ path: `requires.routes.${i}`, message: `"${r}" is not a plain route id (lowercase letters, digits, - and _)` });
    }
  });
  dupes(manifest.requires.routes, 'requires.routes');

  manifest.requires.models.forEach((m, i) => {
    if (!PLAIN_MODEL.test(m) || LOOKS_LIKE_HOST.test(m)) {
      issues.push({ path: `requires.models.${i}`, message: `"${m}" is not a plain model name: skills name factory models, never a provider id, host or URL (E5, M1)` });
    }
  });
  dupes(manifest.requires.models, 'requires.models');

  manifest.requires.credentials.forEach((c, i) => {
    if (held.has(c.name)) {
      issues.push({ path: `requires.credentials.${i}`, message: `${c.name} is a platform key the gatekeeper-egress holds; it needs no declaration (declare the route or model instead, S1, E5)` });
    }
  });
  dupes(manifest.requires.credentials.map((c) => c.name), 'requires.credentials');
  dupes(manifest.requires.connections.map((c) => c.provider), 'requires.connections');

  if (manifest.visibility === 'private' && !manifest.owner) {
    issues.push({ path: 'owner', message: 'a private skill must name its owner agent (SK1)' });
  }
  if (manifest.visibility === 'public' && manifest.owner) {
    issues.push({ path: 'owner', message: `a public skill has no owner; "${manifest.owner}" is named, so declare visibility: private or drop owner (SK1)` });
  }

  const routes = new Set(manifest.requires.routes);
  manifest.actions.forEach((a, i) => {
    if (!routes.has(a.route)) {
      issues.push({ path: `actions.${i}.route`, message: `action "${a.id}" uses route "${a.route}", which the skill does not declare in requires.routes (E8, E11)` });
    }
    if (a.path.includes('://')) {
      issues.push({ path: `actions.${i}.path`, message: `action "${a.id}" path is a URL, not a path: actions go through a route, never a host (E1, E11)` });
    }
  });
  dupes(manifest.actions.map((a) => a.id), 'actions');

  return issues;
}

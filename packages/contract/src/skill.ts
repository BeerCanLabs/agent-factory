import { z } from 'zod';
import { connectionSchema, credentialSource, secretName } from './schema.js';

/**
 * `skill.yaml`: what a skill is and what it needs (DESIGN_AUTHORITY.md §6.14 SK1, SK2).
 *
 * A skill's requirements are a request, never a grant: what a skill can do inside an agent is bounded by that agent's
 * policy (E7, E8). A skill holds no secret (S1): it names the credentials it needs, the Keymaster holds them and the
 * gatekeeper-egress injects them. Unknown keys are refused, so a value can never ride along in the manifest.
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
    requires: skillRequiresSchema.default({}),
  })
  .strict();

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillRequires = z.infer<typeof skillRequiresSchema>;
export type SkillCredential = z.infer<typeof skillCredentialSchema>;

export type SkillIssue = { path: string; message: string };
export type SkillValidation = { ok: true; manifest: SkillManifest } | { ok: false; issues: SkillIssue[] };

/** Validates a parsed `skill.yaml` against the schema, filling defaults (an absent `requires` list is empty). */
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

  return issues;
}

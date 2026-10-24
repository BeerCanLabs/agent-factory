/**
 * An agent's whole configuration as one bundle (DESIGN_AUTHORITY.md §6.18 CF3): what moves when an owner exports an agent
 * and an admin imports it elsewhere. The bundle holds the agent's identity (id, name, role, model), its soul, roles and
 * memory settings, its adopted skills with their pinned versions, and its policy as a request. It holds no owner, no
 * person, no secret and no memory: owners and links are the target factory's, and the factory never opens a notebook (AM5).
 *
 * `parseBundle` is strict (a bundle is input from outside) and never grants: a policy in a bundle is a request an admin
 * sets by hand, and a skill in a bundle is a request to adopt that an admin decides (SK3).
 */
import { applySettingsChange, type AgentSettings } from './agent-settings.js';
import type { ConfigContent, ConfigSkill } from './config-store.js';

export const BUNDLE_FORMAT = 'agent-factory.bundle/1';
export const MAX_BUNDLE_SKILLS = 50;
const MAX_POLICY_JSON = 32_768;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKILL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export type AgentBundle = {
  format: typeof BUNDLE_FORMAT;
  exportedAt: string;
  agent: { id: string; name: string; role: string; model?: string };
  /** Where the agent's soul and roles live: `configuration` (importable) or `repository` (a read-only record, CF6). */
  origin: 'configuration' | 'repository';
  /** For an agent from a repository, its pinned source, so the record says what it ran. Not importable. */
  source?: { repo?: string; commit?: string };
  settings?: AgentSettings;
  skills: ConfigSkill[];
  /** The admin-set policy as a request: an import never applies it. */
  policy: Record<string, unknown> | null;
};

export function buildBundle(
  agent: { id: string; name: string; role: string; model?: string; createdFrom?: 'configuration' },
  content: Pick<ConfigContent, 'source' | 'skills' | 'policy' | 'agent'>,
  now: Date = new Date(),
): AgentBundle {
  const configured = agent.createdFrom === 'configuration' && content.agent !== undefined;
  return {
    format: BUNDLE_FORMAT,
    exportedAt: now.toISOString(),
    agent: { id: agent.id, name: agent.name, role: agent.role, ...(agent.model ? { model: agent.model } : {}) },
    origin: configured ? 'configuration' : 'repository',
    ...(configured ? {} : { source: { ...(content.source.repo ? { repo: content.source.repo } : {}), ...(content.source.commit ? { commit: content.source.commit } : {}) } }),
    ...(content.agent ? { settings: structuredClone(content.agent) } : {}),
    skills: content.skills.map((s) => ({ id: s.id, version: s.version })),
    policy: content.policy ? structuredClone(content.policy) : null,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export type BundleResult = { ok: true; bundle: AgentBundle } | { ok: false; error: string; message: string };

const bad = (error: string, message: string): BundleResult => ({ ok: false, error, message });

export function parseBundle(input: unknown): BundleResult {
  if (!isObject(input) || input.format !== BUNDLE_FORMAT) return bad('invalid_bundle', `a bundle has format "${BUNDLE_FORMAT}"`);
  const a = input.agent;
  if (!isObject(a) || typeof a.id !== 'string' || !AGENT_ID.test(a.id) || a.id.startsWith('__')) return bad('invalid_bundle', 'agent.id is missing or not a valid id');
  const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
  const name = text(a.name, 120);
  const role = text(a.role, 120);
  if (!name || !role) return bad('invalid_bundle', 'agent.name and agent.role are required text of at most 120 characters');
  if (a.model !== undefined && !text(a.model, 200)) return bad('invalid_bundle', 'agent.model must be text of at most 200 characters');
  if (input.origin !== 'configuration' && input.origin !== 'repository') return bad('invalid_bundle', 'origin must be "configuration" or "repository"');
  if (!Array.isArray(input.skills) || input.skills.length > MAX_BUNDLE_SKILLS) return bad('invalid_bundle', `skills must be a list of at most ${MAX_BUNDLE_SKILLS}`);
  const skills: ConfigSkill[] = [];
  for (const s of input.skills) {
    if (!isObject(s) || typeof s.id !== 'string' || !SKILL_ID.test(s.id) || typeof s.version !== 'string' || !SEMVER.test(s.version)) return bad('invalid_bundle', 'each skill needs a kebab-case id and a semantic version');
    if (skills.some((k) => k.id === s.id)) return bad('invalid_bundle', `skill ${s.id} is listed twice`);
    skills.push({ id: s.id, version: s.version });
  }
  let policy: Record<string, unknown> | null = null;
  if (input.policy !== null && input.policy !== undefined) {
    if (!isObject(input.policy) || JSON.stringify(input.policy).length > MAX_POLICY_JSON) return bad('invalid_bundle', 'policy must be an object of at most 32 KiB, or null');
    policy = structuredClone(input.policy);
  }
  let settings: AgentSettings | undefined;
  if (input.settings !== undefined) {
    const parsed = applySettingsChange(undefined, input.settings);
    if (!parsed.ok) return bad('invalid_bundle', `settings: ${parsed.error}`);
    settings = parsed.settings;
  }
  // `source` is informational (a repository agent's pin); it is read as text only.
  const source = isObject(input.source) ? { ...(typeof input.source.repo === 'string' ? { repo: input.source.repo.slice(0, 300) } : {}), ...(typeof input.source.commit === 'string' ? { commit: input.source.commit.slice(0, 64) } : {}) } : undefined;
  const exportedAt = typeof input.exportedAt === 'string' ? input.exportedAt.slice(0, 40) : '';
  return {
    ok: true,
    bundle: {
      format: BUNDLE_FORMAT,
      exportedAt,
      agent: { id: a.id, name, role, ...(a.model ? { model: String(a.model).trim() } : {}) },
      origin: input.origin,
      ...(source ? { source } : {}),
      ...(settings ? { settings } : {}),
      skills,
      policy,
    },
  };
}

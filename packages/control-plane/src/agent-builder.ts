/**
 * Headless agent-builder house staff endpoints (DESIGN_AUTHORITY.md §6.8 L2, §6.17 CL2, §6.18 CF6, §6.3.1 E7; decision 4).
 *
 *   POST /api/v1/runs/:id/builder
 *
 * Exposes catalog inspection, candidate configuration validation, and publishing to the
 * agent-builder house staff agent. Restricted strictly to run tokens of `agent-builder`.
 * Requires a verified human caller holding `agents.create` (operators and admins, decision 7).
 */
import http from 'node:http';
import {
  AGENT_ID,
  BUILTIN_AGENT_IDS,
  canAdopt,
  summarizeSkill,
  applySettingsChange,
} from '@beercanlabs/factory-registrar';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { authorize } from '@beercanlabs/factory-bouncer';
import type { Role, Principal } from '@beercanlabs/factory-auth';
import type { Run } from '@beercanlabs/factory-property-manager';
import { json, readJson, type FactoryState } from './app.js';
import { createFromConfiguration, discardCreated } from './agent-creation.js';
import { skillRegistry, adoptionStore, requestAdoptionFor } from './skills.js';

export const ARCHETYPES = ['purpose-built', 'personal-assistant', 'team-member'] as const;

function adminEmailsFromEnv(): string[] {
  return (process.env.FACTORY_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function tokenRolesFromEnv(tokenName: string): Role[] | undefined {
  if (tokenName === 'admin') return ['admin'];
  if (tokenName === 'operator') return ['operator'];
  const raw = process.env.FACTORY_TOKENS;
  if (!raw) return undefined;
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      const match = list.find((t: any) => t && typeof t.name === 'string' && t.name.toLowerCase() === tokenName.toLowerCase());
      if (match && Array.isArray(match.roles)) {
        return match.roles;
      }
    }
  } catch {}
  return undefined;
}

function enrichRoles(state: FactoryState, actor: string, roles: Set<Role>): void {
  const lower = actor.toLowerCase();
  if (lower.startsWith('cloudflare:')) {
    const email = lower.slice('cloudflare:'.length).trim();
    if (adminEmailsFromEnv().includes(email)) {
      roles.add('admin');
    }
  }
  if (lower.startsWith('token:')) {
    const tokenName = lower.slice('token:'.length).trim();
    const tr = tokenRolesFromEnv(tokenName);
    if (tr) {
      for (const r of tr) roles.add(r);
    }
  }
  const link = state.identityLinks?.list().find((l) => l.actor.toLowerCase() === lower);
  if (link) {
    for (const r of link.roles ?? []) roles.add(r);
    const email = lower.startsWith('cloudflare:') ? lower.slice('cloudflare:'.length).trim() : '';
    if (email && adminEmailsFromEnv().includes(email)) {
      roles.add('admin');
    }
  }
}

/**
 * Resolves the authenticated human caller behind a builder run.
 * Refuses system actors, cron, smoke, and webhooks.
 */
export function resolveHumanCaller(state: FactoryState, run: Run): Principal | undefined {
  if (run.trigger === 'cron' || run.trigger === 'smoke' || run.trigger === 'webhook') {
    return undefined;
  }
  if (run.actor && (run.actor === 'SYSTEM' || run.actor.startsWith('factory:') || run.actor.startsWith('SYSTEM'))) {
    return undefined;
  }

  // 1. Ingress-attested caller metadata
  if (run.caller && run.caller.actor) {
    if (run.caller.actor === 'SYSTEM' || run.caller.actor.startsWith('factory:') || run.caller.actor.startsWith('SYSTEM')) {
      return undefined;
    }
    const roles = new Set<Role>(run.caller.roles ?? []);
    enrichRoles(state, run.caller.actor, roles);
    return { actor: run.caller.actor, roles: Array.from(roles) };
  }

  // 2. Identity-linked requestedBy
  if (run.requestedBy) {
    const link = state.identityLinks?.resolveLink(run.requestedBy.provider, run.requestedBy.id);
    if (link) {
      const roles = new Set<Role>(link.roles ?? []);
      enrichRoles(state, link.actor, roles);
      return { actor: link.actor, roles: Array.from(roles) };
    }
  }

  // 3. Authenticated actor on run
  if (run.actor && run.actor !== 'unattributed' && !run.actor.startsWith('factory:') && !run.actor.startsWith('SYSTEM')) {
    const roles = new Set<Role>();
    enrichRoles(state, run.actor, roles);
    return { actor: run.actor, roles: Array.from(roles) };
  }

  return undefined;
}

export type BuilderValidationResult =
  | { ok: true; valid: true; adoptableSkillIds: Set<string>; skillsToAdopt: Array<{ id: string; version: string }> }
  | { ok: false; status: number; error: string; message: string; role?: string; skill?: string };

export function validateBuilderSpec(state: FactoryState, spec: unknown): BuilderValidationResult {
  if (!spec || typeof spec !== 'object') {
    return { ok: false, status: 400, error: 'invalid_spec', message: 'spec must be an object' };
  }
  const s = spec as Record<string, unknown>;
  const id = typeof s.id === 'string' ? s.id.trim() : '';
  if (!id || !AGENT_ID.test(id) || id.startsWith('__')) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_id',
      message: 'id must be 1 to 128 letters, digits, dot, dash or underscore, starting with a letter or digit',
    };
  }
  if (state.agents.has(id) || BUILTIN_AGENT_IDS.has(id) || state.repositoryAgentIds?.has(id)) {
    return { ok: false, status: 409, error: 'agent_exists', message: `${id} already exists (or is reserved)` };
  }
  if (state.configs?.current(id)) {
    return { ok: false, status: 409, error: 'configuration_exists', message: `a configuration for ${id} is still stored` };
  }

  if (!s.memory || typeof s.memory !== 'object' || !(s.memory as Record<string, unknown>).archetype) {
    return {
      ok: false,
      status: 422,
      error: 'archetype_required',
      message: 'memory.archetype is required: purpose-built, personal-assistant or team-member (AM1)',
    };
  }

  const given: Record<string, unknown> = { soul: s.soul, roles: s.roles, memory: s.memory };
  const settings = applySettingsChange(undefined, Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)));
  if (!settings.ok) {
    return { ok: false, status: 400, error: 'invalid_settings', message: settings.error };
  }
  const archetype = settings.settings.memory?.archetype;
  if (!archetype) {
    return {
      ok: false,
      status: 422,
      error: 'archetype_required',
      message: 'memory.archetype is required: purpose-built, personal-assistant or team-member (AM1)',
    };
  }
  if (!ARCHETYPES.includes(archetype as (typeof ARCHETYPES)[number])) {
    return {
      ok: false,
      status: 422,
      error: 'invalid_archetype',
      message: `archetype must be one of: ${ARCHETYPES.join(', ')}`,
    };
  }

  const reg = skillRegistry(state);
  const requestedSkills: Array<{ id: string; version?: string }> = Array.isArray(s.skills) ? s.skills : [];
  const adoptableSkillIds = new Set<string>();
  const skillsToAdopt: Array<{ id: string; version: string }> = [];

  for (const item of requestedSkills) {
    if (!item || typeof item.id !== 'string') {
      return { ok: false, status: 400, error: 'invalid_skill', message: 'each skill must have an id' };
    }
    const skillId = item.id.trim();
    const summary = summarizeSkill(reg, skillId);
    if (!summary) {
      return { ok: false, status: 422, error: 'unknown_skill', skill: skillId, message: `skill "${skillId}" is not registered` };
    }
    const version = typeof item.version === 'string' && item.version.trim() ? item.version.trim() : summary.latestApproved;
    if (!version) {
      return { ok: false, status: 422, error: 'unknown_skill', skill: skillId, message: `skill "${skillId}" has no approved version` };
    }
    const check = canAdopt(reg, id, skillId, version);
    if (!check.ok) {
      const errCode = check.error === 'not_found' ? 'unknown_skill' : (check.error ?? 'cannot_adopt');
      return { ok: false, status: 422, error: errCode, skill: skillId, message: check.message };
    }
    adoptableSkillIds.add(skillId);
    skillsToAdopt.push({ id: skillId, version });
  }

  for (const r of settings.settings.roles ?? []) {
    for (const skill of Object.keys(r.skills)) {
      if (skill !== '*' && !adoptableSkillIds.has(skill)) {
        return {
          ok: false,
          status: 422,
          error: 'unknown_skill',
          role: r.name,
          skill,
          message: `role "${r.name}" names skill "${skill}", which is not among the adoptable skills`,
        };
      }
    }
  }

  return { ok: true, valid: true, adoptableSkillIds, skillsToAdopt };
}

export async function handleAgentBuilder(
  state: FactoryState,
  run: Run,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (run.agentId !== 'agent-builder') {
    json(res, 403, { error: 'forbidden', message: 'route is restricted to agent-builder' });
    return;
  }

  const humanCaller = resolveHumanCaller(state, run);
  if (!humanCaller) {
    json(res, 403, { error: 'builder_caller_required', message: 'agent-builder requires a verified human caller holding agents.create' });
    return;
  }

  const auth = authorize({ principal: humanCaller, privilege: 'agents.create' });
  if (!auth.allowed) {
    json(res, 403, { error: 'forbidden', reason: 'agents.create required' });
    return;
  }

  const body = (await readJson(req)) as Record<string, unknown>;
  const op = typeof body?.op === 'string' ? body.op.trim() : '';

  if (op === 'catalog') {
    const reg = skillRegistry(state);
    const skills = reg
      .ids()
      .map((id) => {
        const summary = summarizeSkill(reg, id);
        return summary && !summary.retired && summary.latestApproved
          ? {
              id: summary.id,
              name: summary.name,
              description: summary.description,
              version: summary.latestApproved,
              requires: summary.requires,
            }
          : null;
      })
      .filter(Boolean);

    const models = state.modelStore
      ? state.modelStore.listOffered().map((m) => m.name)
      : Object.keys(state.modelCatalog ?? {});

    const defaultModel = state.modelStore?.getDefault() ?? state.defaultModel ?? 'gemini-2.0-flash';

    json(res, 200, {
      ok: true,
      archetypes: [...ARCHETYPES],
      skills,
      models: models.length ? models : [defaultModel],
      defaultModel,
    });
    return;
  }

  if (op === 'validate') {
    const validation = validateBuilderSpec(state, body?.spec);
    if (!validation.ok) {
      json(res, validation.status, {
        ok: false,
        error: validation.error,
        message: validation.message,
        ...(validation.role ? { role: validation.role } : {}),
        ...(validation.skill ? { skill: validation.skill } : {}),
      });
      return;
    }
    json(res, 200, { ok: true, valid: true });
    return;
  }

  if (op === 'publish') {
    const validation = validateBuilderSpec(state, body?.spec);
    if (!validation.ok) {
      json(res, validation.status, {
        ok: false,
        error: validation.error,
        message: validation.message,
        ...(validation.role ? { role: validation.role } : {}),
        ...(validation.skill ? { skill: validation.skill } : {}),
      });
      return;
    }

    const s = body.spec as Record<string, unknown>;
    const id = (s.id as string).trim();
    const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : id;
    const role = typeof s.role === 'string' && s.role.trim() ? s.role.trim() : 'Agent';
    const model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : undefined;

    const created = await createFromConfiguration(state, humanCaller, {
      id,
      name,
      role,
      model,
      soul: s.soul,
      roles: s.roles,
      memory: s.memory,
      rolesMayNameSkills: validation.adoptableSkillIds,
      reason: 'created by agent-builder',
    });

    if (created.status !== 201) {
      json(res, created.status, created.body);
      return;
    }

    const requestedSkills: Array<{ id: string; version: string; state: string }> = [];
    try {
      for (const skill of validation.skillsToAdopt) {
        const asked = await requestAdoptionFor(
          state,
          id,
          skill.id,
          skill.version,
          humanCaller.actor,
          'requested by agent-builder',
        );
        if (asked.status !== 201) {
          throw new Error(`adoption request for skill "${skill.id}" failed: ${String(asked.body?.error ?? asked.status)}`);
        }
        requestedSkills.push({ id: skill.id, version: skill.version, state: 'requested' });
      }

      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: id,
        type: 'action',
        action: 'AGENT_BUILT_BY_BUILDER',
        actor: humanCaller.actor,
        requestId: run.runId,
        payloadSha256: payloadHash({ id, runId: run.runId, builderActor: humanCaller.actor }),
      });

      json(res, 201, {
        ok: true,
        agent: created.body,
        skills: requestedSkills,
      });
      return;
    } catch (err: any) {
      await discardCreated(state, id, humanCaller.actor, 'builder adoption request failed');
      for (const skill of validation.skillsToAdopt) {
        try {
          adoptionStore(state).clear(id, skill.id);
        } catch {}
      }
      json(res, 422, {
        error: 'adoption_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  json(res, 400, {
    error: 'invalid_op',
    message: `op must be catalog, validate, or publish; received "${op}"`,
  });
}

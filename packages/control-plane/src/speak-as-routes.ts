import http from 'node:http';
import {
  SpeakAsStoreError,
  type SpeakAsGrant,
  type SpeakAsGrantStore,
} from '@beercanlabs/factory-bouncer';
import { json, readJson, requirePrivilege, type FactoryState } from './app.js';

const ONE = /^\/api\/v1\/speak-as-grants\/([^/]+)$/;
const MEMBERS = /^\/api\/v1\/speak-as-grants\/([^/]+)\/members$/;
const MEMBER = /^\/api\/v1\/speak-as-grants\/([^/]+)\/members\/([^/]+)$/;

async function requireAdmin(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse) {
  const principal = await requirePrivilege(req, res, state, 'grants.manage');
  if (!principal) return undefined;
  if (!state.speakAs || !state.speakAs.healthy) {
    json(res, 503, { error: 'speak_as_store_unavailable' });
    return undefined;
  }
  return { principal, store: state.speakAs };
}

function storeError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof SpeakAsStoreError) {
    json(res, err.status, { error: err.code, message: err.message });
    return;
  }
  throw err;
}

function ledger(state: FactoryState, action: string, actor: string, grant: SpeakAsGrant, extra?: Record<string, unknown>): void {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: 'control-plane',
    type: 'action',
    action,
    actor,
    subject: grant.client,
    grantId: grant.id,
    ...(extra ?? {}),
  });
}

function publicGrant(g: SpeakAsGrant): SpeakAsGrant {
  return structuredClone(g);
}

function agentDescription(state: FactoryState, id: string): { id: string; name: string; description: string } | undefined {
  const a = state.agents.get(id);
  if (!a) return undefined;
  const name = a.name || id;
  const description = (typeof a.role === 'string' && a.role.trim() ? a.role.trim() : name);
  return { id: a.id, name, description };
}

export async function handleSpeakAsRoutes(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  if (path === '/api/v1/speak-as/callable-agents' && req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'agents.converse');
    if (!principal) return true;
    if (!state.speakAs || !state.speakAs.healthy) {
      json(res, 503, { error: 'speak_as_store_unavailable' });
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const speaker = url.searchParams.get('speaker') ?? url.searchParams.get('asUser');
    const clientActor = principal.actor.toLowerCase();
    const resolved = state.speakAs.resolveSpeaker(clientActor, speaker);
    if (!resolved.ok) {
      json(res, resolved.status, { error: resolved.error, message: resolved.message });
      return true;
    }
    // Verify against a representative agent if the member has an allowlist; otherwise list all.
    const grants = state.speakAs.list({ client: clientActor });
    const members = grants.flatMap((g) => g.members.filter((m) => m.principalId === resolved.principalId));
    if (members.length === 0) {
      json(res, 403, {
        error: 'person_not_enrolled',
        message: `'${resolved.principalId}' is not enrolled on a speak-as grant for client '${clientActor}'`,
      });
      return true;
    }
    const allow = new Set<string>();
    let allAgents = false;
    for (const m of members) {
      if (!m.targetAgents || m.targetAgents.length === 0) allAgents = true;
      else for (const id of m.targetAgents) allow.add(id);
    }
    const agents = [...state.agents.values()]
      .filter((a) => (a as { retiredAt?: string }).retiredAt == null)
      .filter((a) => allAgents || allow.has(a.id))
      .map((a) => agentDescription(state, a.id))
      .filter((x): x is { id: string; name: string; description: string } => Boolean(x))
      .sort((a, b) => a.id.localeCompare(b.id));
    json(res, 200, { speaker: resolved.principalId, client: clientActor, agents });
    return true;
  }

  if (path === '/api/v1/speak-as-grants' && req.method === 'GET') {
    const ctx = await requireAdmin(state, req, res);
    if (!ctx) return true;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const client = url.searchParams.get('client') ?? undefined;
    const includeRevoked = url.searchParams.get('includeRevoked') === '1' || url.searchParams.get('includeRevoked') === 'true';
    json(res, 200, { grants: ctx.store.list({ client, includeRevoked }).map(publicGrant) });
    return true;
  }

  if (path === '/api/v1/speak-as-grants' && req.method === 'POST') {
    const ctx = await requireAdmin(state, req, res);
    if (!ctx) return true;
    const body = await readJson(req);
    try {
      const grant = await ctx.store.create({
        client: String(body.client ?? ''),
        members: Array.isArray(body.members) ? body.members : body.principalId || body.user ? [body] : [],
        expiresAt: (body.expiresAt as string | null | undefined) ?? null,
        purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
        by: ctx.principal.actor,
      });
      ledger(state, 'SPEAK_AS_GRANT_CREATED', ctx.principal.actor, grant);
      json(res, 201, { grant: publicGrant(grant) });
    } catch (err) {
      storeError(res, err);
    }
    return true;
  }

  const one = path.match(ONE);
  if (one && req.method === 'GET') {
    const ctx = await requireAdmin(state, req, res);
    if (!ctx) return true;
    const grant = ctx.store.get(decodeURIComponent(one[1]));
    if (!grant) {
      json(res, 404, { error: 'grant_not_found' });
      return true;
    }
    json(res, 200, { grant: publicGrant(grant) });
    return true;
  }

  if (one && req.method === 'DELETE') {
    const ctx = await requireAdmin(state, req, res);
    if (!ctx) return true;
    try {
      const grant = await ctx.store.revoke(decodeURIComponent(one[1]), ctx.principal.actor);
      ledger(state, 'SPEAK_AS_GRANT_REVOKED', ctx.principal.actor, grant);
      json(res, 200, { grant: publicGrant(grant) });
    } catch (err) {
      storeError(res, err);
    }
    return true;
  }

  const members = path.match(MEMBERS);
  if (members && req.method === 'POST') {
    const ctx = await requireAdmin(state, req, res);
    if (!ctx) return true;
    const body = await readJson(req);
    try {
      const grant = await ctx.store.enroll(decodeURIComponent(members[1]), body, ctx.principal.actor);
      ledger(state, 'SPEAK_AS_MEMBER_ENROLLED', ctx.principal.actor, grant, { subject: (body as { principalId?: string }).principalId });
      json(res, 200, { grant: publicGrant(grant) });
    } catch (err) {
      storeError(res, err);
    }
    return true;
  }

  const member = path.match(MEMBER);
  if (member && req.method === 'DELETE') {
    const ctx = await requireAdmin(state, req, res);
    if (!ctx) return true;
    try {
      const principalId = decodeURIComponent(member[2]);
      const grant = await ctx.store.unenroll(decodeURIComponent(member[1]), principalId.startsWith('user:') ? principalId : `user:${principalId}`, ctx.principal.actor);
      ledger(state, 'SPEAK_AS_MEMBER_REMOVED', ctx.principal.actor, grant, { subject: principalId });
      json(res, 200, { grant: publicGrant(grant) });
    } catch (err) {
      storeError(res, err);
    }
    return true;
  }

  return false;
}


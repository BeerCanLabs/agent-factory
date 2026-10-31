/**
 * E5.2 (#302): an agent's Discord bot, set up as far as Discord allows.
 *
 *   GET  /api/v1/keymaster/agents/:agentId/discord-app        credentials.agent.read: steps (manual ones marked), status, invite
 *   POST /api/v1/keymaster/agents/:agentId/discord-app/token  credentials.agent.set: { value } bot token, write-only
 *
 * Discord has no API to create an application, so creating it, adding a bot and copying the token stay manual and are
 * listed as such. The factory checks a pasted token against Discord, stores it through the existing secret store under
 * the agent's declared Discord secretRef, and builds the invite link from the app id and the declared permissions.
 * The token is never returned, logged or ledgered.
 */
import http from 'node:http';
import { writableProvider } from '@beercanlabs/factory-secrets-bind';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { invalidateCredentials } from './credentials.js';

/** View channels (1024) + send messages (2048) + read message history (65536). */
export const DEFAULT_DISCORD_PERMISSIONS = '68608';
const PERMS = /^\d{1,20}$/;
const TOKEN = /^[A-Za-z0-9._-]{50,100}$/;

const apiBase = (s: FactoryState) => (s.discordApiBase ?? 'https://discord.com/api/v10').replace(/\/$/, '');

/** Where this agent's bot token and app id live: the declared Discord trigger's secretRef, else a per-agent default. */
export function discordSecretNames(state: FactoryState, agentId: string) {
  const agent = state.agents.get(agentId) as { triggers?: Array<{ type?: string; secretRef?: string }> } | undefined;
  const declared = agent?.triggers?.find((t) => t.type === 'discord')?.secretRef;
  const prefix = agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const token = declared && declared !== 'DISCORD_BOT_TOKEN' ? declared : `${prefix}_DISCORD_BOT_TOKEN`;
  return { token, appId: `${prefix}_DISCORD_APP_ID` };
}

function declaredPermissions(state: FactoryState, agentId: string): string {
  const p = (state.agents.get(agentId) as { discord?: { permissions?: unknown } } | undefined)?.discord?.permissions;
  return typeof p === 'string' && PERMS.test(p) ? p : typeof p === 'number' && Number.isSafeInteger(p) && p >= 0 ? String(p) : DEFAULT_DISCORD_PERMISSIONS;
}

export function inviteUrl(appId: string, permissions: string): string {
  const u = new URL('https://discord.com/oauth2/authorize');
  u.searchParams.set('client_id', appId);
  u.searchParams.set('scope', 'bot applications.commands');
  u.searchParams.set('permissions', permissions);
  return u.toString();
}

/** The steps, in order. `manual` ones Discord forces a person to do in its Developer Portal. */
export function discordSteps(state: FactoryState, agentId: string) {
  const names = discordSecretNames(state, agentId);
  return [
    { id: 'create-app', manual: true, text: 'Open https://discord.com/developers/applications and choose New Application. Name it after the agent.' },
    { id: 'add-bot', manual: true, text: 'Under Bot, reset the token and copy it. Turn on Message Content Intent if the agent reads messages.' },
    { id: 'paste-token', manual: false, text: `Paste the token here. The factory checks it with Discord and stores it as ${names.token}; it is never shown again.` },
    { id: 'invite', manual: false, text: 'Open the invite link the factory builds and pick the server. The bot joins with the declared permissions.' },
  ];
}

async function readSecret(state: FactoryState, name: string): Promise<string | undefined> {
  for (const p of state.providers) {
    const v = await p.get(name).catch(() => undefined);
    if (v) return v;
  }
  return undefined;
}

/** Handles the Discord setup routes. Returns false when the path is not one of them. */
export async function handleDiscordAppSetup(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const m = path.match(/^\/api\/v1\/keymaster\/agents\/([a-z0-9-]+)\/discord-app(\/token)?$/);
  if (!m) return false;
  const agentId = m[1];
  if (!m[2] && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'credentials.agent.read', { agentId }))) return true;
    if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' }), true;
    const appId = await readSecret(state, discordSecretNames(state, agentId).appId);
    const permissions = declaredPermissions(state, agentId);
    json(res, 200, { agentId, steps: discordSteps(state, agentId), configured: Boolean(appId), permissions, ...(appId ? { inviteUrl: inviteUrl(appId, permissions) } : {}) });
    return true;
  }
  if (m[2] && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'credentials.agent.set', { agentId });
    if (!principal) return true;
    if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' }), true;
    const writer = writableProvider(state.providers);
    if (!writer) return json(res, 503, { error: 'no_writable_secrets_backend' }), true;
    const b = await readJson(req);
    const token = typeof b.value === 'string' ? b.value.trim() : '';
    if (!TOKEN.test(token)) return json(res, 400, { error: 'token_invalid', message: 'paste the bot token from the Developer Portal\'s Bot page' }), true;
    state.secretValues.add(token);
    let app: { id?: unknown };
    try {
      const r = await fetch(`${apiBase(state)}/oauth2/applications/@me`, { headers: { authorization: `Bot ${token}` } });
      if (r.status === 401) return json(res, 400, { error: 'token_rejected', message: 'Discord did not accept this token' }), true;
      if (!r.ok) throw new Error(String(r.status));
      app = (await r.json()) as typeof app;
    } catch {
      return json(res, 502, { error: 'discord_unavailable' }), true;
    }
    if (typeof app.id !== 'string' || !/^\d{1,32}$/.test(app.id)) return json(res, 502, { error: 'discord_unavailable' }), true;
    const names = discordSecretNames(state, agentId);
    try {
      await writer.put(names.token, token);
      await writer.put(names.appId, app.id);
    } catch {
      console.error(`[keymaster] storing the Discord bot for ${agentId} failed`);
      return json(res, 502, { error: 'write_failed' }), true;
    }
    state.secretCache?.delete(names.token);
    state.secretCache?.delete(names.appId);
    invalidateCredentials(state);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'DISCORD_BOT_SET', actor: principal.actor, credential: names.token });
    const permissions = declaredPermissions(state, agentId);
    json(res, 201, { agentId, name: names.token, status: 'present', inviteUrl: inviteUrl(app.id, permissions), permissions });
    return true;
  }
  return false;
}

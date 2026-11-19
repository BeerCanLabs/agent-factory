import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  deliveredCaller,
  type DeliveredCaller,
  type SpeakAsMode,
  type SpeakAsVerifyErr,
} from '@beercanlabs/factory-bouncer';
import type { FactoryState } from './app.js';

export type VoiceConversation = {
  id: string;
  agentId: string;
  actor: string;
  via: string;
  grantId: string;
  channel: string;
  assurance: string;
  mode: SpeakAsMode;
  createdAt: number;
};

export type SpeakAsRequestFields = {
  speaker?: string;
  assurance: string;
  channel: string;
  mode: SpeakAsMode;
  conversationId?: string;
};

const ASSURANCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  return undefined;
}

export function parseSpeakAsFields(body: Record<string, unknown> | undefined, headers: IncomingHttpHeaders): SpeakAsRequestFields {
  const speakerRaw = (typeof body?.speaker === 'string' && body.speaker) || (typeof body?.asUser === 'string' && body.asUser) || header(headers, 'x-factory-speaker');
  const assuranceRaw = (typeof body?.assurance === 'string' && body.assurance) || header(headers, 'x-factory-assurance') || 'voice-asserted';
  const channelRaw = (typeof body?.channel === 'string' && body.channel) || header(headers, 'x-factory-channel') || 'voice';
  const modeRaw = ((typeof body?.mode === 'string' && body.mode) || header(headers, 'x-factory-mode') || 'call').toLowerCase();
  const conversationId = (typeof body?.conversationId === 'string' && body.conversationId) || header(headers, 'x-factory-conversation-id');
  const assurance = assuranceRaw.trim().toLowerCase();
  const channel = channelRaw.trim().toLowerCase();
  return {
    ...(speakerRaw ? { speaker: speakerRaw.trim() } : {}),
    assurance: ASSURANCE_RE.test(assurance) ? assurance : 'voice-asserted',
    channel: ASSURANCE_RE.test(channel) ? channel : 'voice',
    mode: modeRaw === 'errand' ? 'errand' : 'call',
    ...(conversationId ? { conversationId: conversationId.trim() } : {}),
  };
}

export function clientHasSpeakAsGrant(state: FactoryState, client: string): boolean {
  return Boolean(state.speakAs?.healthy && state.speakAs.list({ client: client.toLowerCase() }).length > 0);
}

export type SpeakAsApplyOk = { ok: true; delivered: DeliveredCaller; grantId: string; conversation: VoiceConversation };
export type SpeakAsApplyResult = SpeakAsApplyOk | (SpeakAsVerifyErr & { ok: false });

export function applySpeakAs(
  state: FactoryState,
  opts: { client: string; targetAgentId: string; fields: SpeakAsRequestFields },
): SpeakAsApplyResult {
  if (!state.speakAs || !state.speakAs.healthy) {
    return { ok: false, status: 503, error: 'speak_as_store_unavailable', message: 'speak-as grant store is unhealthy' };
  }
  const client = opts.client.toLowerCase();
  if (opts.fields.conversationId) {
    const existing = state.voiceConversations?.get(opts.fields.conversationId);
    if (!existing || existing.via !== client || existing.agentId !== opts.targetAgentId.toLowerCase()) {
      return { ok: false, status: 404, error: 'conversation_not_found', message: 'no open conversation with that id for this client and agent' };
    }
    if (opts.fields.speaker) {
      const resolved = state.speakAs.resolveSpeaker(client, opts.fields.speaker);
      if (!resolved.ok) return resolved;
      if (resolved.principalId !== existing.actor) {
        return { ok: false, status: 409, error: 'speaker_mismatch', message: 'speaker does not match the person this conversation was opened as' };
      }
    }
    if (opts.fields.mode !== existing.mode && opts.fields.mode === 'errand') {
      return { ok: false, status: 409, error: 'mode_mismatch', message: 'cannot switch a live call to an errand' };
    }
    const delivered = deliveredCaller({
      actor: existing.actor,
      via: existing.via,
      channel: existing.channel,
      assurance: existing.assurance,
      mode: existing.mode,
    });
    return { ok: true, delivered, grantId: existing.grantId, conversation: existing };
  }

  if (!opts.fields.speaker) {
    return { ok: false, status: 400, error: 'speaker_required', message: 'speaker is required to open a conversation as an enrolled person' };
  }
  const verified = state.speakAs.verifyRequest({
    client,
    speaker: opts.fields.speaker,
    targetAgentId: opts.targetAgentId,
  });
  if (!verified.ok) return verified;
  const delivered = deliveredCaller({
    actor: verified.actor,
    via: client,
    channel: opts.fields.channel,
    assurance: opts.fields.assurance,
    mode: opts.fields.mode,
  });
  const conversation: VoiceConversation = {
    id: 'convo_' + randomUUID(),
    agentId: opts.targetAgentId.toLowerCase(),
    actor: verified.actor,
    via: client,
    grantId: verified.grant.id,
    channel: opts.fields.channel,
    assurance: opts.fields.assurance,
    mode: opts.fields.mode,
    createdAt: Date.now(),
  };
  if (!state.voiceConversations) state.voiceConversations = new Map();
  state.voiceConversations.set(conversation.id, conversation);
  return { ok: true, delivered, grantId: verified.grant.id, conversation };
}

export function stampTurnPayload(
  payload: unknown,
  delivered: DeliveredCaller,
  turnId: string,
  conversationId: string,
  replyTo?: { channel: string; channelId?: string },
): Record<string, unknown> {
  const base: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : typeof payload === 'string'
        ? { text: payload }
        : {};
  delete base.caller;
  delete base.onBehalfOf;
  delete base.turnId;
  delete base.replyTo;
  delete base.conversationId;
  base.caller = { ...delivered };
  base.turnId = turnId;
  base.conversationId = conversationId;
  if (replyTo) base.replyTo = replyTo;
  return base;
}

export function parseSpeakAsFromRequest(req: IncomingMessage, body: Record<string, unknown> | undefined): SpeakAsRequestFields {
  return parseSpeakAsFields(body, req.headers);
}

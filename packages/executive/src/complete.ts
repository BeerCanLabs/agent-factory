import { ModelUpstreamError, parseChatRequest, type CatalogEntry, type ChatRequest, type ChatResult, type ModelAdapter, type ModelCatalog } from './models.js';

/**
 * The factory model API's serving of one call (DESIGN_AUTHORITY §6.9 M1, M3). The gatekeeper-egress runs its own
 * checks (the policy gate, the price, the throttle) between `findModel` and `complete`, and enforces what comes back.
 */

/** The catalog entry for a model the factory offers. Own names only, so "constructor" is never a model. */
export function findModel(catalog: ModelCatalog, model: string): CatalogEntry | undefined {
  return Object.hasOwn(catalog, model) ? catalog[model] : undefined;
}

export type Completion =
  | { ok: true; request: ChatRequest; result: ChatResult }
  /** Refused before any provider was called: the body is not a valid chat request, or no adapter serves the provider. */
  | { ok: false; kind: 'refused'; status: number; code: string; detail?: Record<string, unknown> }
  /** The provider was called and failed. The error's message carries no credentials (see `ModelUpstreamError`). */
  | { ok: false; kind: 'upstream'; error: ModelUpstreamError };

/** Validate the OpenAI-format body, find the provider's adapter and call it. Never throws. */
export async function complete(call: { entry: CatalogEntry; adapters: Record<string, ModelAdapter>; body: Record<string, unknown> }): Promise<Completion> {
  const chat = parseChatRequest(call.body);
  if (!chat.ok) return { ok: false, kind: 'refused', status: 400, code: chat.error };
  const adapter = Object.hasOwn(call.adapters, call.entry.provider) ? call.adapters[call.entry.provider] : undefined;
  if (!adapter) return { ok: false, kind: 'refused', status: 503, code: 'provider_unavailable', detail: { provider: call.entry.provider } };
  try {
    return { ok: true, request: chat.req, result: await adapter.complete(call.entry, chat.req) };
  } catch (err) {
    const error = err instanceof ModelUpstreamError ? err : new ModelUpstreamError(502, 'upstream_error', err instanceof Error ? err.message : String(err));
    return { ok: false, kind: 'upstream', error };
  }
}

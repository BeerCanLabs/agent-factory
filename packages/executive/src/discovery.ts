/**
 * Executive Model Discovery & Reference Pricing (§6.9 M1–M4, GAP-162).
 *
 * Discovers models live from third-party vendor endpoints (e.g. GET /v1/models)
 * and provides canonical reference pricing and naming conventions for standard flagship models.
 */

export interface DiscoveredModel {
  id: string;
  name?: string;
  ownedBy?: string;
  created?: number;
  description?: string;
}

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface ModelReference {
  friendlyName: string;
  price?: ModelPricing;
}

/** Standard published pricing per million tokens for flagship models (used for 1-click admission). */
export const REFERENCE_MODEL_PRICING: Record<string, { friendlyName: string; price: ModelPricing }> = {
  // OpenAI
  'gpt-4o': { friendlyName: 'gpt-4o', price: { inputPerMTok: 2.5, outputPerMTok: 10.0 } },
  'gpt-4o-2024-08-06': { friendlyName: 'gpt-4o', price: { inputPerMTok: 2.5, outputPerMTok: 10.0 } },
  'gpt-4o-2024-11-20': { friendlyName: 'gpt-4o', price: { inputPerMTok: 2.5, outputPerMTok: 10.0 } },
  'gpt-4o-mini': { friendlyName: 'gpt-4o-mini', price: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  'gpt-4o-mini-2024-07-18': { friendlyName: 'gpt-4o-mini', price: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  'o1': { friendlyName: 'o1', price: { inputPerMTok: 15.0, outputPerMTok: 60.0 } },
  'o1-2024-12-17': { friendlyName: 'o1', price: { inputPerMTok: 15.0, outputPerMTok: 60.0 } },
  'o1-mini': { friendlyName: 'o1-mini', price: { inputPerMTok: 3.0, outputPerMTok: 12.0 } },
  'o3-mini': { friendlyName: 'o3-mini', price: { inputPerMTok: 1.1, outputPerMTok: 4.4 } },

  // Anthropic
  'claude-3-5-sonnet-20241022': { friendlyName: 'claude-sonnet-3-5', price: { inputPerMTok: 3.0, outputPerMTok: 15.0 } },
  'claude-3-5-sonnet-latest': { friendlyName: 'claude-sonnet-3-5', price: { inputPerMTok: 3.0, outputPerMTok: 15.0 } },
  'claude-3-7-sonnet-20250219': { friendlyName: 'claude-sonnet-3-7', price: { inputPerMTok: 3.0, outputPerMTok: 15.0 } },
  'claude-3-5-haiku-20241022': { friendlyName: 'claude-haiku-3-5', price: { inputPerMTok: 0.8, outputPerMTok: 4.0 } },
  'claude-3-5-haiku-latest': { friendlyName: 'claude-haiku-3-5', price: { inputPerMTok: 0.8, outputPerMTok: 4.0 } },
  'claude-3-opus-20240229': { friendlyName: 'claude-opus-3', price: { inputPerMTok: 15.0, outputPerMTok: 75.0 } },

  // xAI
  'grok-2-1212': { friendlyName: 'grok-2', price: { inputPerMTok: 2.0, outputPerMTok: 10.0 } },
  'grok-2': { friendlyName: 'grok-2', price: { inputPerMTok: 2.0, outputPerMTok: 10.0 } },
  'grok-2-vision-1212': { friendlyName: 'grok-2-vision', price: { inputPerMTok: 2.0, outputPerMTok: 10.0 } },
  'grok-2-vision': { friendlyName: 'grok-2-vision', price: { inputPerMTok: 2.0, outputPerMTok: 10.0 } },
  'grok-beta': { friendlyName: 'grok-beta', price: { inputPerMTok: 5.0, outputPerMTok: 15.0 } },

  // Google Gemini
  'gemini-2.0-flash': { friendlyName: 'gemini-2.0-flash', price: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  'models/gemini-2.0-flash': { friendlyName: 'gemini-2.0-flash', price: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  'gemini-2.0-flash-exp': { friendlyName: 'gemini-2.0-flash', price: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  'gemini-1.5-pro': { friendlyName: 'gemini-1.5-pro', price: { inputPerMTok: 1.25, outputPerMTok: 5.0 } },
  'models/gemini-1.5-pro': { friendlyName: 'gemini-1.5-pro', price: { inputPerMTok: 1.25, outputPerMTok: 5.0 } },
  'gemini-1.5-flash': { friendlyName: 'gemini-1.5-flash', price: { inputPerMTok: 0.075, outputPerMTok: 0.3 } },
  'models/gemini-1.5-flash': { friendlyName: 'gemini-1.5-flash', price: { inputPerMTok: 0.075, outputPerMTok: 0.3 } },
};

/** Normalize a raw model id to look up reference pricing and assign a friendly default name. */
export function resolveModelReference(rawModelId: string): ModelReference {
  const cleanId = rawModelId.trim();
  const direct = REFERENCE_MODEL_PRICING[cleanId];
  if (direct) {
    return { friendlyName: direct.friendlyName, price: direct.price };
  }

  // Strip prefix like "models/" or dates like "-20241022" or "-2024-08-06"
  const stripped = cleanId.replace(/^models\//, '');
  const prefixMatch = Object.entries(REFERENCE_MODEL_PRICING).find(([k]) => {
    return stripped === k || stripped.startsWith(k + '-') || k.startsWith(stripped + '-');
  });

  if (prefixMatch) {
    return { friendlyName: prefixMatch[1].friendlyName, price: prefixMatch[1].price };
  }

  // Fallback: derive friendly name by kebab-casing without trailing date
  const friendlyName = stripped.replace(/-[0-9]{8}$/, '').replace(/-[0-9]{4}-[0-9]{2}-[0-9]{2}$/, '');
  return { friendlyName };
}

export interface VendorDiscoveryOptions {
  upstream: string;
  adapter: string;
  discoveryPath?: string;
  headers?: Record<string, string>;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

/**
 * Discovers models from a remote AI provider endpoint.
 * Parses standard OpenAI ({ data: [...] }), Anthropic ({ data: [...] }), and Google ({ models: [...] }) formats.
 */
export async function discoverVendorModels(opts: VendorDiscoveryOptions): Promise<DiscoveredModel[]> {
  const fetcher = opts.fetchFn ?? fetch;
  const basePath = (opts.discoveryPath || '/v1/models').replace(/^\//, '');
  const url = `${opts.upstream.replace(/\/$/, '')}/${basePath}`;

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(opts.headers ?? {}),
  };

  if (opts.apiKey) {
    if (opts.adapter === 'anthropicMessages') {
      headers['x-api-key'] = opts.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (opts.adapter === 'vertexGemini') {
      headers['x-goog-api-key'] = opts.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${opts.apiKey}`;
    }
  }

  const res = await fetcher(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Model discovery failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = (await res.json()) as Record<string, unknown>;
  const out: DiscoveredModel[] = [];

  // 1. OpenAI or Anthropic format: { data: [ { id: "...", ... } ] }
  if (Array.isArray(body.data)) {
    for (const item of body.data) {
      if (item && typeof item === 'object' && typeof (item as any).id === 'string') {
        const id = (item as any).id;
        out.push({
          id,
          name: typeof (item as any).display_name === 'string' ? (item as any).display_name : id,
          ownedBy: typeof (item as any).owned_by === 'string' ? (item as any).owned_by : undefined,
          created: typeof (item as any).created === 'number' ? (item as any).created : undefined,
        });
      }
    }
    return out;
  }

  // 2. Google Gemini format: { models: [ { name: "models/gemini-2.0-flash", displayName: "...", ... } ] }
  if (Array.isArray(body.models)) {
    for (const item of body.models) {
      if (item && typeof item === 'object') {
        const rawName = (item as any).name;
        if (typeof rawName === 'string') {
          out.push({
            id: rawName,
            name: typeof (item as any).displayName === 'string' ? (item as any).displayName : rawName,
            description: typeof (item as any).description === 'string' ? (item as any).description : undefined,
          });
        } else if (typeof (item as any).id === 'string') {
          out.push({
            id: (item as any).id,
            name: typeof (item as any).displayName === 'string' ? (item as any).displayName : (item as any).id,
          });
        }
      }
    }
    return out;
  }

  throw new Error('Unrecognized model discovery response format (expected data[] or models[])');
}
